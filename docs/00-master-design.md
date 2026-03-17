# 00 — Master Design Document

**Project:** `file-accessibility-audit`
**Version:** 1.7
**Stack:** Nuxt 4.31+ / Nuxt UI 4+ / Node.js / Express / QPDF / pdfjs-dist
**Package Manager:** pnpm
**Deployment:** DigitalOcean droplet → Laravel Forge → PM2 → nginx reverse proxy
**Auth:** Illinois.gov email restriction (magic link / OTP via email)
**Mode:** Dark mode only
**Production URL:** https://audit.icjia.app
**Config:** All configurable constants live in `audit.config.ts` at the project root

---

## 1. Project Overview

A private, internal web tool for ICJIA staff that allows users to drop a PDF file and receive an immediate, scored accessibility readiness report. The report is diagnostic only — it identifies issues but does not remediate them. The intended audience is agency staff who produce PDFs and need a clear, actionable signal to return to Adobe Acrobat for remediation before publishing.

### Core Principles

- **No file retention** — PDFs are processed in memory and immediately discarded
- **Illinois.gov only** — Auth layer enforces agency email domain
- **Score-first UX** — The grade is the hero of the UI, large and unambiguous
- **Audit logging** — Login events and filenames are logged; file content is never stored

---

## 2. Monorepo Structure

```
file-accessibility-audit/
├── apps/
│   ├── web/                  # Nuxt 4 frontend
│   │   ├── app/
│   │   │   ├── pages/
│   │   │   │   ├── index.vue          # Drop zone / main UI
│   │   │   │   ├── login.vue          # Auth page
│   │   │   │   ├── my-history.vue     # User's own analysis history
│   │   │   │   ├── history.vue        # Audit log viewer (admin)
│   │   │   │   └── report/
│   │   │   │       └── [id].vue       # Shared report view (Phase 2, public)
│   │   │   ├── components/
│   │   │   │   ├── DropZone.vue
│   │   │   │   ├── ScoreCard.vue
│   │   │   │   ├── CategoryRow.vue
│   │   │   │   └── ProcessingOverlay.vue
│   │   │   ├── middleware/
│   │   │   │   └── auth.ts
│   │   │   └── app.vue
│   │   ├── nuxt.config.ts
│   │   ├── package.json
│   │   └── .env
│   └── api/                  # Express API server
│       ├── src/
│       │   ├── index.ts              # Express entry point
│       │   ├── routes/
│       │   │   ├── analyze.ts        # POST /api/analyze
│       │   │   ├── auth.ts           # POST /api/auth/request, /api/auth/verify
│       │   │   ├── logs.ts           # GET /api/logs, GET /api/my-history
│       │   │   └── reports.ts        # POST /api/reports, GET /api/reports/:id (Phase 2)
│       │   ├── services/
│       │   │   ├── pdfAnalyzer.ts    # Orchestrates QPDF + pdfjs-dist
│       │   │   ├── qpdfService.ts    # Wraps QPDF CLI via child_process
│       │   │   ├── pdfjsService.ts   # pdfjs-dist text/metadata extraction
│       │   │   └── scorer.ts         # Scoring logic → letter grade
│       │   ├── middleware/
│       │   │   ├── authMiddleware.ts  # JWT validation
│       │   │   ├── rateLimiter.ts     # express-rate-limit configs
│       │   │   └── uploadMiddleware.ts # multer, memory storage, 100MB limit
│       │   ├── db/
│       │   │   └── sqlite.ts         # better-sqlite3, audit log only
│       │   └── mailer.ts             # Nodemailer OTP sender
│       ├── package.json
│       └── .env
├── tests/
│   └── fixtures/             # Known test PDFs + .expected.json files
├── audit.config.ts           # Single source of truth for all constants
├── ecosystem.config.cjs      # PM2 config (root level)
├── package.json              # pnpm workspace root
├── pnpm-workspace.yaml
├── .nvmrc                    # Node.js version (20)
├── .gitignore
└── README.md
```

---

## 3. Authentication

### Approach: Email OTP (Magic Code)

No passwords. User enters their `@illinois.gov` email, receives a 6-digit OTP via email, enters it, receives a JWT stored in an httpOnly cookie. Simple, stateless after verification, no OAuth complexity. All auth constants (OTP length, expiry, attempt limits, JWT duration, domain regex) are configured in `audit.config.ts → AUTH`.

### Why Not OAuth/Google?

Illinois state accounts are sometimes Microsoft-based but not reliably configured for OAuth. Email OTP works universally with any `@illinois.gov` address.

### Auth Flow

```
1. User visits app → redirected to /login
2. User enters email → validated against /@.*\.illinois\.gov$/ regex
3. API generates 6-digit OTP, stores hash + expiry in SQLite (15 min TTL)
4. API sends OTP via Nodemailer (SMTP2GO SMTP relay)
5. User enters OTP → API verifies → issues signed JWT (72hr expiry)
6. JWT stored in httpOnly, Secure, SameSite=Strict cookie
7. Middleware checks JWT on every request
8. Login event written to audit log (email, timestamp, IP)
```

### OTP Attempt Limiting

Each OTP allows a maximum of 5 verification attempts. After 5 failed attempts, the OTP is invalidated and the user must request a new one. The `otp_codes` table tracks `attempts` per OTP row. This prevents brute-forcing a 6-digit code (1,000,000 combinations).

### Domain Restriction Note

