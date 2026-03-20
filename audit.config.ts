/**
 * audit.config.ts — Single source of truth for ALL configurable constants.
 *
 * ============================================================================
 * EVERY magic number, threshold, weight, limit, and display constant in this
 * project lives here. The API imports this directly. The frontend references it
 * via shared types. The design documents (docs/00-master-design.md) describe
 * the "why" — this file defines the "what".
 *
 * RULES:
 * 1. If you add a new constant anywhere in the codebase, put it here first.
 * 2. Never hardcode a configurable value in a service, route, or component.
 * 3. Secrets (JWT_SECRET, SMTP_PASS) stay in .env — this file is committed.
 * 4. After changing a value, run `pnpm --filter api test:scoring` to verify
 *    scoring still produces expected results against test fixtures.
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// BRANDING
// ---------------------------------------------------------------------------
// All organization-specific branding lives here. Override these values to
// white-label the tool for a different organization. The defaults are ICJIA.
//
// SAFE TO CHANGE: Yes — all values are purely cosmetic or used in URLs.
// After changing, also update these static files manually:
//   - apps/web/public/site.webmanifest  (name, short_name)
//   - apps/web/public/llms.txt          (title, organization, URLs)
//   - apps/web/public/llms-full.txt     (title, organization, URLs)
//   - og-image.svg → regenerate og-image.png
//   - apps/cli/package.json             (package name, if forking)
// ---------------------------------------------------------------------------

export const BRANDING = {
  /** Application name displayed in headers, page titles, exports, and emails. */
  APP_NAME: 'ICJIA File Accessibility Audit',

  /** Short app name (for PWA manifest, browser tabs when space is limited). */
  APP_SHORT_NAME: 'Accessibility Audit',

  /** Organization name shown in Schema.org, meta tags, and export footers. */
  ORG_NAME: 'Illinois Criminal Justice Information Authority',

  /** Organization website URL (used in Schema.org identity and JSON-LD author). */
  ORG_URL: 'https://icjia.illinois.gov',

  /** FAQs / documentation URL shown in the navbar. Set to '' to hide the link. */
  FAQS_URL: 'https://accessibility.icjia.app',

  /** GitHub repository URL shown in the footer. Set to '' to hide the link. */
  GITHUB_URL: 'https://github.com/ICJIA/file-accessibility-audit',

  /** Default color mode for the UI. Users can toggle between light and dark via the nav.
   *  Set to 'dark' for a dark-first experience, or 'light' if your agency's branding
   *  requires a light default. Users can always switch modes via the toggle in the nav bar.
   *  SAFE TO CHANGE: 'light' | 'dark' */
  DEFAULT_COLOR_MODE: 'dark' as 'light' | 'dark',
} as const

// ---------------------------------------------------------------------------
// DEPLOYMENT
// ---------------------------------------------------------------------------

export const DEPLOY = {
  /**
   * The canonical production URL for this application.
   *
   * Used in:
   * - Shared report URLs returned by POST /api/reports
   * - OTP email footer (optional "sent from" link)
   * - CORS origin validation (production mode)
   * - nginx server_name directive
   *
   * SAFE TO CHANGE: Yes — update when migrating to a new domain.
   * ALSO UPDATE: nginx config, DNS A record, Let's Encrypt cert.
   */
  PRODUCTION_URL: 'https://audit.icjia.app',

  /**
   * Development frontend URL (Nuxt dev server).
   * Used for CORS origin in development mode.
   *
   * SAFE TO CHANGE: Yes — if you change the Nuxt dev port, update this.
   */
  DEV_FRONTEND_URL: 'http://localhost:6102',

  /** API server port (development and production) */
  API_PORT: 6103,

  /** Frontend server port (Nuxt dev / production) */
  WEB_PORT: 6102,
} as const

