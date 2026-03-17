# 01 — Phase 1: Core Grader

**Project:** `file-accessibility-audit`
**Phase:** 1 of 4
**Goal:** Ship a working PDF accessibility grader with auth, analysis engine, scoring, and score card UI.

---

## Scope

Phase 1 delivers the complete end-to-end flow: a user logs in with their `@illinois.gov` email, drops a PDF, and receives a scored accessibility report. This phase includes all infrastructure, auth, the analysis engine, the scoring model, and the results UI.

---

## Deliverables

### 1. Authentication System

Implement the full OTP-based auth flow as specified in **00-master-design.md, Section 3**.

Build checklist:
- [ ] `/login` page with email input and OTP entry step
- [ ] `POST /api/auth/request` — domain validation, OTP generation, bcrypt hash storage, email delivery
- [ ] `POST /api/auth/verify` — OTP verification with attempt limiting, JWT issuance
- [ ] `POST /api/auth/logout` — cookie clearing
- [ ] `auth.ts` Nuxt middleware — redirect unauthenticated users to `/login`
- [ ] `authMiddleware.ts` Express middleware — JWT validation on protected routes
- [ ] `rateLimiter.ts` — four rate limit configs per 00-master-design.md, Section 9
- [ ] Error states: invalid domain, expired OTP, wrong OTP, max attempts exceeded, rate limited (429)

### 2. PDF Analysis Engine

Implement the analysis pipeline as specified in **00-master-design.md, Section 4**.

Build checklist:
- [ ] `POST /api/analyze` — multipart/form-data, PDF, max 100MB
- [ ] `uploadMiddleware.ts` — multer with memory storage, `limits: { files: 1 }`
- [ ] `pdfjsService.ts` — text extraction, page count, metadata, fonts, outlines, URLs
- [ ] `qpdfService.ts` — temp file handling, JSON output parsing, structure tree inspection
- [ ] `pdfAnalyzer.ts` — orchestration of pdfjsService + qpdfService
- [ ] `scorer.ts` — all 9 categories per 00-master-design.md, Section 5
- [ ] Magic bytes validation (`%PDF-`)
- [ ] Error handling per 00-master-design.md, Section 7: malformed PDF (422), password-protected (422), size exceeded (413), timeout (504), partial analysis with warnings

### 3. Scoring Model

Implement all 9 scoring categories with weights as specified in **00-master-design.md, Section 5**. Includes scanned PDF auto-detection and N/A handling for inapplicable categories.

### 4. Frontend UI (Nuxt 4 / Nuxt UI 4)

- **Dark mode only** — Background: `#0a0a0a`, Surface: `#111111`, Borders: `#222222`, Text: `#f5f5f5`
- `/login` — email input -> OTP entry -> error states
- `/` (main app) — five states:
  1. **Idle** — centered drop zone, dashed border, file icon
  2. **Dragging** — highlighted border, pulse animation
  3. **Processing** — full overlay with stage labels ("Uploading...", "Extracting PDF structure...", "Scoring accessibility...", "Building report...")
  4. **Results** — ScoreCard + CategoryRow breakdown
  5. **Error** — error message with retry option
- **ScoreCard** — grade letter at 8-10rem, bold, color-coded; filename and page count above; plain-English summary below
- **CategoryRow** — category name, animated horizontal score bar, score number, grade badge, severity badge, expandable findings list (chevron toggle)

### 5. Audit Logging & User History

Implement audit logging as specified in **00-master-design.md, Section 8**.

Build checklist:
- [ ] SQLite `audit_log` table — schema per doc 00
- [ ] Log events: `login`, `otp_request`, `analyze`, `logout`
- [ ] `GET /api/logs` — admin-only, paginated (restricted to `ADMIN_EMAILS`)
- [ ] `GET /api/my-history` — authenticated user's own analysis events, paginated
- [ ] `/history` page — admin log viewer with table
- [ ] `/my-history` page — user's own past analyses with filename, score, grade, date

### 6. Infrastructure

Deploy per **04-deployment-guide.md**. Includes DigitalOcean droplet, Forge, PM2, nginx, SSL, firewall.

---

## Testing Checklist

