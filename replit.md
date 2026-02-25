# OmniSearch Mail

Multi-account Gmail search tool with entity-based filtering and smart attachment management.

## Architecture

- **Frontend**: React + Vite + TailwindCSS v4 + shadcn/ui, routed with `wouter`
- **Backend**: Express.js with TypeScript
- **Database**: PostgreSQL via Drizzle ORM
- **Gmail**: Direct OAuth2 via `googleapis` — each account has its own OAuth credentials stored as secrets
- **Excel Import**: `xlsx` package for parsing entity mapping spreadsheets
- **PDF Generation**: `pdfkit` for combined email PDFs (metadata + body + embedded images)
- **ZIP Bundling**: `archiver` for creating entity-organized ZIP downloads

## Gmail Authentication

Each account uses separate OAuth2 credentials:
- `GMAIL_CREDENTIALS_1` / `GMAIL_CREDENTIALS_2` — OAuth client JSON (installed app type, redirect_uri: http://localhost)
- `GMAIL_REFRESH_TOKEN_1` / `GMAIL_REFRESH_TOKEN_2` — Refresh tokens (obtained via in-app OAuth flow)
- Auth flow: user clicks Authorize → Google consent screen → redirect to localhost with code → user pastes URL back into app → code exchanged for refresh token
- Tokens cached in-memory during session via `tokenStore` in `server/gmail.ts`

## Database Schema

- `entities` — named entities (e.g. "Acme Corp")
- `email_mappings` — patterns mapped to entities (e.g. `*@acme.com`, `billing@acme.corp`)

## Key Files

- `server/gmail.ts` — Gmail API client, OAuth2 auth flow, query builder, message search (with body extraction), attachment download
- `server/routes.ts` — All API routes including bundle ZIP download, combined PDF generation, JSON record generation
- `server/storage.ts` — Database storage layer using Drizzle
- `shared/schema.ts` — Drizzle schema definitions
- `client/src/pages/Home.tsx` — Main dashboard UI with message-level selection
- `client/src/lib/api.ts` — Frontend API helper

## API Routes

- `GET /api/accounts` — List configured Gmail accounts with auth status
- `GET /api/auth/authorize/:accountIndex` — Get OAuth URL for account authorization
- `POST /api/auth/exchange-code` — Exchange auth code for refresh token
- `GET /api/auth/status` — Check authorization status for all accounts
- `GET /api/entities` — List entities with mappings
- `POST /api/entities` — Create entity with patterns
- `DELETE /api/entities/:id` — Delete entity
- `POST /api/entities/import` — Import from Excel (columns: canonical_name, KNOWN EMAIL, KNOWN_DOMAINS)
- `POST /api/query/preview` — Generate Gmail query string
- `POST /api/query/run` — Execute search across selected accounts, return enriched results (includes bodyText, bodyHtml, to, cc)
- `GET /api/attachments/:accountIndex/:messageId/:attachmentId` — Download single attachment
- `POST /api/download/bundle` — Generate ZIP with combined PDFs + JSON records per email

## Download System

Each selected email produces one COMBINED pair **per attachment**, plus the raw attachment file:

1. **Raw attachment** — saved as `YYYY-MM-DD_SubjectSlug_AttachmentSlug.ext`
   - Generic filenames (`inline_1.pdf`, `attachment.pdf`, etc.) are replaced with subject + extension
   - Subject slug capped at 30 chars, attachment slug capped at 30 chars

2. **COMBINED PDF** — `YYYY-MM-DD_SubjectSlug_AttachmentSlug_COMBINED.pdf`:
   - Page 1: Metadata (Subject, From, To, CC, Date, Entity) + full attachment listing; the attachment for this COMBINED file is marked `→ [this file]`, others show `[separate file]`
   - Page 2+: Full email body text
   - Additional page: Image preview (PNG/JPG/GIF/BMP/WEBP embedded full-page) if this attachment is an image
   - Additional page: First page of PDF attachment copied via `pdf-lib` with caption bar if this attachment is a PDF
   - Non-previewable types (.xlsx, .docx, .zip) — no preview page appended

3. **COMBINED JSON** — `YYYY-MM-DD_SubjectSlug_AttachmentSlug_COMBINED.json`:
   - All metadata fields: `messageId`, `subject`, `from`, `to`, `cc`, `date`, `dateISO`, `entity`
   - `linkedAttachmentFile` — filename of the raw attachment this record corresponds to
   - `bodyText` — full plain-text body (stripped from HTML if needed)
   - `attachments` array — all attachments on the email with `filename`, `mimeType`, `size`, `previewInCombinedPdf`

Emails with **no attachments** produce a single `YYYY-MM-DD_SubjectSlug_COMBINED.pdf/.json` (metadata + body only).

Duplicate filenames within the same entity folder get a `_2`, `_3` counter suffix on all three files to keep the triplet in sync.

ZIP structure:
```
Entity_Name/
  YYYY-MM-DD_Subject_Invoice.pdf
  YYYY-MM-DD_Subject_Invoice_COMBINED.pdf
  YYYY-MM-DD_Subject_Invoice_COMBINED.json
  YYYY-MM-DD_Subject_CreditNote.pdf
  YYYY-MM-DD_Subject_CreditNote_COMBINED.pdf
  YYYY-MM-DD_Subject_CreditNote_COMBINED.json
```

Dependencies: `pdfkit` (metadata + body pages + image embed), `pdf-lib` (PDF first-page copy), `archiver` (ZIP creation).

## Entity Mapping Excel Format

Expected columns: `canonical_name`, `KNOWN EMAIL` (comma-separated), `KNOWN_DOMAINS` (comma-separated)
Domains are auto-prefixed with `*@` on import; emails kept as-is.