// ---------------------------------------------------------------------------
// EMAIL PROVIDER
// ---------------------------------------------------------------------------
// Controls which SMTP relay is used for OTP delivery. Credentials (user,
// pass) stay in .env — only non-secret connection details live here.
//
// To switch providers: change PROVIDER below. Both sets of SMTP settings
// are defined here; the mailer picks the active one automatically.
// Credentials for whichever provider you choose must be in .env as
// SMTP_USER and SMTP_PASS.
//
// SAFE TO CHANGE: Yes — swap PROVIDER any time. No code changes needed.
// ---------------------------------------------------------------------------

export const EMAIL = {
  /**
   * Active email provider. Determines which SMTP settings are used.
   *
   * SAFE TO CHANGE: Yes — set to 'mailgun' or 'smtp2go'.
   */
  PROVIDER: 'mailgun' as 'mailgun' | 'smtp2go',

  /**
   * Default sender address for OTP emails.
   *
   * SAFE TO CHANGE: Yes — must match a verified sender on the active provider.
   * Can be overridden in .env with SMTP_FROM.
   */
  DEFAULT_FROM: 'admin@icjia.cloud',

  /** Mailgun SMTP connection details (no secrets). */
  mailgun: {
    host: 'smtp.mailgun.org',
    port: 587,
  },

  /** SMTP2GO SMTP connection details (no secrets). */
  smtp2go: {
    host: 'mail.smtp2go.com',
    port: 2525,
  },
} as const

// ---------------------------------------------------------------------------
// SCORING WEIGHTS
// ---------------------------------------------------------------------------
// These weights control how much each accessibility category contributes to
// the overall score. They MUST sum to exactly 1.0.
//
// The weights reflect WCAG 2.1 priority: text extractability is the most
// fundamental requirement (a scanned PDF is completely inaccessible), followed
// by structural elements (title, headings, alt text) that affect the majority
// of assistive technology users.
//
// SAFE TO CHANGE: Yes — but with care. Changing weights changes every
// document's score. After changing, re-run `pnpm --filter api test:scoring`
// and update the .expected.json fixtures if the new weights are intentional.
//
// DO NOT CHANGE the keys — they are used as category IDs throughout the
// codebase and in stored audit log data. Renaming a key is a breaking change.
// ---------------------------------------------------------------------------

export const SCORING_WEIGHTS = {
  /** Is the PDF text-based (not scanned) and tagged? Highest weight because
   *  a scanned PDF is fundamentally inaccessible — nothing else matters. */
  text_extractability: 0.175,

  /** Does the PDF have a meaningful title and a declared language?
   *  Screen readers announce both on document open. */
  title_language: 0.130,

  /** Are H1–H6 heading tags present with a logical hierarchy?
   *  Headings are the primary navigation mechanism for screen reader users. */
  heading_structure: 0.130,

  /** Do images have alternative text descriptions?
   *  Required by WCAG 1.1.1 for all non-decorative images. */
  alt_text: 0.130,

  /** Does the document have bookmarks/outlines for navigation?
   *  Only assessed for documents with 10+ pages (see ANALYSIS.BOOKMARKS_PAGE_THRESHOLD). */
  bookmarks: 0.085,

  /** Are data tables marked up with /Table, /TH, and /TD tags?
   *  Without these, screen readers can't convey table structure. */
  table_markup: 0.085,

  /** Are hyperlinks descriptive (not raw URLs)?
   *  "Click here" and raw URLs are unhelpful to screen reader users. */
  link_quality: 0.045,

  /** Do form fields have accessible labels (/TU tooltip)?
   *  Unlabeled form fields are unusable with assistive technology. */
  form_accessibility: 0.040,

  /** Does the structure tree define a correct reading order?
   *  Distinct from text_extractability: this checks ORDER quality, not just
   *  whether the StructTree exists. */
  reading_order: 0.040,

  /** Did veraPDF confirm PDF/UA compliance?
   *  This is a direct standards signal that complements heuristic checks. */
  pdf_ua_compliance: 0.095,

  /** Does text have sufficient color contrast against its background?
   *  WCAG 1.4.3 requires 4.5:1 for normal text, 3:1 for large text. */
  color_contrast: 0.045,
} as const