The email domain check proves the user can *receive* email at an `@illinois.gov` address. This is a "soft" restriction — it does not verify employment status. For this internal diagnostic tool, proving email receipt is the appropriate security property.

### JWT Payload

```json
{
  "email": "user@agency.illinois.gov",
  "iat": 1234567890,
  "exp": 1234654290
}
```

### Email Domains Allowed

```
*.illinois.gov
```

Regex: `/^[^@]+@([a-z0-9-]+\.)*illinois\.gov$/i`

---

## 4. PDF Analysis Engine

### Tool Stack

| Tool | Role | License |
|------|------|---------|
| **QPDF** | Structure tree, tag inspection, PDF object dump | Apache 2.0 |
| **pdfjs-dist** | Text extraction, metadata, font info, page count | Apache 2.0 |
| **multer** | File upload handling, memory storage (no permanent disk storage) | MIT |
| **better-sqlite3** | Audit log storage | MIT |

### Analysis Pipeline

```
POST /api/analyze (multipart/form-data, PDF binary)
  │
  ├─→ multer: buffer to memory (no permanent disk storage)
  │
  │   Note: pdfjs-dist processes the buffer in memory. QPDF requires a
  │   file path, so the buffer is written to a temporary file
  │   (/tmp/<uuid>.pdf) which is deleted immediately after processing
  │   in a `finally` block. No uploaded file is permanently stored.
  │
  ├─→ pdfjsService:
  │     - Extract text content (all pages)
  │     - Page count
  │     - Metadata (Title, Author, Subject, Language)
  │     - Font names/types
  │     - Detect if text-extractable vs image-only
  │     - Outline/bookmarks presence
  │     - URL strings in content
  │
  ├─→ qpdfService:
  │     - Write buffer to /tmp/<uuid>.pdf (temp, deleted immediately after)
  │     - Run: qpdf --json --json-key=objects <file>
  │     - Parse JSON output for:
  │         /StructTreeRoot presence (tagged PDF)
  │         /Lang entry (language declaration)
  │         /Outlines (bookmarks)
  │         /AcroForm (form fields)
  │         Image XObjects (figures)
  │         Table structures (/Table, /TH, /TD tags)
  │         Heading tags (/H, /H1–/H6)
  │         /Alt entries on figures
  │     - Delete temp file (always, even on error)
  │
  └─→ scorer:
        - Run scoring logic across all extracted data
        - Return structured JSON report
```

### QPDF Temp File Handling

```typescript
const tmpPath = `/tmp/${randomUUID()}.pdf`
try {
  fs.writeFileSync(tmpPath, buffer)
  const result = execFileSync('qpdf', ['--json', '--json-key=objects', tmpPath], {
    timeout: ANALYSIS.QPDF_TIMEOUT_MS,
    maxBuffer: ANALYSIS.QPDF_MAX_BUFFER,
  })
  // parse result...
} finally {
  try { fs.unlinkSync(tmpPath) } catch {} // always attempt deletion
}
```

> **Why `execFileSync` instead of `execSync`?** `execFileSync` bypasses the shell entirely — arguments are passed directly to the QPDF binary as an argv array. `execSync` runs through `/bin/sh`, which means shell metacharacters in the file path could be interpreted. While UUID-generated paths don't contain metacharacters, using `execFileSync` is defense-in-depth. This is a hard requirement — never use `execSync` for QPDF.

---

## 5. Scoring Model

> **Implementation note:** All scoring weights, grade thresholds, severity thresholds, and analysis limits referenced in this section are defined in `audit.config.ts` at the project root. That file is the single source of truth — the scorer imports it directly. When changing a value, change it in `audit.config.ts`, not inline in service code.

### Categories & Weights

| # | Category | Weight | What's Checked |
|---|----------|--------|----------------|
| 1 | **Text Extractability** | 20% | Is PDF text-based or image/scanned? Is StructTreeRoot present? |
| 2 | **Document Title & Language** | 15% | Title metadata set and non-empty? `/Lang` declared? |
| 3 | **Heading Structure** | 15% | H1-H6 tags present in structure tree? Logical hierarchy? |
| 4 | **Alt Text on Images** | 15% | Image XObjects present? Do they have `/Alt` entries? |
| 5 | **Bookmarks / Navigation** | 10% | `/Outlines` present for docs > 9 pages? |
| 6 | **Table Markup** | 10% | Tables present? TH/TD tags used? |
| 7 | **Link & URL Quality** | 5% | Raw URLs vs. descriptive link text? |
| 8 | **Form Accessibility** | 5% | AcroForm fields present? Do they have `/TU` (tooltip/label)? |
| 9 | **Reading Order** | 5% | Does the structure tree define a logical reading sequence? Checks for: content items properly ordered within the StructTree (not just presence), absence of out-of-order artifacts, and whether the tag tree depth reflects meaningful document structure beyond a flat list. |

### Scoring Rubric per Category

Each category produces a 0–100 score based on specific, deterministic rules. The scorer does not use AI or heuristics — every check is binary (present/absent) or ratio-based (percentage of items with the required property).

---

#### 1. Text Extractability (20%)

| Condition | Score |
|-----------|-------|
| pdfjs-dist extracts text AND StructTreeRoot present | 100 |
| pdfjs-dist extracts text but NO StructTreeRoot | 50 |
| No extractable text but StructTreeRoot present | 25 |
| No extractable text AND no StructTreeRoot (scanned) | 0 |

