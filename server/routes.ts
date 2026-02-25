import type { Express } from "express";
import { type Server } from "http";
import { storage } from "./storage";
import { insertEntitySchema, insertEmailMappingSchema } from "@shared/schema";
import {
  buildGmailQuery, searchMessages, downloadAttachment,
  getAccountEmail, getConfiguredAccountCount, getAccountCredentials,
  getAuthUrl, handleAuthCallback, hasRefreshToken, setRefreshToken,
  setInMemoryCredentials
} from "./gmail";
import { z } from "zod";
import * as XLSX from "xlsx";
import multer from "multer";
import archiver from "archiver";
import PDFDocument from "pdfkit";
import { PDFDocument as PDFLibDocument, rgb } from "pdf-lib";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // --- Gmail Account Discovery ---
  app.get("/api/accounts", async (_req, res) => {
    const count = getConfiguredAccountCount();
    const accounts = [];
    for (let i = 1; i <= count; i++) {
      const creds = getAccountCredentials(i);
      const authorized = hasRefreshToken(i);
      let email = 'Not authorized yet';
      if (authorized) {
        try {
          email = await getAccountEmail(i);
        } catch {
          email = 'Error fetching email';
        }
      }
      accounts.push({
        id: String(i),
        index: i,
        label: `Account ${i}`,
        email,
        authorized,
        hasCredentials: !!creds,
      });
    }
    res.json(accounts);
  });

  // --- Credential File Upload ---
  app.post("/api/credentials/upload", upload.single("file"), (req, res) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ error: "No file uploaded" });
      const accountIndex = parseInt(req.body.accountIndex);
      if (!accountIndex || accountIndex < 1 || accountIndex > 10) {
        return res.status(400).json({ error: "Invalid accountIndex" });
      }
      const json = JSON.parse(file.buffer.toString("utf-8"));
      const inner = json.installed || json.web || json;
      if (!inner.client_id || !inner.client_secret) {
        return res.status(400).json({ error: "Invalid credentials JSON — missing client_id or client_secret" });
      }
      setInMemoryCredentials(
        accountIndex,
        inner.client_id,
        inner.client_secret,
        inner.redirect_uris || []
      );
      res.json({ success: true, accountIndex });
    } catch (err: any) {
      res.status(400).json({ error: `Could not parse credentials file: ${err.message}` });
    }
  });

  // --- OAuth Authorization Flow ---
  app.get("/api/auth/authorize/:accountIndex", (req, res) => {
    const accountIndex = parseInt(req.params.accountIndex);
    const url = getAuthUrl(accountIndex);
    if (!url) {
      return res.status(400).json({ error: `No credentials configured for account ${accountIndex}` });
    }
    res.json({ url });
  });

  app.post("/api/auth/exchange-code", async (req, res) => {
    const { code, accountIndex } = req.body;
    if (!code || !accountIndex) {
      return res.status(400).json({ error: "Missing code or accountIndex" });
    }

    try {
      await handleAuthCallback(code, parseInt(accountIndex));
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/auth/status", (_req, res) => {
    const count = getConfiguredAccountCount();
    const statuses = [];
    for (let i = 1; i <= count; i++) {
      statuses.push({
        index: i,
        hasCredentials: !!getAccountCredentials(i),
        authorized: hasRefreshToken(i),
      });
    }
    res.json(statuses);
  });

  // --- Entities ---
  app.get("/api/entities", async (_req, res) => {
    const ents = await storage.getEntities();
    const mappings = await storage.getMappings();
    const result = ents.map(e => ({
      ...e,
      mappings: mappings.filter(m => m.entityId === e.id).map(m => m.pattern),
    }));
    res.json(result);
  });

  app.post("/api/entities", async (req, res) => {
    const parsed = insertEntitySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }
    const entity = await storage.createEntity(parsed.data);
    const patterns: string[] = req.body.patterns || [];
    for (const pattern of patterns) {
      await storage.createMapping({ entityId: entity.id, pattern });
    }
    const allMappings = await storage.getMappings(entity.id);
    res.json({ ...entity, mappings: allMappings.map(m => m.pattern) });
  });

  app.delete("/api/entities/:id", async (req, res) => {
    await storage.deleteEntity(req.params.id);
    res.json({ ok: true });
  });

  // --- Mappings ---
  app.post("/api/mappings", async (req, res) => {
    const parsed = insertEmailMappingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }
    const mapping = await storage.createMapping(parsed.data);
    res.json(mapping);
  });

  app.delete("/api/mappings/:id", async (req, res) => {
    await storage.deleteMapping(req.params.id);
    res.json({ ok: true });
  });

  // --- Excel Import ---
  app.post("/api/entities/import", upload.single("file"), async (req, res) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: "No file uploaded" });
      }
      const workbook = XLSX.read(file.buffer, { type: "buffer" });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows: any[] = XLSX.utils.sheet_to_json(sheet);

      const entityMap = new Map<string, string[]>();
      for (const row of rows) {
        const entityName = String(
          row["canonical_name"] || row["Entity"] || row["entity"] || row["Name"] || row["name"] || ""
        ).trim();
        if (!entityName) continue;

        if (!entityMap.has(entityName)) {
          entityMap.set(entityName, []);
        }

        const knownEmails = String(row["KNOWN EMAIL"] || row["Email"] || row["email"] || row["Pattern"] || row["pattern"] || "").trim();
        const knownDomains = String(row["KNOWN_DOMAINS"] || row["Domain"] || row["domain"] || row["Domains"] || "").trim();

        if (knownEmails) {
          for (const email of knownEmails.split(/[,;]+/).map(s => s.trim()).filter(Boolean)) {
            const existing = entityMap.get(entityName)!;
            if (!existing.includes(email)) existing.push(email);
          }
        }

        if (knownDomains) {
          for (const domain of knownDomains.split(/[,;]+/).map(s => s.trim()).filter(Boolean)) {
            const pattern = `*@${domain}`;
            const existing = entityMap.get(entityName)!;
            if (!existing.includes(pattern)) existing.push(pattern);
          }
        }
      }

      const importData = Array.from(entityMap.entries()).map(([name, patterns]) => ({
        name,
        patterns,
      }));

      await storage.bulkImportEntities(importData);
      res.json({ imported: importData.length, entities: importData.map(d => d.name) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Query Preview ---
  const querySchema = z.object({
    accountIds: z.array(z.string()),
    entityIds: z.array(z.string()),
    searchTerms: z.string(),
    daysBack: z.number().min(1).max(365),
    maxMessages: z.number().min(1).max(500),
    includeInline: z.boolean().optional().default(true),
  });

  app.post("/api/query/preview", async (req, res) => {
    const parsed = querySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }

    const { entityIds, searchTerms, daysBack } = parsed.data;

    const allMappings = await storage.getMappings();
    const patterns = allMappings
      .filter(m => entityIds.includes(m.entityId))
      .map(m => m.pattern);

    const query = buildGmailQuery(patterns, searchTerms, daysBack);
    res.json({ query });
  });

  // --- Search Execution (across multiple accounts) ---
  app.post("/api/query/run", async (req, res) => {
    const parsed = querySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }

    const { accountIds, entityIds, searchTerms, daysBack, maxMessages, includeInline } = parsed.data;

    const allMappings = await storage.getMappings();
    const patterns = allMappings
      .filter(m => entityIds.includes(m.entityId))
      .map(m => m.pattern);

    const query = buildGmailQuery(patterns, searchTerms, daysBack);

    try {
      const allResults: any[] = [];

      for (const accountId of accountIds) {
        const accountIndex = parseInt(accountId);
        if (!hasRefreshToken(accountIndex)) continue;

        try {
          let results = await searchMessages(query, maxMessages, accountIndex);

          if (!includeInline) {
            results = results.map(r => ({
              ...r,
              attachments: r.attachments.filter(a => !a.isInline),
            }));
          }

          allResults.push(...results);
        } catch (err: any) {
          console.error(`Search failed for account ${accountIndex}:`, err.message);
        }
      }

      const entitiesData = await storage.getEntities();
      const entityMap = new Map(entitiesData.map(e => [e.id, e.name]));

      const enrichedResults = allResults.map(r => {
        const fromAddress = r.from.match(/<([^>]+)>/)?.[1] || r.from;
        let matchedEntityId: string | null = null;
        let matchedEntityName: string | null = null;

        for (const mapping of allMappings) {
          if (entityIds.includes(mapping.entityId)) {
            const p = mapping.pattern;
            if (p.startsWith("*@")) {
              const domain = p.substring(2);
              if (fromAddress.endsWith(`@${domain}`) || fromAddress.endsWith(`.${domain}`)) {
                matchedEntityId = mapping.entityId;
                matchedEntityName = entityMap.get(mapping.entityId) || null;
                break;
              }
            } else if (fromAddress.toLowerCase() === p.toLowerCase()) {
              matchedEntityId = mapping.entityId;
              matchedEntityName = entityMap.get(mapping.entityId) || null;
              break;
            }
          }
        }

        return {
          ...r,
          matchedEntityId,
          matchedEntityName,
        };
      });

      enrichedResults.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      res.json({ query, results: enrichedResults, total: enrichedResults.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message, query });
    }
  });

  // --- Attachment Download ---
  app.get("/api/attachments/:accountIndex/:messageId/:attachmentId", async (req, res) => {
    try {
      const { accountIndex, messageId, attachmentId } = req.params;
      const filename = (req.query.filename as string || "attachment").replace(/[\r\n]/g, '');
      const buffer = await downloadAttachment(messageId, attachmentId, parseInt(accountIndex));
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Type", "application/octet-stream");
      res.send(buffer);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Bundle Download (ZIP with entity folders) ---
  const bundleSchema = z.object({
    items: z.array(z.object({
      messageId: z.string(),
      accountIndex: z.number(),
      subject: z.string(),
      from: z.string(),
      to: z.string().optional().default(''),
      cc: z.string().optional().default(''),
      date: z.string(),
      bodyText: z.string().optional().default(''),
      bodyHtml: z.string().optional().default(''),
      entityName: z.string().nullable(),
      attachments: z.array(z.object({
        id: z.string(),
        filename: z.string(),
        mimeType: z.string().optional().default(''),
        size: z.number().optional().default(0),
      })),
    })),
  });

  app.post("/api/download/bundle", async (req, res) => {
    const parsed = bundleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }

    const { items } = parsed.data;
    if (items.length === 0) {
      return res.status(400).json({ error: "No items to download" });
    }

    try {
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="OmniSearch_${new Date().toISOString().slice(0, 10)}.zip"`);

      const archive = archiver("zip", { zlib: { level: 5 } });
      archive.pipe(res);

      const fileCounters: Record<string, number> = {};

      for (const item of items) {
        const entityFolder = sanitizeFolderName(item.entityName || "Unknown");
        const datePrefix = formatDatePrefix(item.date);
        const subjectSlug = sanitizeFolderName(item.subject || "No_Subject").substring(0, 50);
        let baseFilename = `${datePrefix}_${subjectSlug}`;

        const fileKey = `${entityFolder}/${baseFilename}`;
        if (fileCounters[fileKey] !== undefined) {
          fileCounters[fileKey]++;
          baseFilename = `${baseFilename}_${fileCounters[fileKey]}`;
        } else {
          fileCounters[fileKey] = 0;
        }

        const downloadedAttachments: DownloadedAttachment[] = [];

        for (const att of item.attachments) {
          try {
            const buffer = await downloadAttachment(item.messageId, att.id, item.accountIndex);
            let attName = att.filename;
            if (isGenericFilename(attName) && item.subject) {
              const ext = attName.includes('.') ? '.' + attName.split('.').pop() : '';
              attName = sanitizeFolderName(item.subject).substring(0, 60) + ext;
            }
            const isImage = /^image\/(png|jpe?g|gif|bmp|webp)$/i.test(att.mimeType);
            const isPdf = /^application\/pdf$/i.test(att.mimeType);
            downloadedAttachments.push({
              filename: attName,
              mimeType: att.mimeType,
              size: buffer.length,
              buffer,
              isImage,
              isPdf,
            });
          } catch (err) {
            console.error(`Failed to download attachment ${att.id}:`, err);
          }
        }

        const combinedPdf = await generateCombinedPdf(item, downloadedAttachments);
        archive.append(combinedPdf, { name: `${entityFolder}/${baseFilename}_combined.pdf` });

        const jsonRecord = generateJsonRecord(item, downloadedAttachments);
        archive.append(JSON.stringify(jsonRecord, null, 2), { name: `${entityFolder}/${baseFilename}_combined.json` });

        for (const att of downloadedAttachments) {
          const attSlug = sanitizeFolderName(att.filename.replace(/\.[^.]+$/, '')).substring(0, 60);
          const attExt = att.filename.includes('.') ? '.' + att.filename.split('.').pop() : '';
          archive.append(att.buffer, { name: `${entityFolder}/${datePrefix}_${attSlug}${attExt}` });
        }
      }

      await archive.finalize();
    } catch (err: any) {
      console.error("Bundle generation failed:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  });

  return httpServer;
}

function isGenericFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  const nameOnly = lower.replace(/\.[^.]+$/, '');
  const genericPatterns = [
    /^inline_?\d*$/,
    /^attachment_?\d*$/,
    /^noname$/,
    /^att\d+$/,
    /^unnamed/,
    /^image\d*$/,
    /^file_?\d*$/,
  ];
  return genericPatterns.some(p => p.test(nameOnly));
}

function sanitizeFolderName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 80) || 'Unknown';
}

function formatDatePrefix(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  } catch {
    return 'unknown-date';
  }
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface DownloadedAttachment {
  filename: string;
  mimeType: string;
  size: number;
  buffer: Buffer;
  isImage: boolean;
  isPdf: boolean;
}

function generateBasePdf(
  item: {
    subject: string;
    from: string;
    to: string;
    cc: string;
    date: string;
    entityName: string | null;
    bodyText: string;
    bodyHtml: string;
  },
  attachments: DownloadedAttachment[]
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(16).font('Helvetica-Bold').text(item.subject || '(no subject)');
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#ccc');
    doc.moveDown(0.5);

    const fields = [
      ['From', item.from],
      ['To', item.to],
      ['CC', item.cc],
      ['Date', item.date],
      ['Entity', item.entityName || 'Unknown'],
    ];

    for (const [label, value] of fields) {
      if (value) {
        doc.fontSize(9).font('Helvetica-Bold').text(`${label}: `, { continued: true });
        doc.font('Helvetica').text(value);
        doc.moveDown(0.2);
      }
    }

    if (attachments.length > 0) {
      doc.moveDown(0.3);
      doc.fontSize(9).font('Helvetica-Bold').text('Attachments:');
      doc.moveDown(0.2);
      for (const att of attachments) {
        const badge = att.isImage ? '[image preview below]' : att.isPdf ? '[PDF preview below]' : '[separate file]';
        doc.fontSize(8).font('Helvetica').text(`  • ${att.filename} (${formatBytes(att.size)}) ${badge}`);
        doc.moveDown(0.1);
      }
    }

    doc.addPage();
    doc.fontSize(11).font('Helvetica-Bold').text('Message Body');
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#ccc');
    doc.moveDown(0.5);

    const bodyContent = item.bodyText || stripHtmlTags(item.bodyHtml) || '(empty body)';
    doc.fontSize(10).font('Helvetica').text(bodyContent, {
      width: 495,
      lineGap: 2,
    });

    const imageAttachments = attachments.filter(a => a.isImage);
    for (const img of imageAttachments) {
      try {
        doc.addPage();
        doc.fontSize(10).font('Helvetica-Bold').text(`Attachment Preview: ${img.filename}`, { align: 'center' });
        doc.moveDown(0.5);

        const maxWidth = 495;
        const maxHeight = 700;
        doc.image(img.buffer, {
          fit: [maxWidth, maxHeight],
          align: 'center',
          valign: 'center',
        });
      } catch (imgErr) {
        doc.fontSize(9).font('Helvetica').fillColor('#999')
          .text(`[Could not embed image: ${img.filename}]`);
        doc.fillColor('#000');
      }
    }

    doc.end();
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

async function generateCombinedPdf(
  item: {
    subject: string;
    from: string;
    to: string;
    cc: string;
    date: string;
    entityName: string | null;
    bodyText: string;
    bodyHtml: string;
  },
  attachments: DownloadedAttachment[]
): Promise<Buffer> {
  const baseBuffer = await generateBasePdf(item, attachments);

  const pdfAttachments = attachments.filter(a => a.isPdf);
  if (pdfAttachments.length === 0) {
    return baseBuffer;
  }

  try {
    const combinedDoc = await PDFLibDocument.load(baseBuffer);

    for (const att of pdfAttachments) {
      try {
        const srcDoc = await PDFLibDocument.load(att.buffer, { ignoreEncryption: true });
        const totalPages = srcDoc.getPageCount();
        const [firstPage] = await combinedDoc.copyPages(srcDoc, [0]);

        combinedDoc.addPage(firstPage);

        const lastPage = combinedDoc.getPage(combinedDoc.getPageCount() - 1);
        const { width } = lastPage.getSize();

        const captionText = `Preview: ${att.filename} (page 1 of ${totalPages})`;
        lastPage.drawRectangle({
          x: 0,
          y: 0,
          width: width,
          height: 20,
          color: rgb(0.95, 0.95, 0.95),
        });
        lastPage.drawText(captionText, {
          x: 10,
          y: 5,
          size: 8,
          color: rgb(0.4, 0.4, 0.4),
        });
      } catch (pdfErr) {
        console.error(`Failed to embed PDF preview for ${att.filename}:`, pdfErr);
      }
    }

    const finalBytes = await combinedDoc.save();
    return Buffer.from(finalBytes);
  } catch (err) {
    console.error('Failed to merge PDF attachments, returning base PDF:', err);
    return baseBuffer;
  }
}

function generateJsonRecord(
  item: {
    messageId: string;
    subject: string;
    from: string;
    to: string;
    cc: string;
    date: string;
    entityName: string | null;
    bodyText: string;
    bodyHtml: string;
  },
  attachments: DownloadedAttachment[]
) {
  let dateISO = '';
  try {
    dateISO = new Date(item.date).toISOString();
  } catch {}

  return {
    messageId: item.messageId,
    subject: item.subject,
    from: item.from,
    to: item.to,
    cc: item.cc,
    date: item.date,
    dateISO,
    entity: item.entityName || 'Unknown',
    bodyText: item.bodyText || stripHtmlTags(item.bodyHtml) || '',
    attachments: attachments.map(a => ({
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      previewInCombinedPdf: a.isImage || a.isPdf,
    })),
  };
}