// ---------------------------------------------------------------------------
// GRADE THRESHOLDS
// ---------------------------------------------------------------------------
// Map an overall score (0–100) to a letter grade, display color, and label.
// Array must be sorted descending by `min`. The first matching entry wins.
//
// SAFE TO CHANGE:
// - `min` thresholds: Yes — e.g., making A require 95+ instead of 90+.
// - `color`: Yes — these are Tailwind-compatible hex colors used in the UI.
// - `label`: Yes — these appear in the ScoreCard summary text.
// - `grade` letters: No — changing "A" to "S" would break stored audit data
//   and shared reports that reference grade letters. Don't do this.
// ---------------------------------------------------------------------------

export const GRADE_THRESHOLDS = [
  { min: 90, grade: 'A' as const, color: '#22c55e', label: 'Excellent' },
  { min: 80, grade: 'B' as const, color: '#14b8a6', label: 'Good' },
  { min: 70, grade: 'C' as const, color: '#eab308', label: 'Needs Improvement' },
  { min: 60, grade: 'D' as const, color: '#f97316', label: 'Poor' },
  { min: 0,  grade: 'F' as const, color: '#ef4444', label: 'Failing' },
] as const

// ---------------------------------------------------------------------------
// SEVERITY THRESHOLDS
// ---------------------------------------------------------------------------
// Map a per-category score (0–100) to a severity label. Used in the category
// breakdown UI and API response. Array must be sorted descending by `min`.
//
// SAFE TO CHANGE:
// - `min` thresholds: Yes — adjusts when a category flips between severities.
// - `severity` labels: Carefully — these appear in API responses and may be
//   consumed by external scripts or CSV exports. Change only if you also
//   update the frontend rendering.
// ---------------------------------------------------------------------------

export const SEVERITY_THRESHOLDS = [
  { min: 90, severity: 'Pass' as const },
  { min: 70, severity: 'Minor' as const },
  { min: 40, severity: 'Moderate' as const },
  { min: 0,  severity: 'Critical' as const },
] as const

// ---------------------------------------------------------------------------
// PDF ANALYSIS LIMITS
// ---------------------------------------------------------------------------
// Operational limits for the PDF analysis pipeline. These protect the server
// from resource exhaustion and define category-specific behavior thresholds.
//
// SAFE TO CHANGE: Yes for all values, but read the notes on each.
// ---------------------------------------------------------------------------