- [ ] Login flow: valid `@illinois.gov` email -> OTP received -> JWT issued -> cookie set
- [ ] Login rejection: non-illinois.gov email returns error
- [ ] OTP expiry: OTP entered after 15 minutes returns "expired" error
- [ ] OTP attempt limit: 6th wrong OTP attempt invalidates the OTP, returns "max attempts exceeded"
- [ ] Rate limiting (auth/request): 6th OTP request within 1 hour returns 429
- [ ] Rate limiting (auth/verify): 11th verify attempt from same IP within 15 minutes returns 429
- [ ] Rate limiting (analyze): 31st upload within 1 hour returns 429
- [ ] JWT cookie: verify httpOnly, Secure, and SameSite=Strict attributes are set
- [ ] JWT expiry: token remains valid for 72 hours, rejected after
- [ ] File upload: valid PDF under 100MB returns scored report
- [ ] File rejection: non-PDF file (wrong magic bytes) returns error with explanation
- [ ] File rejection: PDF over 100MB returns error with size and mitigation suggestions
- [ ] Malformed PDF: corrupted or unparseable PDF returns graceful error with explanation
- [ ] Scanned PDF: image-only PDF returns automatic F with warning banner
- [ ] All 9 scoring categories produce correct scores for a known test PDF
- [ ] Score card renders correct grade letter, color, and message
- [ ] Category rows expand/collapse findings
- [ ] Processing overlay shows stage progression
- [ ] Temp file cleanup: no orphaned files in `/tmp` after analysis
- [ ] Audit log records all events with correct data
- [ ] `/history` page: admin email can view log entries
- [ ] `/history` page: non-admin authenticated user is redirected or sees 403
- [ ] `/api/logs`: non-admin JWT returns 403
- [ ] `GET /api/my-history`: authenticated user sees only their own analyze events
- [ ] `GET /api/my-history`: user cannot see other users' events
- [ ] `/my-history` page: displays user's past analyses with scores
- [ ] Logout clears cookie and redirects to `/login`
- [ ] Unauthenticated access to `/` redirects to `/login`
- [ ] CORS blocks cross-origin requests in production
- [ ] Helmet headers present: X-Content-Type-Options, X-Frame-Options, HSTS
- [ ] Error responses in production do not leak stack traces, file paths, or library versions
- [ ] QPDF subprocess times out after 30 seconds on adversarial input
- [ ] Ports 6102/6103 are not accessible from external network (firewall test)
- [ ] JWT verification uses `algorithms: ['HS256']` — rejects tokens with `alg: none`
- [ ] Expired OTP rows are cleaned up (do not accumulate in SQLite)
- [ ] OTP generated with `crypto.randomInt`, not `Math.random` (verify in code review)
- [ ] Requesting a new OTP invalidates all previous unexpired OTPs for that email
- [ ] `execFileSync` used for QPDF (not `execSync`) — verify in code review
- [ ] Express `trust proxy` is set to `1` in production — verify `req.ip` returns real client IP behind nginx
- [ ] Filenames in audit log are sanitized (path stripped, length limited, special chars replaced)
- [ ] SQLite WAL mode enabled — verify with `PRAGMA journal_mode` returning `wal`
- [ ] `audit_log` table includes `score` and `grade` columns for analyze events
- [ ] Cookie `Secure` flag is `false` in development (NODE_ENV=development), `true` in production
- [ ] CORS allows `http://localhost:6102` in development, blocks cross-origin in production

---

## Development Testing

### Test Framework

Use **vitest** for both API and frontend tests. See **00-master-design.md, Section 11** for setup details.

### Test Fixtures

Maintain a `tests/fixtures/` directory with known test PDFs (see 00-master-design.md, Section 11 for the full fixture list). Each fixture has a companion `.expected.json` so scoring tests can assert against known-good outputs.

### Scoring Regression Tests

The scorer is the most critical component to test. For each test fixture:

1. Run the full analysis pipeline (pdfjsService + qpdfService + scorer)
2. Assert the overall score and grade match the expected values
3. Assert each category score matches (with a tolerance of +/- 1 for rounding)
4. Assert the scanned PDF detection triggers correctly for `scanned-image.pdf`
5. Assert N/A categories are excluded from the weighted average for `no-images-no-tables.pdf`

These tests should run on every commit and block merges if they fail.

### Manual Testing Workflow

For local development without real email:

1. Start Mailpit (`mailpit`) — captures emails at `http://localhost:8025`
2. Start the API (`pnpm dev` in `apps/api`) — sends OTPs to Mailpit
3. Start the frontend (`pnpm dev` in `apps/web`)
4. Log in with any `@illinois.gov` email — check Mailpit for the OTP
5. Upload test PDFs from `tests/fixtures/` and verify scores match expectations

Alternatively, use the dev console OTP log (see 00-master-design.md, Section 11) to skip email entirely.

---

## Exit Criteria

Phase 1 is complete when a user can:

1. Visit the app and be redirected to login
2. Authenticate with an `@illinois.gov` email via OTP
3. Drop a PDF on the main page
4. Receive a scored accessibility report with grade, category breakdown, and findings
5. View their own analysis history on the my-history page
6. View audit logs on the history page (admin only)
7. Log out

---

*End of Phase 1 — v1.5*
