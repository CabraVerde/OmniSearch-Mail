import { google } from 'googleapis';

interface CredentialSet {
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
  email?: string;
}

function parseCredentials(envKey: string): { clientId: string; clientSecret: string } | null {
  // Check in-memory store first (populated by file upload)
  const match = envKey.match(/_(\d+)$/);
  if (match) {
    const stored = credentialStore[`creds_${match[1]}`];
    if (stored) return { clientId: stored.clientId, clientSecret: stored.clientSecret };
  }
  // Fall back to environment variable
  const raw = process.env[envKey];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const inner = parsed.installed || parsed.web || parsed;
    return { clientId: inner.client_id, clientSecret: inner.client_secret };
  } catch {
    return null;
  }
}

function getRedirectUri(accountIndex: number): string {
  // Check in-memory store first
  const stored = credentialStore[`creds_${accountIndex}`];
  if (stored) {
    const uri = stored.redirectUris.find(u => u !== 'urn:ietf:wg:oauth:2.0:oob');
    if (uri) return uri;
  }
  // Fall back to env var
  const raw = process.env[`GMAIL_CREDENTIALS_${accountIndex}`];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const inner = parsed.installed || parsed.web || parsed;
      const uris = inner.redirect_uris || [];
      for (const uri of uris) {
        if (uri !== 'urn:ietf:wg:oauth:2.0:oob') return uri;
      }
    } catch {}
  }
  return 'http://localhost';
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://mail.google.com/',
];

const tokenStore: Record<string, string> = {};

// In-memory credential store — populated by file upload, cleared on restart.
const credentialStore: Record<string, { clientId: string; clientSecret: string; redirectUris: string[] }> = {};

export function setInMemoryCredentials(
  accountIndex: number,
  clientId: string,
  clientSecret: string,
  redirectUris: string[]
) {
  credentialStore[`creds_${accountIndex}`] = { clientId, clientSecret, redirectUris };
}

export function getAccountCredentials(accountIndex: number): CredentialSet | null {
  const creds = parseCredentials(`GMAIL_CREDENTIALS_${accountIndex}`);
  if (!creds) return null;
  const refreshToken = process.env[`GMAIL_REFRESH_TOKEN_${accountIndex}`] || tokenStore[`token_${accountIndex}`];
  return {
    ...creds,
    refreshToken: refreshToken || undefined,
  };
}

export function getAuthUrl(accountIndex: number): string | null {
  const creds = parseCredentials(`GMAIL_CREDENTIALS_${accountIndex}`);
  if (!creds) return null;

  const redirectUri = getRedirectUri(accountIndex);
  const oauth2Client = new google.auth.OAuth2(creds.clientId, creds.clientSecret, redirectUri);
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: String(accountIndex),
  });
}

export async function handleAuthCallback(code: string, accountIndex: number): Promise<string> {
  const creds = parseCredentials(`GMAIL_CREDENTIALS_${accountIndex}`);
  if (!creds) throw new Error(`No credentials for account ${accountIndex}`);

  const redirectUri = getRedirectUri(accountIndex);
  const oauth2Client = new google.auth.OAuth2(creds.clientId, creds.clientSecret, redirectUri);
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error('No refresh token received. You may need to revoke access and re-authorize.');
  }

  tokenStore[`token_${accountIndex}`] = tokens.refresh_token;
  return tokens.refresh_token;
}

export function setRefreshToken(accountIndex: number, token: string) {
  tokenStore[`token_${accountIndex}`] = token;
}

export function hasRefreshToken(accountIndex: number): boolean {
  return !!(process.env[`GMAIL_REFRESH_TOKEN_${accountIndex}`] || tokenStore[`token_${accountIndex}`]);
}