export const ANALYSIS = {
  /**
   * Maximum file upload size in megabytes.
   *
   * Enforced in three places (all must agree):
   * 1. multer `limits.fileSize` in uploadMiddleware.ts
   * 2. nginx `client_max_body_size` (set to this + 10MB headroom for headers)
   * 3. Frontend file picker validation (immediate user feedback)
   *
   * SAFE TO CHANGE: Yes — but increasing above 100MB on a 4GB droplet risks
   * OOM kills during concurrent uploads. If you increase this, also increase
   * the nginx `client_max_body_size` in the Forge nginx config.
   */
  MAX_FILE_SIZE_MB: 100,

  /**
   * QPDF subprocess timeout in milliseconds.
   * If QPDF hasn't finished parsing within this window, the process is killed
   * and the API returns HTTP 504.
   *
   * SAFE TO CHANGE: Yes — increase if legitimate complex PDFs are timing out.
   * Decrease if you want faster failure on adversarial inputs. 60s is a
   * reasonable default; most PDFs finish in under 5s.
   */
  QPDF_TIMEOUT_MS: 60_000,

  /**
   * Maximum stdout buffer for QPDF JSON output, in bytes.
   * QPDF's `--json` output can be very large for PDFs with deep structure
   * trees or many objects. If the output exceeds this, execFileSync throws.
   *
   * SAFE TO CHANGE: Yes — increase if you see "maxBuffer exceeded" errors
   * on legitimate PDFs. 50MB handles most documents; very complex government
   * reports with thousands of tagged elements may need more.
   */
  QPDF_MAX_BUFFER: 50 * 1024 * 1024,

  /**
   * veraPDF subprocess timeout in milliseconds.
   * veraPDF can take longer than qpdf on structure-heavy PDFs because it
   * evaluates formal PDF/UA rules rather than just dumping object structure.
     *
   * SAFE TO CHANGE: Yes — increase if standards validation times out on
   * legitimate tagged PDFs. 60s keeps parity with qpdf while remaining bounded.
   */
  VERAPDF_TIMEOUT_MS: 60_000,

  /**
   * Maximum stdout buffer for veraPDF JSON output, in bytes.
   * Large tagged PDFs can emit detailed rule reports with many failed checks.
   *
   * SAFE TO CHANGE: Yes — increase if veraPDF hits maxBuffer on legitimate
   * documents. 20MB is sufficient for typical PDF/UA reports.
   */
  VERAPDF_MAX_BUFFER: 20 * 1024 * 1024,

  /**
   * Default veraPDF flavour/profile to validate against.
   * `ua1` corresponds to PDF/UA-1.
   *
   * SAFE TO CHANGE: Yes — but downstream scoring assumes PDF/UA validation.
   */
  VERAPDF_DEFAULT_FLAVOUR: 'ua1',

  /**
   * veraPDF is deprecated in this deployment and is skipped by default.
   * Set `DEFAULT_SKIP_VERAPDF=false` only for temporary debugging while the
   * legacy integration still exists in the codebase.
   *
   * SAFE TO CHANGE: Yes — but the intended direction is to keep veraPDF off
   * and rely on local standards plus remediation heuristics instead.
   */
  DEFAULT_SKIP_VERAPDF: true,

  /**
   * Maximum number of PDFs being analyzed simultaneously.
   * Implemented as a semaphore in pdfAnalyzer.ts. Requests beyond this limit
   * wait in a queue (or return 503 if the queue is also full).
   *
   * SAFE TO CHANGE: Yes — but on a 4GB droplet, 2 is the safe maximum.
   * Each analysis can consume 100MB+ in memory (multer buffer + QPDF process).
   * Increase only if you upgrade the droplet's RAM.
   */
  MAX_CONCURRENT_ANALYSES: 5,

  /**
   * Minimum page count to require bookmarks/outlines.
   * Documents with fewer pages than this score N/A on the Bookmarks category
   * instead of being penalized for missing bookmarks.
   *
   * SAFE TO CHANGE: Yes — WCAG doesn't specify an exact threshold. 10 is
   * conservative. Some organizations use 4 or 5 pages.
   */
  BOOKMARKS_PAGE_THRESHOLD: 10,

  /**
   * Reading order: fraction of out-of-order MCIDs that triggers a score
   * reduction. If more than this fraction of content items are out of
   * sequence relative to the page content stream, the reading order score
   * drops from 100 to 50.
   *
   * SAFE TO CHANGE: Yes — increase to be more lenient (e.g., 0.30 = allow
   * 30% out-of-order before penalizing), decrease to be stricter.
   */
  READING_ORDER_DISORDER_THRESHOLD: 0.20,

  /**
   * Maximum relative glyph-width drift allowed when substituting a missing
   * legacy font with an approved fallback before the substitution is rejected.
   *
   * Example: 0.12 means a substituted glyph width may differ by at most 12%
   * from the original PDF font dictionary width for the same character code.
   *
   * SAFE TO CHANGE: Yes — increase to allow looser fallback substitution when
   * exact source fonts are unavailable; decrease to keep layout stricter.
   */
  LEGACY_FONT_WIDTH_DRIFT_THRESHOLD: 0.35,

  /**
   * Generic/meaningless link text patterns. Links whose visible text matches
   * one of these phrases (case-insensitive) are flagged by scoreLinkQuality.
   */
  GENERIC_LINK_TEXT_PATTERNS: [
    'click here', 'here', 'read more', 'more', 'link', 'this link',
    'learn more', 'find out more', 'continue', 'go here', 'download',
  ] as string[],

  /**
   * PDFMiner reading order: disorder ratio above which the secondary signal
   * triggers a score reduction in scoreReadingOrder.
   */
  PDFMINER_READING_ORDER_THRESHOLD: 0.25,

  /**
   * Maximum number of pages analyzed by the PDFMiner reading order checker.
   */
  PDFMINER_MAX_PAGES: 20,

  /**
   * Timeout for PDFMiner reading order analysis, in milliseconds.
   */
  PDFMINER_TIMEOUT_MS: 45_000,

  /**
   * Maximum number of pages analyzed for color contrast.
   */
  COLOR_CONTRAST_MAX_PAGES: 10,

  /**
   * Timeout for color contrast analysis, in milliseconds.
   */
  COLOR_CONTRAST_TIMEOUT_MS: 120_000,

  /**
   * WCAG minimum contrast ratio for normal-sized text (4.5:1).
   */
  COLOR_CONTRAST_NORMAL_TEXT_THRESHOLD: 4.5,

  /**
   * WCAG minimum contrast ratio for large text (3:1).
   */
  COLOR_CONTRAST_LARGE_TEXT_THRESHOLD: 3.0,

  /**
   * Font size threshold (in points) for "large text" (non-bold).
   */
  COLOR_CONTRAST_LARGE_TEXT_MIN_PT: 18,

  /**
   * Font size threshold (in points) for "large text" when bold.
   */
  COLOR_CONTRAST_BOLD_LARGE_TEXT_MIN_PT: 14,

  /**
   * Timeout for table structure detection, in milliseconds.
   */
  TABLE_STRUCTURE_TIMEOUT_MS: 60_000,
} as const

