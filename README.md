# OmniSearch Mail

Multi-account Gmail search tool with entity mappings, per-attachment COMBINED PDF/JSON generation, and ZIP export.

## What it does

Search across multiple Gmail accounts simultaneously, filter results by entity (supplier/customer), then download selected emails as a structured ZIP. Each attachment gets its own raw file plus a linked `_COMBINED.pdf` and `_COMBINED.json` containing the full email context and an attachment preview.

## ZIP structure

```
Entity_Name/
  YYYY-MM-DD_Subject_AttachmentName.pdf           ← raw attachment (original file)
  YYYY-MM-DD_Subject_AttachmentName_COMBINED.pdf  ← metadata + body + preview of this attachment
  YYYY-MM-DD_Subject_AttachmentName_COMBINED.json ← structured record linked to raw file
  YYYY-MM-DD_Subject_AnotherFile.xlsx             ← second attachment (raw)
  YYYY-MM-DD_Subject_AnotherFile_COMBINED.pdf
  YYYY-MM-DD_Subject_AnotherFile_COMBINED.json
```

Emails with no attachments produce a single `YYYY-MM-DD_Subject_COMBINED.pdf/.json` (metadata + body only).

## Tech stack

- **Frontend**: React + Vite + TailwindCSS v4 + shadcn/ui + wouter
- **Backend**: Express.js + TypeScript
- **Database**: PostgreSQL via Drizzle ORM
- **Gmail**: OAuth2 via `googleapis`
- **PDF**: `pdfkit` (metadata/body pages) + `pdf-lib` (PDF attachment first-page merge)
- **ZIP**: `archiver`

## Setup

1. Configure OAuth2 credentials per account (upload via Settings or set `GMAIL_CREDENTIALS_N` env vars)
2. Authorize each account via the in-app OAuth flow
3. Import entity mappings via Excel (columns: `canonical_name`, `KNOWN EMAIL`, `KNOWN_DOMAINS`)
4. Search, select results, click **Save ZIP**