**Severity mapping:** 100 = Pass, 50 = Moderate, 25 = Critical, 0 = Critical (with scanned PDF warning banner).

**Data sources:** pdfjs-dist `page.getTextContent()` returns empty for scanned PDFs. QPDF JSON output contains `/StructTreeRoot` in the document catalog if the PDF is tagged.

---

#### 2. Document Title & Language (15%)

This category has two sub-checks, each worth 50 points:

| Sub-check | Present | Absent |
|-----------|---------|--------|
| Document title in metadata (non-empty, not a filename) | +50 | +0 |
| `/Lang` entry in document catalog | +50 | +0 |

**Score = sum of sub-checks.** Examples: both present = 100, only title = 50, neither = 0.

**Title validation:** a title that matches common filename patterns (e.g., ends in `.pdf`, `.docx`, or is all-lowercase with underscores/hyphens like `annual_report_2024`) is treated as absent. Users sometimes set the title to the filename, which provides no accessibility value.

**Data sources:** pdfjs-dist `doc.getMetadata()` returns title and language. QPDF JSON confirms `/Lang` in the catalog object.

---

#### 3. Heading Structure (15%)

| Condition | Score |
|-----------|-------|
| H1–H6 tags present in StructTree with logical hierarchy (no skipped levels) | 100 |
| H1–H6 tags present but hierarchy is broken (e.g., H1 → H3, skipping H2) | 60 |
| Only generic /H tags (not H1–H6) | 40 |
| No heading tags in StructTree | 0 |

**"Logical hierarchy"** means: the document starts with H1 (or H2 for docs that use H1 as the document title), and subsequent headings don't skip levels downward (H2 → H4 without H3 is a skip; H3 → H2 going back up is fine).

**Data sources:** QPDF JSON structure tree objects. Walk the `/K` (kids) arrays looking for `/S` values of `/H`, `/H1` through `/H6`.

---

#### 4. Alt Text on Images (15%)

| Condition | Score |
|-----------|-------|
| No images in document | N/A (excluded from weighted average) |
| All images have non-empty `/Alt` entries | 100 |
| Some images have `/Alt` entries | `(count with alt / total images) * 100`, rounded |
| No images have `/Alt` entries | 0 |

**Image detection:** QPDF JSON lists Image XObjects (objects with `/Subtype /Image`). These are cross-referenced with the structure tree — an image XObject referenced from a `/Figure` tag should have an `/Alt` sibling key.

**Edge case:** decorative images that are intentionally marked as artifacts (outside the structure tree) are excluded from the count. Only images referenced within the structure tree as `/Figure` elements are assessed.

---

#### 5. Bookmarks / Navigation (10%)

| Condition | Score |
|-----------|-------|
| Document has 9 or fewer pages | N/A (excluded from weighted average) |
| 10+ pages AND `/Outlines` present with entries | 100 |
| 10+ pages AND `/Outlines` key present but empty (0 entries) | 25 |
| 10+ pages AND no `/Outlines` key | 0 |

**Rationale:** Short documents don't need bookmarks — they're navigable by scrolling. The 9-page threshold is deliberately conservative. WCAG 2.1 SC 2.4.5 ("Multiple Ways") applies to longer documents.

**Data sources:** QPDF JSON document catalog for `/Outlines` key. Count outline entries by walking the `/First` → `/Next` linked list.

---

#### 6. Table Markup (10%)

| Condition | Score |
|-----------|-------|
| No tables detected in document | N/A (excluded from weighted average) |
| Tables present with `/Table`, `/TH`, and `/TD` tags | 100 |
| Tables present with `/Table` and `/TD` but no `/TH` (no headers) | 40 |
| Tables present (detected by layout analysis) but no table tags at all | 0 |

**Table detection:** QPDF structure tree is the primary source — look for `/Table` tag types. If no `/Table` tags exist, pdfjs-dist text extraction is used as a secondary heuristic: look for tab-separated columns of aligned text across multiple lines. This heuristic is imperfect and may miss some tables or flag non-table content; when in doubt, the category scores as N/A rather than penalizing.

**Data sources:** QPDF JSON structure tree for `/Table`, `/TH`, `/TD`, `/TR` tag types.

---

#### 7. Link & URL Quality (5%)

| Condition | Score |
|-----------|-------|
| No links/URLs in document | N/A (excluded from weighted average) |
| All links use descriptive text (no raw URLs as display text) | 100 |
| Some links are raw URLs | `(descriptive links / total links) * 100`, rounded |
| All links are raw URLs | 0 |

**"Raw URL"** means the visible text content of a link annotation is itself a URL (starts with `http://`, `https://`, or `www.`). Descriptive text is anything else (e.g., "Read the full report" linking to a URL).

**Detection:** pdfjs-dist extracts link annotations with their associated text content. Compare the display text against URL patterns.

---

#### 8. Form Accessibility (5%)

| Condition | Score |
|-----------|-------|
| No AcroForm fields in document | N/A (excluded from weighted average) |
| All form fields have `/TU` (tooltip/accessible label) | 100 |
| Some fields have `/TU` | `(fields with TU / total fields) * 100`, rounded |
| Fields present but none have `/TU` | 0 |

**Data sources:** QPDF JSON — `/AcroForm` → `/Fields` array. Each field object is checked for the `/TU` key (tooltip text that screen readers use as the field label).

---