// ---------------------------------------------------------------------------
// REMEDIATION
// ---------------------------------------------------------------------------
// Runtime toggles for the native remediation pipeline.
//
// SAFE TO CHANGE:
// - ENABLE_PLANNER_AI_FALLBACK: Yes. Default false keeps planning fully
//   deterministic. Enable only for debugging or emergency fallback behavior.
// ---------------------------------------------------------------------------

export const REMEDIATION = {
  ENABLE_PLANNER_AI_FALLBACK: false,

  /**
   * Enable Adobe PDF Services API integration (Accessibility Checker + Auto-Tag).
   *
   * Set to false when Adobe API quota is exhausted or credentials are unavailable.
   * When disabled:
   * - The accessibility checker is skipped during analysis (adobe panel shows 'unavailable')
   * - The adobe_auto_tag remediation tool is skipped entirely
   * - All scoring proceeds without Adobe evidence (no score caps from Adobe findings)
   *
   * SAFE TO CHANGE: Yes — flip back to true when quota resets or new credentials are loaded.
  */
  ENABLE_ADOBE_API: false,

  /**
   * Maximum number of deterministic remediation rounds before the pipeline
   * stops replanning and falls through to final validation/cleanup.
   *
   * SAFE TO CHANGE: Yes — lower values reduce latency, higher values allow
   * more recovery attempts at the cost of significantly longer runtimes.
   */
  MAX_REMEDIATION_ROUNDS: 3,

  /**
   * Minimum category score gain required for a changed stage to count as
   * progress when standards validation does not improve.
   *
   * SAFE TO CHANGE: Yes — increase to stop earlier on small improvements,
   * decrease to keep iterating on minor wins.
   */
  MIN_SCORE_IMPROVEMENT_TO_CONTINUE: 1,

  /**
   * Maximum number of consecutive changed stages that may produce no
   * standards or targeted-category improvement before remediation stops.
   *
   * SAFE TO CHANGE: Yes — lower values stop sooner, higher values allow
   * more speculative repair attempts.
   */
  MAX_NO_PROGRESS_STAGES: 2,

  /**
   * Maximum number of repeated Acrobat ownership repair passes allowed inside
   * a single remediation round while risks continue to shrink.
   *
   * SAFE TO CHANGE: Yes — higher values allow more convergence on deeply
   * tangled legacy structure trees but increase runtime.
   */
  MAX_ACROBAT_OWNERSHIP_PASSES_PER_ROUND: 4,

  /**
   * Minimum Acrobat ownership risk-count reduction required to justify one
   * more dedicated ownership repair pass in the same round.
   *
   * SAFE TO CHANGE: Yes — increase to stop sooner, decrease to squeeze out
   * smaller structural improvements.
   */
  MIN_ACROBAT_RISK_REDUCTION_TO_CONTINUE: 1,

  /**
   * Minimum number of structural remediation rounds to allow when Acrobat
   * ownership risks or visually detected untagged tables still remain.
   *
   * SAFE TO CHANGE: Yes — keeps round-one flat scores from ending a repair
   * campaign before structural fixes have time to converge.
   */
  MIN_STRUCTURAL_ROUNDS: 2,
} as const