function getGmailClient(accountIndex: number) {
  const creds = getAccountCredentials(accountIndex);
  if (!creds) throw new Error(`No credentials configured for account ${accountIndex}`);
  if (!creds.refreshToken) throw new Error(`Account ${accountIndex} not authorized yet. Please authorize first.`);

  const redirectUri = getRedirectUri(accountIndex);
  const oauth2Client = new google.auth.OAuth2(creds.clientId, creds.clientSecret, redirectUri);
  oauth2Client.setCredentials({ refresh_token: creds.refreshToken });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

export function buildGmailQuery(
  entityPatterns: string[],
  searchTerms: string,
  daysBack: number
): string {
  const parts: string[] = [];

  if (searchTerms.trim()) {
    parts.push(`(${searchTerms.trim()})`);
  }

  if (entityPatterns.length > 0) {
    const fromClauses = entityPatterns.map(p => {
      if (p.startsWith("*@")) {
        return `from:${p.substring(2)}`;
      }
      return `from:${p}`;
    });
    parts.push(`{${fromClauses.join(" ")}}`);
  }

  if (daysBack > 0) {
    const date = new Date();
    date.setDate(date.getDate() - daysBack);
    const formatted = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
    parts.push(`after:${formatted}`);
  }

  parts.push("has:attachment");

  return parts.join(" ");
}

export interface MessageResult {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  snippet: string;
  bodyText: string;
  bodyHtml: string;
  accountIndex: number;
  attachments: AttachmentInfo[];
}

export interface AttachmentInfo {
  id: string;
  messageId: string;
  filename: string;
  mimeType: string;
  size: number;
  isInline: boolean;
  accountIndex: number;
}

export async function searchMessages(
  query: string,
  maxResults: number,
  accountIndex: number
): Promise<MessageResult[]> {
  const gmail = getGmailClient(accountIndex);

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults,
  });

  const messageIds = listRes.data.messages || [];
  const results: MessageResult[] = [];

  for (const msg of messageIds) {
    try {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id!,
        format: 'full',
      });

      const headers = full.data.payload?.headers || [];
      const getHeader = (name: string) =>
        headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

      const attachments: AttachmentInfo[] = [];
      let bodyText = '';
      let bodyHtml = '';

      const extractParts = (parts: any[], parentIsRelated = false): void => {
        for (const part of parts) {
          if (part.parts) {
            const isRelated = part.mimeType === 'multipart/related';
            extractParts(part.parts, isRelated || parentIsRelated);
          }

          if (part.mimeType === 'text/plain' && part.body?.data && !bodyText) {
            bodyText = Buffer.from(part.body.data, 'base64url').toString('utf-8');
          }
          if (part.mimeType === 'text/html' && part.body?.data && !bodyHtml) {
            bodyHtml = Buffer.from(part.body.data, 'base64url').toString('utf-8');
          }

          if (part.body?.attachmentId) {
            const isInline = !!(part.headers?.find(
              (h: any) => h.name?.toLowerCase() === 'content-disposition' && h.value?.toLowerCase().includes('inline')
            )) || (!part.filename && parentIsRelated);

            attachments.push({
              id: part.body.attachmentId,
              messageId: msg.id!,
              filename: part.filename || `inline_${part.partId || 'unknown'}.${getExtFromMime(part.mimeType)}`,
              mimeType: part.mimeType || 'application/octet-stream',
              size: part.body.size || 0,
              isInline,
              accountIndex,
            });
          }
        }
      }

      if (full.data.payload?.parts) {
        extractParts(full.data.payload.parts);
      } else if (full.data.payload?.body?.data) {
        const mime = full.data.payload.mimeType || '';
        const decoded = Buffer.from(full.data.payload.body.data, 'base64url').toString('utf-8');
        if (mime === 'text/plain') bodyText = decoded;
        if (mime === 'text/html') bodyHtml = decoded;
      } else if (full.data.payload?.body?.attachmentId) {
        attachments.push({
          id: full.data.payload.body.attachmentId,
          messageId: msg.id!,
          filename: full.data.payload.filename || 'attachment',
          mimeType: full.data.payload.mimeType || 'application/octet-stream',
          size: full.data.payload.body.size || 0,
          isInline: false,
          accountIndex,
        });
      }

      results.push({
        id: msg.id!,
        threadId: msg.threadId!,
        subject: getHeader('Subject'),
        from: getHeader('From'),
        to: getHeader('To'),
        cc: getHeader('Cc'),
        date: getHeader('Date'),
        snippet: full.data.snippet || '',
        bodyText,
        bodyHtml,
        accountIndex,
        attachments,
      });
    } catch (err) {
      console.error(`Failed to fetch message ${msg.id}:`, err);
    }
  }

  return results;
}

export async function downloadAttachment(
  messageId: string,
  attachmentId: string,
  accountIndex: number
): Promise<Buffer> {
  const gmail = getGmailClient(accountIndex);
  const res = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });

  const data = res.data.data || '';
  return Buffer.from(data, 'base64url');
}

function getExtFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'text/plain': 'txt',
    'text/html': 'html',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  };
  return map[mimeType] || 'bin';
}

export async function getAccountEmail(accountIndex: number): Promise<string> {
  try {
    const gmail = getGmailClient(accountIndex);
    const profile = await gmail.users.getProfile({ userId: 'me' });
    return profile.data.emailAddress || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function getConfiguredAccountCount(): number {
  let count = 0;
  for (let i = 1; i <= 10; i++) {
    if (parseCredentials(`GMAIL_CREDENTIALS_${i}`)) count++;
    else break;
  }
  return count;
}
