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

Each email is saved as a unified record in two formats, plus all attachments as separate files:

1. **Combined PDF** — Single multi-page PDF per email:
   - Page 1: Metadata (Subject, From, To, CC, Date, Entity) + attachment listing with preview indicators
   - Page 2+: Email body text on its own page
   - Additional pages: Image attachment previews (PNG, JPG, GIF embedded as pages)
   - Additional pages: PDF attachment previews (first page copied via pdf-lib with caption)
   - Non-embeddable attachments (.xlsx, .docx, .zip) listed on metadata page only

2. **JSON Record** — Structured data file per email:
   - All metadata fields (messageId, subject, from, to, cc, date, dateISO, entity)
   - Full body text
   - Attachment listing with filename, mimeType, size, previewInCombinedPdf flag

3. **Separate Attachments** — ALL attachments saved as individual files (regardless of type)

ZIP structure (flat, no subfolders per email):
```
Entity_Name/
  YYYY-MM-DD_Subject_Slug_combined.pdf    (metadata + body + attachment previews)
  YYYY-MM-DD_Subject_Slug_combined.json   (structured data record)
  YYYY-MM-DD_Attachment_Name.ext          (actual attachment files)
```

Smart filename logic: generic filenames (inline_1.pdf, attachment.pdf, etc.) are replaced with the email subject + original extension.

Dependencies: `pdfkit` (generates metadata+body pages), `pdf-lib` (merges PDF attachment previews), `archiver` (ZIP creation).

## Entity Mapping Excel Format

Expected columns: `canonical_name`, `KNOWN EMAIL` (comma-separated), `KNOWN_DOMAINS` (comma-separated)
Domains are auto-prefixed with `*@` on import; emails kept as-is.