// ---------------------------------------------------------------------------
// AUTHENTICATION
// ---------------------------------------------------------------------------
// Controls for the OTP-based auth system. These values are also referenced
// in the auth flow description (doc 00, Section 3) and rate limiting.
//
// Note: JWT_SECRET is in .env (per-environment secret), not here.
// ---------------------------------------------------------------------------

export const AUTH = {
  /**
   * Master switch for OTP-based authentication.
   *
   * When false:
   * - No login page is required; users go straight to the upload page.
   * - The API accepts requests without a JWT (authMiddleware passes through).
   * - No audit history is recorded (no email to associate with analyses).
   * - Email configuration (SMTP_USER/SMTP_PASS) is not required at startup.
   *
   * When true:
   * - Full OTP auth flow is enforced (email → OTP → JWT session).
   * - All analyses are logged with the authenticated user's email.
   * - Valid email provider credentials must be configured.
   *
   * SAFE TO CHANGE: Yes — flip to true once email delivery is configured
   * and you want to gate access behind OTP authentication.
   */
  REQUIRE_LOGIN: false,

  /**
   * How long a JWT session lasts, in hours.
   * After this, the user must re-authenticate via OTP.
   *
   * SAFE TO CHANGE: Yes. Shorter = more secure but more OTP emails.
   * 72 hours means users authenticate roughly once every 3 days.
   * Do not exceed 168 (7 days) for an internal tool handling documents.
   */
  JWT_EXPIRY_HOURS: 72,

  /**
   * How long an OTP code remains valid, in minutes.
   * After this, the OTP is rejected and the user must request a new one.
   *
   * SAFE TO CHANGE: Yes. 15 minutes gives users time to check email and
   * switch tabs. Don't go below 5 (email delivery can be slow) or above
   * 30 (increases the brute-force window).
   */
  OTP_EXPIRY_MINUTES: 15,

  /**
   * Maximum wrong OTP attempts before the code is invalidated.
   * After this many failures, the user must request a new OTP.
   *
   * SAFE TO CHANGE: Yes. 5 is generous for typos but still makes brute-force
   * impractical (5 guesses out of 1,000,000 combinations). Don't go above 10.
   */
  OTP_MAX_ATTEMPTS: 5,

  /**
   * Number of digits in the OTP code.
   *
   * DO NOT CHANGE unless you also update the OTP generation logic
   * (crypto.randomInt range), the email template formatting, and the
   * frontend input field. 6 digits is the industry standard for email OTPs.
   */
  OTP_LENGTH: 6,

  /**
   * Regex pattern for allowed email domains.
   * Only users with email addresses matching this pattern can authenticate.
   *
   * SAFE TO CHANGE: Yes — e.g., to add additional state domains. The regex
   * must be case-insensitive and anchor both sides. The current pattern
   * allows any subdomain of illinois.gov (e.g., icjia.illinois.gov,
   * dhs.illinois.gov, etc.).
   *
   * ALSO UPDATE: the .env ALLOWED_DOMAINS variable for development overrides.
   */
  ALLOWED_EMAIL_REGEX: /^[^@]+@([a-z0-9-]+\.)*illinois\.gov$/i,
} as const