#### 9. Reading Order (5%)

| Condition | Score |
|-----------|-------|
| No StructTree present | 0 |
| StructTree present but flat (all content items are direct children of root, no nesting) | 30 |
| StructTree present with nesting but content order doesn't match visual page order | 50 |
| StructTree present with meaningful hierarchy and content order matches page sequence | 100 |

**"Content order matches page sequence"** is assessed by comparing the order of marked-content IDs (MCIDs) in the structure tree against their order in the page content streams. If MCIDs appear in the same sequence as the page content, reading order is considered correct. Significant deviations (>20% of content items out of order) reduce the score.

**Distinction from Text Extractability:** Category 1 checks *whether* the StructTree exists (binary). Category 9 checks the *quality* of the reading order defined within it. A PDF can have a StructTreeRoot (scoring well on #1) but have a flat or disordered structure tree (scoring poorly on #9).

**Data sources:** QPDF JSON structure tree — walk the `/K` arrays to assess tree depth and MCID ordering. Cross-reference with page content stream MCID sequences.

---

### N/A Category Handling

When a category scores as **N/A** (the check doesn't apply — e.g., no images, no tables, no forms, short document):

1. The category is **excluded from the weighted average entirely**
2. Its weight is **redistributed proportionally** across the remaining applicable categories
3. The report displays the category as "N/A — not applicable" with an explanation (e.g., "No images found in this document")

**Example:** A 5-page text-only PDF with no images, tables, forms, or links. Categories 4, 5, 6, 7, 8 are all N/A. Only categories 1 (20%), 2 (15%), 3 (15%), and 9 (5%) apply — their weights sum to 55%. Each is renormalized: 1 becomes 36.4%, 2 becomes 27.3%, 3 becomes 27.3%, 9 becomes 9.1%. The overall score is computed from these adjusted weights.

```typescript
// Weight renormalization pseudocode
const applicable = categories.filter(c => c.score !== null) // exclude N/A
const totalWeight = applicable.reduce((sum, c) => sum + c.weight, 0)
const overallScore = applicable.reduce((sum, c) => {
  return sum + (c.score * (c.weight / totalWeight))
}, 0)
```

---

### Score Calculation

Each category produces a 0–100 score per the rubric above. The overall score is a weighted average (with N/A renormalization). Letter grades:

| Score | Grade | Color |
|-------|-------|-------|
| 90–100 | A | Green `#22c55e` |
| 80–89 | B | Teal `#14b8a6` |
| 70–79 | C | Yellow `#eab308` |
| 60–69 | D | Orange `#f97316` |
| 0–59 | F | Red `#ef4444` |

### Severity Labels per Category

- **Pass** — No issues detected
- **Minor** — Issues present but low impact
- **Moderate** — Affects some users' ability to access content
- **Critical** — Significant barrier; remediation required before publishing

### Special Case: Scanned/Image-Only PDF

If pdfjs-dist returns zero extractable text AND QPDF shows no StructTreeRoot:

- **Automatic F** on Text Extractability (full weight penalty)
- **Warning banner** displayed above score: *"This PDF appears to be a scanned image. Screen readers cannot access its content. OCR and full remediation are required."*
- Other categories scored as N/A or 0 where they cannot be assessed

---

## 6. API Endpoints

### `POST /api/analyze`

**Auth:** Required (JWT cookie)
**Body:** `multipart/form-data`, field `file` (PDF, max 100MB)
**Response:**

```json
{
  "filename": "annual-report-2024.pdf",
  "pageCount": 24,
  "overallScore": 47,
  "grade": "F",
  "isScanned": false,
  "executiveSummary": "This PDF has significant accessibility barriers...",
  "categories": [
    {
      "id": "text_extractability",
      "label": "Text Extractability",
      "score": 100,
      "grade": "A",
      "severity": "Pass",
      "findings": ["PDF contains extractable text", "Document is tagged (StructTreeRoot present)"]
    },
    {
      "id": "title_language",
      "label": "Title & Language",
      "score": 25,
      "grade": "F",
      "severity": "Critical",
      "findings": ["No document title found in metadata", "No language declaration (/Lang) present"]
    }
  ]
}
```

### `POST /api/auth/request`

**Auth:** None
**Body:** `{ "email": "user@agency.illinois.gov" }`
**Response:** `{ "message": "OTP sent" }` or `{ "error": "Invalid email domain" }`

### `POST /api/auth/verify`

**Auth:** None
**Body:** `{ "email": "user@agency.illinois.gov", "otp": "847291" }`
**Response:** Sets httpOnly JWT cookie, returns `{ "ok": true }`

### `POST /api/auth/logout`

**Auth:** Required
**Response:** Clears cookie

### `GET /api/logs`

**Auth:** Required
**Query:** `?page=1&limit=50`
**Response:** Paginated audit log entries (admin use)

### `POST /api/reports` (Phase 2)

**Auth:** Required (JWT cookie)
**Body:** `{ "reportData": { ... full analysis response ... } }`
**Response:**

```json
{
  "id": "<uuid>",
  "shareUrl": "/report/<uuid>",
  "expiresAt": "2026-06-05T..."
}
```

**Purpose:** Stores a report in SQLite for sharing. Reports expire after `SHARED_REPORTS.EXPIRY_DAYS` days (default 30).

### `GET /api/reports/:id`

**Auth:** None (public)
**Response:** The stored report JSON, or 404 if expired/not found.

### `GET /api/my-history`

**Auth:** Required (JWT cookie)
**Query:** `?page=1&limit=20`
**Response:** Paginated list of the authenticated user's own audit log entries (analyze events only), including filename, score, grade, and timestamp. Users can only see their own history.

---

## 7. Error Handling

All error responses return JSON with an `error` field containing a user-friendly message. Internal details (stack traces, file paths, library error messages) are logged server-side but never exposed to the client.

### File Size Exceeded (HTTP 413)

nginx rejects uploads over 110MB before they reach the API. The frontend catches the 413 status and displays:

```json
{
  "error": "This file is too large. The maximum upload size is 100 MB.",
  "details": "Large PDFs are often inflated by uncompressed images. To reduce file size: (1) In Adobe Acrobat, use File → Save As Other → Reduced Size PDF; (2) Use File → Save As Other → Optimized PDF to downsample images; (3) Split the document into smaller sections (File → Organize Pages → Split) and analyze each part separately."
}
```

### Invalid File Type (HTTP 400)

The upload middleware checks magic bytes before processing. If the first bytes don't match `%PDF-`:

```json
{
  "error": "This file does not appear to be a valid PDF.",
  "details": "The file header is missing or incorrect. Please verify you are uploading a .pdf file and not a renamed file of another type (e.g., .docx, .jpg)."
}
```

### Malformed / Corrupted PDF (HTTP 422)

If magic bytes pass but QPDF or pdfjs-dist fails to parse the file:

```json
{
  "error": "This PDF could not be analyzed. The file appears to be damaged or uses a PDF structure that cannot be parsed.",
  "details": "This sometimes happens with PDFs created by older or non-standard software, or files that were incompletely downloaded. To fix this: (1) Re-download the file from its original source; (2) Open the file in Adobe Acrobat and re-save it (File → Save As → PDF); (3) If the file opens in a browser, print it to a new PDF using Print → Save as PDF."
}
```

The `qpdfService` and `pdfjsService` must catch all exceptions in their respective try/catch blocks and return a structured error object (not throw raw exceptions). The `pdfAnalyzer` orchestrator inspects these error objects and returns the appropriate HTTP 422 response.

### Password-Protected PDF (HTTP 422)

QPDF detects encryption via a specific exit code or error message containing "encrypted":

```json
{
  "error": "This PDF is password-protected.",
  "details": "Screen readers and accessibility tools also cannot access password-protected content. Please remove the password protection in Adobe Acrobat (File → Properties → Security → No Security) and re-upload."
}
```

### Analysis Timeout (HTTP 504)

If QPDF exceeds the 30-second subprocess timeout:

```json
{
  "error": "This PDF is too complex to analyze within the time limit.",
  "details": "This can happen with very large documents that contain many embedded images or complex structure trees. To work around this, try splitting the document into smaller sections using Adobe Acrobat (File → Organize Pages → Split) and analyzing each section separately."
}
```

### Partial Analysis Success

If QPDF succeeds but returns unexpected or empty structure data, the scorer does not fail — it marks affected categories as N/A and generates a partial report. A `warnings` array is included in the response:

```json
{
  "filename": "report.pdf",
  "overallScore": 72,
  "grade": "C",
  "warnings": ["Some accessibility checks could not be completed. The results below reflect only the checks that succeeded."],
  "categories": [ ... ]
}
```

---

## 8. Audit Logging

### What Is Logged (SQLite)

```sql
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,     -- 'login' | 'otp_request' | 'analyze' | 'logout'
  email TEXT NOT NULL,
  filename TEXT,                -- NULL for auth events
  score INTEGER,                -- NULL for auth events; 0-100 for analyze events
  grade TEXT,                   -- NULL for auth events; A/B/C/D/F for analyze events
  ip_address TEXT,
  user_agent TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_audit_email ON audit_log(email);
CREATE INDEX idx_audit_event ON audit_log(event_type);
```

### What Is NOT Stored

- File content (never written to disk beyond QPDF temp file)
- File binary data
- Passwords (no passwords exist)
- OTPs (stored as bcrypt hash, deleted after use or expiry)

### User Access to Own History

Authenticated users can view their own analysis history via `GET /api/my-history`. This returns only `analyze` events matching the user's JWT email. Users cannot see other users' logs or auth events. The admin `/api/logs` endpoint remains restricted to `ADMIN_EMAILS` for full cross-user visibility.

### Shared Reports (Phase 2)

```sql
CREATE TABLE shared_reports (
  id TEXT PRIMARY KEY,              -- UUID
  email TEXT NOT NULL,              -- uploader's email
  filename TEXT NOT NULL,
  report_json TEXT NOT NULL,        -- full analysis response as JSON string
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL      -- created_at + 30 days
);
CREATE INDEX idx_reports_expires ON shared_reports(expires_at);
```

- Reports are stored when a user clicks "Share" (Phase 2)
- A cleanup job deletes expired reports: `DELETE FROM shared_reports WHERE expires_at < datetime('now')`
- Run cleanup on every `POST /api/reports` call or via a daily cron job
- The 30-day expiry ensures shared links don't persist indefinitely while giving recipients reasonable time to view them

### Log Retention

Logs are kept indefinitely (small footprint — text only). Add a cron job to purge entries older than 1 year if desired.

---

## 9. Security

### File Handling
- Files never written to disk except QPDF temp file (deleted in `finally` block)
- Temp files use UUID names in `/tmp` — no predictable paths
- **QPDF command injection prevention** — QPDF is invoked via `execFileSync` (not `execSync`) to bypass the shell entirely. The temp file path is generated from `randomUUID()`, never from user-supplied data. These two controls together eliminate shell injection risk. Future refactors must never switch to `execSync` or pass user input as arguments.
- **QPDF process timeout** — `execFileSync` uses `{ timeout: ANALYSIS.QPDF_TIMEOUT_MS }` (default 30 seconds) to kill hung QPDF processes on malformed/adversarial PDFs. Without this, a crafted PDF could hang the subprocess indefinitely and exhaust resources.
- File type validation: check magic bytes (`%PDF-`) not just file extension
- Upload size hard-limited at `ANALYSIS.MAX_FILE_SIZE_MB` (default 100MB) — enforced by nginx `client_max_body_size` + multer limit
- **Multer file count limit** — multer must be configured with `limits: { files: 1 }` in Phase 1 to prevent multipart abuse (multiple file fields in a single request)
- No user-supplied filenames stored without sanitization
- **Filename sanitization** — before storing the original filename in the audit log, strip path components (`path.basename()`), limit to `FILENAME.MAX_LENGTH` characters (default 255), and replace any characters outside `FILENAME.ALLOWED_CHARS` with underscores. The admin dashboard and my-history page must render filenames as text content (not innerHTML) to prevent stored XSS.
- **Memory pressure protection** — multer's `limits.fileSize` must match `MAX_FILE_SIZE_MB` from env. A 100MB buffer in Node.js memory is significant — concurrent uploads of large files can exhaust the 4GB droplet. Limit concurrency to `ANALYSIS.MAX_CONCURRENT_ANALYSES` (default 2) simultaneous analyses via a semaphore or queue in `pdfAnalyzer.ts`. If memory pressure becomes an issue, consider streaming the upload to a temp file instead of buffering in memory (this would require updating multer to disk storage with cleanup).
- **SQLite WAL mode** — enable Write-Ahead Logging on database initialization: `db.pragma('journal_mode = WAL')`. WAL allows concurrent reads during writes, which matters during batch uploads (Phase 2) and when the admin dashboard queries while analyses are running. Without WAL, readers block writers and vice versa.

### Authentication & Cookies
- JWT in httpOnly cookie with `Secure` and `SameSite=Strict` attributes
- `Secure` ensures cookie is only sent over HTTPS (prevents leakage during misconfiguration)
- `SameSite=Strict` prevents CSRF by blocking cookie on cross-origin requests
- **JWT algorithm pinning** — when verifying JWTs with `jsonwebtoken`, always pass `{ algorithms: ['HS256'] }` to prevent algorithm confusion attacks (e.g., an attacker switching to `none` or `RS256`)
- CORS locked to same origin in production
- OTP stored as bcrypt hash; max 5 verification attempts per OTP before invalidation
- **Expired OTP cleanup** — a periodic job (or on-request check) must delete expired OTP rows from SQLite. Without this, the `otp_codes` table grows indefinitely. Run cleanup on every `/api/auth/request` call: `DELETE FROM otp_codes WHERE expires_at < datetime('now')`
- **OTP generation** — OTPs must be generated using `crypto.randomInt(100000, 999999)`, never `Math.random()`. `Math.random()` is not cryptographically secure and can be predicted in some JavaScript engines. This is a hard requirement.
- **Previous OTP invalidation** — when a user requests a new OTP, all unexpired OTPs for that email must be deleted first: `DELETE FROM otp_codes WHERE email = ?`. Without this, an attacker who intercepts an OTP request could have multiple valid codes to guess against, and a user could be confused by having multiple valid codes in their inbox.

**JWT session expiry UX** — When a JWT expires during an active session (e.g., user drops a file but the 72-hour token has lapsed), the API returns HTTP 401. The frontend must intercept 401 responses globally (via an Axios/fetch interceptor or Nuxt middleware), display a non-disruptive message ("Your session has expired — please log in again"), and redirect to `/login`. The in-progress upload is lost; the UI should not attempt to retry it silently.

### OTP Storage Schema

```sql
CREATE TABLE otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  attempts INTEGER DEFAULT 0,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_otp_email ON otp_codes(email);
```

### Rate Limiting (express-rate-limit)

Rate limiting is implemented via `express-rate-limit` with five separate limiters. All `max` and `windowMs` values are configured in `audit.config.ts → RATE_LIMITS`:

| Endpoint | Limit | Window | Key | Purpose |
|----------|-------|--------|-----|---------|
| `POST /api/auth/request` | 5 requests | 1 hour | email | Prevent OTP spam |
| `POST /api/auth/verify` | 10 attempts | 15 min | IP | Prevent brute-force |
| `POST /api/analyze` | 30 uploads | 1 hour | email (from JWT) | Prevent upload abuse |
| `POST /api/reports` | 10 reports | 1 hour | email (from JWT) | Prevent database fill |
| Global (all routes) | 100 requests | 1 min | IP | Catch-all safety net |

In-memory store is sufficient for single-server deployment. If the app ever runs multiple instances, switch to `rate-limit-redis`.

**Shared report UUID security** — Report IDs must be generated with `crypto.randomUUID()` (v4 UUID, 122 bits of entropy). This makes report URLs unguessable. Do not use auto-incrementing IDs or short IDs — they would allow enumeration of all shared reports. The `GET /api/reports/:id` endpoint is public and must not reveal whether an ID exists vs. has expired (return 404 for both cases to prevent timing-based enumeration).

### HTTP Security Headers (helmet)

Use `helmet` middleware on the Express API to set security headers automatically. Add `helmet` to dependencies and apply as the first middleware:

```typescript
import helmet from 'helmet'
app.use(helmet())
```

This sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security`, `X-XSS-Protection`, and disables `X-Powered-By`. No configuration needed for an API server.

### Error Response Hardening

API error responses must never leak internal details (stack traces, file paths, library versions). In production:

```typescript
app.use((err, req, res, next) => {
  console.error(err) // log full error server-side
  res.status(err.status || 500).json({
    error: err.status === 500 ? 'Internal server error' : err.message
  })
})
```

Never return raw QPDF stderr, pdfjs-dist exceptions, or SQLite errors to the client.

### Access Control
- `/api/logs` endpoint restricted to admin emails configured in `ADMIN_EMAILS` env var
- Non-admin authenticated users receive 403 on `/api/logs`
- `/history` page checks admin status on mount and redirects non-admins

### Reverse Proxy Trust

When running behind nginx, Express must be configured to trust the proxy so that `req.ip` returns the client's real IP (from `X-Forwarded-For`) instead of `127.0.0.1`:

```typescript
app.set('trust proxy', 1) // trust first proxy (nginx)
```

Without this, **all IP-based rate limiting is broken** — every request appears to come from localhost, and the rate limiter treats all users as a single client. This is a critical configuration requirement.

### URL Fetch Security (Phase 3)

The scheduled re-check feature (Phase 3) fetches PDFs from user-supplied URLs. This introduces SSRF (Server-Side Request Forgery) risk. Mitigations:

- **URL validation** — only allow `https://` URLs. Reject `http://`, `file://`, `ftp://`, and other schemes.
- **IP blocklist** — resolve the hostname before fetching and reject private/reserved IP ranges: `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fc00::/7`. Use a library like `ssrf-req-filter` or validate manually after DNS resolution.
- **Content-Type check** — after fetching, verify the response `Content-Type` is `application/pdf` before processing.
- **Response size limit** — abort the fetch if the response body exceeds `MAX_FILE_SIZE_MB`.
- **Timeout** — 30-second timeout on the HTTP fetch to prevent slow-loris style resource exhaustion.
- **URL gone handling** — if a scheduled URL returns 404 or 410 three consecutive times, mark the check as `inactive` and notify the owner. Do not delete the check — the owner can reactivate it with an updated URL.

### Environment Files
- `.env` files must be listed in `.gitignore` — secrets never committed to the repository
- On the droplet, `.env` files should be `chmod 600` and owned by the `forge` user
- Commit a `.env.example` file with placeholder values (never real secrets) for documentation

See 04-deployment-guide.md for nginx hardening, firewall rules, and HTTP security header configuration.

---

## 10. Key Dependencies

### `apps/api/package.json`

```json
{
  "dependencies": {
    "express": "^4.18",
    "express-rate-limit": "^7.x",
    "helmet": "^7.x",
    "multer": "^1.4",
    "pdfjs-dist": "^4.x",
    "better-sqlite3": "^9.x",
    "bcryptjs": "^2.x",
    "jsonwebtoken": "^9.x",
    "nodemailer": "^6.x",
    "uuid": "^9.x",
    "cors": "^2.x",
    "cookie-parser": "^1.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "@types/express": "^4.x",
    "@types/multer": "^1.x",
    "tsx": "^4.x",
    "vitest": "^3.x"
  },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:scoring": "vitest run --testPathPattern=scoring"
  }
}
```

### `apps/web/package.json`

```json
{
  "dependencies": {
    "nuxt": "^4.31",
    "@nuxt/ui": "^4.x"
  },
  "devDependencies": {
    "vitest": "^3.x",
    "@vue/test-utils": "^2.x"
  },
  "scripts": {
    "dev": "nuxt dev --port 6102",
    "build": "nuxt build",
    "start": "node .output/server/index.mjs",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

---

## 11. Development Setup

### Prerequisites

```bash
# macOS
brew install qpdf node pnpm

# Ubuntu/Debian
sudo apt install -y qpdf
npm install -g pnpm

# Verify
qpdf --version    # 11.x+
node --version     # 20.x+
pnpm --version     # 9.x+
```

### Running Locally

```bash
# From the monorepo root
pnpm install

# Terminal 1: API server (with hot reload)
cd apps/api
cp .env.example .env    # edit with dev values (see below)
pnpm dev                # starts on http://localhost:6103

# Terminal 2: Nuxt frontend (with hot reload)
cd apps/web
cp .env.example .env    # edit with dev values (see below)
pnpm dev                # starts on http://localhost:6102
```

### Development Environment Variables

**`apps/api/.env` (development overrides):**

```env
NODE_ENV=development
PORT=6103
JWT_SECRET=dev-secret-do-not-use-in-production
JWT_EXPIRY_HOURS=72
OTP_EXPIRY_MINUTES=15
OTP_MAX_ATTEMPTS=5
DB_PATH=./data/audit.db
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_USER=
SMTP_PASS=
SMTP_FROM=noreply@localhost
MAX_FILE_SIZE_MB=100
TMP_DIR=/tmp
ADMIN_EMAILS=dev@test.illinois.gov
ALLOWED_DOMAINS=illinois.gov,localhost
```

**`apps/web/.env` (development):**

```env
NUXT_PUBLIC_APP_NAME=File Accessibility Audit (DEV)
NUXT_API_BASE=http://localhost:6103
```

### Development vs. Production Differences

| Concern | Development | Production |
|---------|------------|------------|
| **Cookie `Secure` flag** | `false` (HTTP on localhost) | `true` (HTTPS required) |
| **`SameSite`** | `Lax` (cross-port localhost) | `Strict` |
| **CORS origin** | `http://localhost:6102` | Same origin (via nginx proxy) |
| **Email delivery** | Local mail catcher (Mailpit) | SMTP2GO |
| **Domain validation** | Allow `@localhost` for testing | `@illinois.gov` only |
| **`trust proxy`** | Not set (direct access) | `1` (behind nginx) |

These differences must be driven by `NODE_ENV`, not by separate code paths. Example:

```typescript
const isProduction = process.env.NODE_ENV === 'production'

// Cookie settings
const cookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? 'strict' : 'lax',
  maxAge: 72 * 60 * 60 * 1000,
}

// CORS
app.use(cors({
  origin: isProduction ? false : 'http://localhost:6102',
  credentials: true,
}))

// Trust proxy (production only, behind nginx)
if (isProduction) {
  app.set('trust proxy', 1)
}
```

### Local Email Testing with Mailpit

Use [Mailpit](https://mailpit.axllent.org/) as a local SMTP catch-all during development. It captures all outgoing emails in a web UI without actually delivering them.

```bash
# Install
brew install mailpit    # macOS
# or download from https://mailpit.axllent.org/docs/install/

# Run
mailpit
# SMTP server: localhost:1025
# Web UI: http://localhost:8025
```

Set `SMTP_HOST=localhost` and `SMTP_PORT=1025` in the API `.env`. All OTP emails will appear in the Mailpit web UI at `http://localhost:8025` — no real email delivery, no SMTP2GO quota usage during development.

**Alternative: skip email entirely in dev.** Add a dev-only log line that prints the OTP to the API console:

```typescript
if (!isProduction) {
  console.log(`[DEV] OTP for ${email}: ${otp}`)
}
```

This is faster for rapid iteration but doesn't test the email template rendering.

### Test PDF Fixtures

Create a `tests/fixtures/` directory with known test PDFs:

| File | Purpose | Expected Grade |
|------|---------|---------------|
| `tagged-accessible.pdf` | Fully tagged, titled, headings, alt text, bookmarks | A |
| `minimal-text-only.pdf` | Text-extractable but no tags, no title, no lang | D or F |
| `scanned-image.pdf` | Image-only, no text layer, no StructTree | F (auto) |
| `password-protected.pdf` | Encrypted PDF | Error 422 |
| `corrupted.pdf` | Truncated/malformed binary | Error 422 |
| `no-images-no-tables.pdf` | Simple text with tags but no images/tables/forms | A (N/A categories excluded) |
| `large-complex.pdf` | Many pages, images, tables (~20MB) | Varies (performance test) |

These fixtures enable repeatable scoring tests. Each fixture should have a companion `.expected.json` file documenting the expected score and category breakdown, so tests can assert against known-good outputs.

### Running Tests

```bash
# From monorepo root
pnpm --filter api test          # API unit + integration tests
pnpm --filter api test:scoring  # Scoring model against fixtures
pnpm --filter web test          # Frontend component tests

# Recommended test framework
# API: vitest (fast, TypeScript-native, ESM-compatible)
# Web: vitest + @vue/test-utils (Nuxt-compatible)
```

Add `vitest` to both `apps/api/devDependencies` and `apps/web/devDependencies`. Add test scripts to each `package.json`:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:scoring": "vitest run --testPathPattern=scoring"
  }
}
```

### SQLite in Development

The dev database is created automatically at `apps/api/data/audit.db` on first run. To reset it, simply delete the file — it will be recreated on the next API startup. The API's database initialization code must create all tables idempotently (use `CREATE TABLE IF NOT EXISTS`).

---

## 12. Environment Variables

See **04-deployment-guide.md, Section 6** for the complete environment variable reference for both `apps/api/.env` and `apps/web/.env`, including SMTP2GO configuration notes.

---

## 13. Document Index

| Doc # | Title | Description |
|-------|-------|-------------|
| 00 | Master Design (this document) | Architecture, scoring model, API, auth, security — single source of truth |
| 01 | Phase 1 — Core Grader | Phase 1 deliverables checklist and testing criteria |
| 02 | Phase 2 — Enhanced Features | Phase 2 deliverables: batch upload, shareable reports via SQLite |
| 03 | Phase 3 — Admin & Monitoring | Phase 3 deliverables: admin dashboard, scheduled re-checks with SSRF mitigation |
| 04 | Deployment Guide | Infrastructure, env vars, Forge, PM2, nginx, firewall, deploy workflow |
| 05 | Use Cases | End-user scenarios and workflows |
| 06 | SMTP2GO Integration Guide | SMTP2GO registration, setup, Nodemailer config, gotchas |
| 07 | Mailgun Integration Guide | Mailgun registration, DNS, Nodemailer config |
| 08 | Phase 4 — DOCX Support | Phase 4 deliverables: DOCX accessibility analysis via jszip + XML parsing |

---

*End of Master Design Document — v1.7*