// ---------------------------------------------------------------------------
// RATE LIMITS
// ---------------------------------------------------------------------------
// Per-endpoint rate limiting via express-rate-limit. Each limiter has a
// `max` (requests allowed) and `windowMs` (time window in milliseconds).
//
// The `key` for each limiter (email vs IP) is configured in rateLimiter.ts,
// not here — keys depend on request parsing logic, not just numbers.
//
// SAFE TO CHANGE: Yes for all values. Increase `max` if legitimate users
// are hitting limits; decrease if you see abuse. The in-memory store resets
// on server restart — this is fine for single-instance deployment.
// ---------------------------------------------------------------------------

export const RATE_LIMITS = {
  /** POST /api/auth/request — keyed by email address.
   *  Prevents an attacker from spamming OTP emails to a victim. */
  authRequest: { max: 5, windowMs: 60 * 60 * 1000 },       // 5 per hour

  /** POST /api/auth/verify — keyed by IP address.
   *  Prevents brute-forcing OTP codes from a single source. */
  authVerify: { max: 10, windowMs: 15 * 60 * 1000 },       // 10 per 15 min

  /** POST /api/analyze — keyed by email (from JWT).
   *  Prevents a single user from monopolizing analysis resources. */
  analyze: { max: 30, windowMs: 60 * 60 * 1000 },           // 30 per hour

  /** POST /api/reports — keyed by email (from JWT).
   *  Prevents a single user from filling the shared_reports table. */
  reports: { max: 10, windowMs: 60 * 60 * 1000 },           // 10 per hour

  /** All routes — keyed by IP address.
   *  Catch-all safety net against request floods. */
  global: { max: 100, windowMs: 60 * 1000 },                // 100 per minute
} as const

// ---------------------------------------------------------------------------
// SHARED REPORTS (Phase 2)
// ---------------------------------------------------------------------------

export const SHARED_REPORTS = {
  /**
   * Number of days before a shared report link expires.
   * After this, GET /api/reports/:id returns 404 and the row is eligible
   * for cleanup.
   *
   * SAFE TO CHANGE: Yes. Longer = more useful for recipients but more
   * database storage. 30 days balances utility with data hygiene.
   */
  EXPIRY_DAYS: 30,

  /**
   * Maximum size of the report JSON payload in bytes.
   * Enforced via express.json({ limit: ... }) on the reports route.
   * Prevents oversized payloads from inflating the SQLite database.
   *
   * SAFE TO CHANGE: Yes — 1MB accommodates reports with many findings.
   * Increase only if legitimate reports are being rejected (unlikely).
   */
  MAX_PAYLOAD_BYTES: 1 * 1024 * 1024, // 1MB
} as const

// ---------------------------------------------------------------------------
// BATCH QUEUE
// ---------------------------------------------------------------------------

export const BATCH_QUEUE = {
  /**
   * How long uploaded PDFs and queue items are retained.
   */
  RETENTION_DAYS: 30,

  /**
   * Initial number of history items loaded by the infinite-scroll UI.
   */
  INITIAL_PAGE_SIZE: 1000,

  /**
   * Maximum number of active processing jobs for a single browser client.
   */
    MAX_PARALLEL_PER_CLIENT: 5,

  /**
   * Long-lived browser session duration in days.
   */
  SESSION_DAYS: 180,

  /**
   * Auto-renew threshold for browser sessions in days.
   */
  AUTO_RENEW_THRESHOLD_DAYS: 30,

  /**
   * Time after which an unfinished upload placeholder is treated as stale.
   */
  STALE_UPLOAD_MINUTES: 60,
} as const

// ---------------------------------------------------------------------------
// BATCH UPLOAD (Phase 2)
// ---------------------------------------------------------------------------

export const BATCH = {
  /**
   * Maximum number of files in a single batch upload.
   * Files are processed sequentially server-side to avoid memory spikes.
   *
   * SAFE TO CHANGE: Yes — but more files = longer processing time.
   * At ~5–10 seconds per PDF, 10 files means up to 100 seconds of
   * sequential processing. Don't exceed 20 without also implementing
   * a background job queue.
   */
  MAX_FILES: 10,
} as const

// ---------------------------------------------------------------------------
// SCHEDULED CHECKS (Phase 3)
// ---------------------------------------------------------------------------

export const SCHEDULED_CHECKS = {
  /**
   * Maximum number of active scheduled checks across the entire instance.
   * Prevents runaway resource usage from the cron job that fetches URLs.
   *
   * SAFE TO CHANGE: Yes — increase if the tool needs to monitor more URLs.
   * Each check fetches a PDF and runs the full analysis pipeline, so the
   * cron job's runtime scales linearly with this number.
   */
  MAX_ACTIVE: 50,

  /**
   * How many consecutive HTTP failures (404, 410, timeout) before a
   * scheduled check is automatically marked inactive.
   *
   * SAFE TO CHANGE: Yes. Higher = more tolerant of temporary outages.
   * 3 means a URL must fail 3 weeks in a row (for weekly checks) before
   * being deactivated.
   */
  FAILURE_THRESHOLD: 3,

  /**
   * HTTP fetch timeout for downloading remote PDFs, in milliseconds.
   * Prevents slow-loris or unresponsive servers from tying up resources.
   *
   * SAFE TO CHANGE: Yes. 30 seconds is generous for most PDF downloads.
   */
  FETCH_TIMEOUT_MS: 30_000,
} as const

// ---------------------------------------------------------------------------
// FILENAME SANITIZATION
// ---------------------------------------------------------------------------

export const FILENAME = {
  /**
   * Maximum length for stored filenames (in the audit log and reports).
   * Longer filenames are truncated.
   *
   * SAFE TO CHANGE: Yes — 255 matches most filesystem limits.
   */
  MAX_LENGTH: 255,

  /**
   * Regex for allowed characters in stored filenames.
   * Characters NOT matching this pattern are replaced with underscores.
   * This prevents stored XSS when filenames are rendered in the admin UI.
   *
   * DO NOT CHANGE to allow angle brackets (< >), quotes, or ampersands
   * without also implementing HTML entity encoding in all UI templates
   * that render filenames.
   */
  ALLOWED_CHARS: /[a-zA-Z0-9._\-\s]/g,
} as const

// ---------------------------------------------------------------------------
// UI CONSTANTS
// ---------------------------------------------------------------------------
// Display values used by the Nuxt frontend. The API does not use these
// directly, but they are defined here so there is one place to update
// the app name or color palette.
// ---------------------------------------------------------------------------

export const UI = {
  /**
   * Dark mode color palette (used as CSS variable defaults in :root).
   * Light mode overrides are defined in apps/web/app/assets/css/main.css
   * under the html.light selector. The default mode is set by
   * BRANDING.DEFAULT_COLOR_MODE above.
   *
   * SAFE TO CHANGE: Yes — these are CSS hex colors. Update to match
   * your agency's brand guidelines if needed.
   */
  COLORS: {
    background: '#0a0a0a',
    surface: '#111111',
    border: '#222222',
    text: '#f5f5f5',
  },

  /**
   * Number of items per page in paginated views (audit log, my-history).
   *
   * SAFE TO CHANGE: Yes — purely a UX preference.
   */
  DEFAULT_PAGE_SIZE: 20,

  /**
   * Maximum page size a client can request via ?limit= query parameter.
   * Prevents clients from requesting the entire table in one query.
   *
   * SAFE TO CHANGE: Yes — but keep it reasonable (100–200 max).
   */
  MAX_PAGE_SIZE: 100,
} as const
