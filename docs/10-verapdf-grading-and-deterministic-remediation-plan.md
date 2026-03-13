# veraPDF Grading + Deterministic Remediation Plan
# + Next.js Frontend Rebuild

## Summary

This plan covers three related efforts:

1. Make `veraPDF` a first-class part of scoring and grading, instead of only a coarse grade cap.
2. Move remediation planning to a deterministic failure-profile router, with AI used only for semantic inference.
3. Replace the Nuxt/Vue frontend with a Next.js + Tailwind v4 application built mobile-first with a paginated PDF card system, rich PDF detail pages, and non-blocking real-time state.

Each section is intentionally sliced so the repo stays shippable after each phase. Backend grading and scoring corrections happen first, then frontend infrastructure, then full UI.

---

## Goals

- Make the numeric score, letter grade, and `veraPDF` status coherent.
- Ensure `100/100` and grade `A` require passing `veraPDF`.
- Use `veraPDF` failures and internal category failures as structured repair inputs.
- Replace AI-led tool selection with deterministic routing for safe native repairs.
- Preserve AI only for semantic tasks: heading levels, alt text wording, ambiguous table/link intent.
- Replace the Nuxt queue UI with a Next.js paginated card system that is fast, mobile-first, and non-blocking.
- Give each PDF a dedicated detail page with grade breakdown, version history, and controls.
- Let users sort, filter, multi-select, and bulk-act on PDFs from the main page.
- Ensure the frontend always reflects DB state even when the backend is busy.

## Non-Goals

- No return to HTML rebuilds or mixed reconstruction paths.
- No attempt to make every `veraPDF` rule individually user-facing in v1.
- No breaking changes to the backend API beyond additive fields and the new status endpoint.

---

## Current State

- `scorer.ts` computes category-weighted `overallScore`, then separately caps the grade based on `veraPDF`.
- `remediationPlanService.ts` already has substantial heuristics, but AI still acts as the planner.
- `veraPdfService.ts` already maps failures to category ids.
- Queue/API payloads expose `overallScore`, `grade`, and `verapdf`, but not a first-class failure profile.
- Frontend is a Nuxt 4 / Vue 3 app with a two-tab (active queue / history) layout.
- Queue composable (`useClientQueue.ts`, ~1018 lines) drives all state with XHR uploads and SSE.
- Icons are inline SVGs. `@nuxt/ui` + Tailwind v4 are already present.
- API base (`apps/api`) is Express + better-sqlite3 with a well-defined REST surface.

## Target End State

### Backend

- Grading uses category scores plus a dedicated `PDF/UA Compliance` score derived from `veraPDF`.
- `A` requires `veraPDF.status === 'passed'`.
- `100/100` is only possible when `veraPDF` passes.
- Each analyzed/remediated PDF has an internal failure profile that drives deterministic repair selection.
- A new `GET /api/queue/status` endpoint returns the full current state from the DB for frontend hydration.
- Queue item detail payloads carry: grade basis summary, `veraPDF` status and failure count, grouped failure modes, remediation planner summary.

### Frontend (new Next.js app at `apps/web`)

- Single-page layout: compact drag-and-drop upload zone at the top, paginated compact PDF card grid below.
- Sort/filter toolbar above the grid (name, grade A–F, issue type, status, date).
- Checkbox multi-select on cards, with a sticky bulk-action bar that appears on selection.
- Each card shows: filename, current grade badge, status chip, score, top issue hint, quick-action icons.
- Clicking a card navigates to `/pdf/[id]` — a full PDF detail page.
- PDF detail page: grade breakdown by category, `veraPDF` pass/fail block, grouped failure modes, version history with download for each version, controls to re-run, re-analyze, or delete.
- Dark/light mode toggle preserved. New color scheme. Mobile-first layout at all breakpoints.
- Frontend fetches from backend API; falls back to DB-backed `GET /api/queue/status` so it always has current state regardless of in-flight work.
- All uploads non-blocking (XHR with progress); SSE stream pushes state changes.

---

## Slice 1: Unify Score, Grade, and veraPDF

### Goal

Fix the grading model first so backend results and frontend display stop contradicting each other.

### Backend changes

- Update `apps/api/src/services/scorer.ts` to add a dedicated `pdf_ua_compliance` category derived from `veraPDF`.
- Keep existing category-mapping penalties from `veraPDF`, but also include a direct standards score contribution.
- Make `A` require `verapdf.status === 'passed'`.
- Prevent `overallScore` from remaining `100` when `veraPDF` still fails.
- Replace the current coarse grade-cap-only behavior with a single coherent score/grade policy.
- Extend the executive summary so it explains:
  - whether `veraPDF` passed
  - whether standards findings reduced the score
  - whether the document is close to compliant vs materially non-compliant

### API/data changes

- Ensure the returned `AnalysisResult` contains the new category in `categories`.
- Preserve backward compatibility for existing `overallScore`, `grade`, and `verapdf` fields.

### Acceptance criteria

- No PDF can return `overallScore = 100` unless `veraPDF` passes.
- No PDF can return grade `A` unless `veraPDF` passes.
- A near-complete PDF with a few `veraPDF` failures shows meaningful progress, not just a hard cap with no explanation.

---

## Slice 2: Introduce a Failure Profile

### Goal

Create a single internal representation of what is wrong with the PDF and what can be repaired safely.

### Backend changes

- Add a new failure-profile builder service that combines:
  - category failures from `AnalysisResult`
  - grouped `veraPDF` failures
  - native inspection findings from `PdfRemediationContext`
  - candidate inventories for headings, figures, tables, links, reading order, forms, fonts, and metadata
  - prior attempted, rejected, and no-effect actions
- Normalize `veraPDF` failures into grouped failure modes with:
  - stable key
  - count
  - mapped categories
  - blocking/unmatched status
  - suggested native tool families
- Produce normalized tool opportunities with:
  - tool name
  - reason
  - candidate ids or target scope
  - confidence
  - blocked/deferred reason when not auto-runnable

### Model persistence

- Extend the document model to persist a failure-profile snapshot and planner evidence.
- Keep this internal/server-side in v1; do not expose it broadly in the public UI yet.

### Acceptance criteria

- For any analyzed/remediated PDF, the backend can explain:
  - top failure modes
  - why a tool was selected
  - why a tool was skipped
  - which issues are deterministic vs semantic/manual

---

## Slice 3: Make Remediation Planning Deterministic-First

### Goal

Use the failure profile to choose native repair actions directly, without asking AI to plan repairs.

### Backend changes

- Refactor `apps/api/src/services/remediationPlanService.ts` so the primary plan comes from deterministic routing rules built on the failure profile.
- Remove the AI planner from the normal remediation path, or leave it only as an inactive fallback behind a flag.
- Convert the existing heuristic logic into structured routing stages:
  1. metadata and PDF/UA identification
  2. structure bootstrap and conformance repairs
  3. link structure and annotation repairs
  4. font embedding / Unicode / CID / width / substitution flow
  5. native figure, table, and reading-order repairs
  6. safe candidate-level repairs
  7. semantic deferrals for AI
- Suppress retries for:
  - already attempted tools
  - rejected actions
  - no-effect actions
  - unsafe candidates

### AI scope after this slice

- Keep AI only for semantic enrichment:
  - heading level inference
  - figure alt text generation
  - decorative vs informative decision
  - ambiguous table header intent
  - ambiguous link wording

### Acceptance criteria

- Native structure/font/metadata/link repairs are selected without AI involvement.
- Planner output is stable and explainable from the failure profile alone.
- Easy PDFs move faster because no planner-model round trip is needed.

---

## Slice 4: Expose Failure Modes and Standards-Aware Grading Through Queue/API

### Goal

Get the new grading model and failure profile into the queue/detail payloads cleanly, and add a DB-backed status endpoint for frontend hydration.

### API/data changes

- Extend queue serialization to expose a compact standards/failure summary for active and completed items:
  - grade basis summary
  - `veraPDF` status and failed check count
  - whether grade was reduced by standards findings
  - top grouped failure modes
  - remediation planner summary counts
- Add `GET /api/queue/status` — returns complete item list from DB (active + history) sorted by updated_at desc. This is the frontend's fallback source of truth when SSE reconnects or the browser refreshes.
- Add `GET /api/queue/items/:id/versions` — returns list of all stored versions (original + each remediated artifact) with timestamps, grades, and download URLs.
- Preserve current queue payload compatibility while adding new optional fields.

### Queue/detail model changes

- Update `queueStore` serialization and report/detail loaders so the frontend can render:
  - original vs remediated standards burden
  - grouped failure modes
  - deterministic vs semantic/manual status

### Acceptance criteria

- Queue item details can explain why a document is still `C` or `manual_review_required`.
- `GET /api/queue/status` returns a stable, DB-accurate snapshot within 200ms.
- The frontend can fully reconstruct its state from this endpoint on cold load or SSE reconnect.

---

## Slice 5: Next.js Frontend Rebuild

### Goal

Replace the Nuxt/Vue frontend (`apps/web`) with a Next.js + Tailwind v4 application built mobile-first. Preserve all existing API contracts. Deliver a significantly better UX with paginated cards, a rich PDF detail page, bulk actions, and always-responsive non-blocking UI.

### Technology choices

| Concern | Choice | Reason |
|---|---|---|
| Framework | Next.js 15 App Router | File-based routing, React Server Components, strong ecosystem |
| Styling | Tailwind CSS v4 | Already in repo; v4 CSS-first config; works well with Next.js |
| Icons | Inline SVG components | Matches existing approach; no extra bundle |
| State / fetching | SWR | Lightweight, stale-while-revalidate, SSE-friendly revalidation |
| Uploads | XHR with progress | Matches current implementation; non-blocking |
| Real-time | SSE via `EventSource` | Matches existing `/api/queue/events` endpoint |
| Auth | Cookie-based JWT | No change to backend auth |
| Color mode | `next-themes` | Drop-in dark/light toggle |
| Testing | Vitest + React Testing Library | Familiar pattern |

### New file structure

```
apps/web/
├── app/
│   ├── layout.tsx                  # Root layout: theme provider, header, footer
│   ├── page.tsx                    # Main page: upload zone + paginated PDF grid
│   ├── pdf/
│   │   └── [id]/
│   │       └── page.tsx            # PDF detail page
│   ├── login/
│   │   └── page.tsx                # OTP login (no layout)
│   ├── report/
│   │   └── [id]/
│   │       └── page.tsx            # Shareable public report view
│   └── api/                        # Next.js API proxy routes (optional thin wrappers)
├── components/
│   ├── layout/
│   │   ├── Header.tsx
│   │   └── Footer.tsx
│   ├── upload/
│   │   └── DropZone.tsx            # Drag-drop, click-to-pick, folder traversal
│   ├── grid/
│   │   ├── PdfGrid.tsx             # Paginated card grid with virtualization
│   │   ├── PdfCard.tsx             # Compact card per PDF
│   │   ├── FilterBar.tsx           # Sort/filter/search toolbar
│   │   └── BulkActionBar.tsx       # Sticky bar shown when cards are selected
│   ├── detail/
│   │   ├── GradePanel.tsx          # Score + grade breakdown
│   │   ├── VeraPdfPanel.tsx        # veraPDF pass/fail + failure list
│   │   ├── FailureModeList.tsx     # Grouped failure modes in plain language
│   │   ├── VersionHistory.tsx      # Version list with download buttons
│   │   └── DetailControls.tsx      # Re-run, re-analyze, delete, download
│   ├── shared/
│   │   ├── GradeBadge.tsx          # Color-coded A–F badge
│   │   ├── StatusChip.tsx          # uploading/queued/processing/complete/failed
│   │   ├── ProgressBar.tsx
│   │   ├── ScoreBar.tsx
│   │   └── CategoryRow.tsx         # Collapsible category with findings
│   └── icons/
│       └── index.tsx               # Named exports for all inline SVG icons
├── hooks/
│   ├── usePdfList.ts               # SWR hook: paginated PDF list + filter/sort
│   ├── usePdfDetail.ts             # SWR hook: single PDF detail
│   ├── useUploadQueue.ts           # XHR upload state, progress, abort
│   ├── useQueueEvents.ts           # SSE subscription + SWR revalidation trigger
│   └── useSelection.ts             # Multi-select state and bulk action helpers
├── lib/
│   ├── api.ts                      # Typed fetch wrappers for all backend endpoints
│   ├── gradeColors.ts              # Grade → color/label mapping
│   └── formatters.ts               # Score, date, filesize formatters
├── middleware.ts                   # Auth redirect
├── next.config.ts
├── tailwind.css                    # Tailwind v4 CSS entry (replaces tailwind.config.js)
└── package.json
```

### Main page (`/`)

**Layout** (mobile-first):
- Full-width drop zone at the top. Compact by default (~80px tall); expands with a dashed border and upload icon on drag-over. Accepts PDFs up to 100 MB each, folder drops, multi-file picks.
- Below the drop zone: a sticky `FilterBar` with sort (name, grade, date, score), filter by grade (A–F chips), filter by status (complete, processing, failed), and a text search by filename. On mobile these collapse into a single "Filter & Sort" button that opens a bottom sheet.
- Below the filter bar: a responsive card grid. On mobile: 1 column. Tablet: 2 columns. Desktop: 3–4 columns. Cards are compact — no expanded details on the main page.
- When one or more cards are selected, a sticky `BulkActionBar` appears at the bottom of the screen (above the footer) with actions: Fix selected, Re-analyze, Download (zip), Delete. Counts shown inline.
- Pagination controls at the bottom: previous / next page, items per page selector (25, 50, 100), total count.
- Empty state: friendly illustration + "Drop PDFs here to get started."

**PdfCard (compact)**:
```
┌─────────────────────────────────────────┐
│ ☐  filename.pdf               [A] 98/100 │
│    processing...  ████████░░  80%        │
│    Top issue: Font embedding missing     │
│                      [↓] [↺] [⋮]         │
└─────────────────────────────────────────┘
```
- Checkbox top-left for selection.
- Filename (truncated with tooltip).
- Grade badge top-right (color-coded A–F).
- Score `/100`.
- Status chip (uploading / queued / processing / complete / failed).
- Progress bar while uploading or processing.
- Top issue hint (one line, from failure profile or executive summary).
- Quick-action icon row: download remediated, retry/re-run, overflow menu (delete, download original, share report).
- Entire card is clickable → navigates to `/pdf/[id]`.
- Selection highlight (ring + checkbox check) on select.
- Cards animate in on addition (`opacity 0→1`, `translateY`).

**FilterBar controls**:
- Search input (debounced 300ms, filters by filename client-side on current page).
- Sort by: Name A–Z, Name Z–A, Grade (best first), Grade (worst first), Date (newest), Date (oldest), Score (high–low), Score (low–high).
- Filter chips: All / A / B / C / D / F grades; All / Complete / Processing / Failed statuses.
- "Select all on page" checkbox.
- Item count display: "Showing 1–25 of 143 PDFs".

**BulkActionBar** (sticky bottom, appears on selection):
- "X selected" count.
- Fix all (trigger remediation for all selected).
- Re-analyze (re-run analysis without remediation).
- Download (zip and download all selected — original or remediated toggle).
- Delete.
- Deselect all.

### PDF detail page (`/pdf/[id]`)

**Layout** (mobile-first, single column; two-column on desktop with sidebar):

Left / main column:
- Back navigation: "← All PDFs".
- Filename as page heading.
- Status chip + last updated timestamp.
- `GradePanel`: large grade circle, score/100, executive summary paragraph, "veraPDF cap" explanation if grade was capped.
- `VeraPdfPanel`: pass/fail banner, failure count, top failing checks grouped by category with plain-language labels.
- `FailureModeList`: grouped failure modes (logical structure, link tagging, table headers, alt text, font compliance, metadata/PDF-UA identification). Each shows: issue description, auto-fixable / awaiting AI / manual-review-only status badge, estimated impact.
- `CategoryRow` list (collapsible, same as current implementation): per-category score bar, grade circle, findings list with severity badges.

Right / sidebar:
- `DetailControls`:
  - Run remediation (primary button)
  - Re-analyze only
  - Download remediated PDF
  - Download original PDF
  - Download report (JSON / Markdown / Word)
  - Delete this PDF
  - Share report link
- `VersionHistory`:
  - List of all versions with timestamp, grade, score, what changed (e.g. "Remediation pass 2 — font fixes applied").
  - Download button for each version.
  - Currently active version is highlighted.

On mobile: sidebar collapses to a sticky controls strip at the bottom + a "History" tab below the main content.

### Theming and styling

- **Tailwind v4** CSS-first config (`tailwind.css` replaces `tailwind.config.js`).
- CSS custom properties for surfaces, text, and accents — same dual-mode approach as current, but new values:
  - Dark: near-black surfaces (`#09090b`, `#18181b`, `#27272a`), zinc-based palette.
  - Light: white/gray surfaces (`#fafafa`, `#ffffff`, `#f4f4f5`).
  - Accent: keep green (`#22c55e`) for A grade / pass; keep grade color scale.
- Grade colors unchanged: A=#22c55e, B=#14b8a6, C=#eab308, D=#f97316, F=#ef4444.
- `next-themes` for toggle; `class` strategy so Tailwind `dark:` variants work.
- Typography: system font stack; no external font load.
- All interactive elements meet WCAG 2.1 AA contrast in both modes.

### Real-time and non-blocking behavior

- On page load, fetch `GET /api/queue/status` (DB snapshot) immediately — renders the grid before SSE connects.
- Open SSE connection to `GET /api/queue/events`. On each event, call `mutate()` on the relevant SWR keys to trigger a background refetch. The grid never blocks on SSE.
- If SSE disconnects, SWR's `refreshInterval` (every 5s while page is visible) keeps data fresh.
- XHR uploads run in `useUploadQueue`. Upload progress is local state only; completion triggers an SSE event which refreshes the grid.
- The detail page polls `GET /api/queue/items/:id` every 3s while the item is in a non-terminal state (`processing`, `queued`), and stops polling once `complete` or `failed`.
- No action blocks the UI thread. All state changes are optimistic where safe (e.g. delete removes the card immediately; a failed delete re-adds it).

### Auth

- Middleware redirects unauthenticated requests to `/login`.
- OTP login flow identical to current: enter email → receive code → verify.
- JWT stored as HTTP-only cookie; forwarded automatically by Next.js.
- `GET /api/auth/config` checked on first load to determine if login is required.

### Bulk actions

- **Fix selected**: `POST /api/queue/remediate-many` with selected ids. Items transition to `processing`. Grid updates via SSE.
- **Re-analyze**: `POST /api/queue/reanalyze-many`. Same flow.
- **Download zip**: `POST /api/queue/download-many` with ids + version flag (`original` | `remediated`). Backend streams a zip; browser downloads it.
- **Delete**: `POST /api/queue/delete-many`. Optimistic removal from grid; server confirms.

### Migration

- `apps/web` directory is replaced. New Next.js project created there.
- All existing backend API endpoints are consumed unchanged.
- No change to `apps/api`.
- Shared TypeScript types for API responses extracted to `packages/shared-types` (or duplicated temporarily and cleaned up later).
- Existing test suite for backend is unaffected. Frontend tests are rewritten in Vitest + React Testing Library.

### Acceptance criteria

- Main page loads and shows all PDFs from `GET /api/queue/status` within 500ms on a local network.
- Drag-and-drop upload works on mobile (touch events) and desktop.
- Sort, filter, and search operate on the current page without a network round-trip.
- Selecting 20 PDFs and clicking "Download" produces a correct zip.
- PDF detail page shows all versions with working download links.
- Dark/light toggle works with no flash of incorrect theme.
- All interactive elements are keyboard-navigable and ARIA-labeled.
- SSE disconnect does not freeze the UI; the grid continues updating via polling fallback.

---

## Cross-Slice Guardrails

- Keep remediation native-only.
- Keep semantic AI best-effort and non-fatal.
- Do not let frontend grading logic drift from backend grading logic; frontend should render backend-derived meaning, not reproduce scoring rules independently.
- Prefer additive API changes before removing legacy fields.
- The new frontend must consume the same API endpoints as the old frontend. No frontend-specific backend changes except `GET /api/queue/status` and `GET /api/queue/items/:id/versions`.

---

## Testing Strategy

### Backend

- `scorer.ts` tests: `A` requires `veraPDF` pass; `100` requires `veraPDF` pass; standards-aware scoring for pass, near-pass, heavy-failure cases.
- Failure-profile tests: grouped failure modes, tool opportunity generation, blocked/deferred reasons.
- Remediation planner tests: deterministic routing by failure mode, suppression of repeated/no-effect/rejected tools, semantic-only deferral behavior.
- Queue/API serialization tests: new failure/standards summary fields present and correct.
- `GET /api/queue/status`: returns consistent state matching DB within 200ms.
- `GET /api/queue/items/:id/versions`: returns correct version list.

### Frontend (new Next.js app)

- Component tests: `PdfCard`, `GradeBadge`, `StatusChip`, `FilterBar`, `BulkActionBar`, `GradePanel`, `VeraPdfPanel`, `VersionHistory`.
- Hook tests: `usePdfList` pagination/filter/sort logic; `useSelection` bulk-select logic; `useUploadQueue` progress/abort.
- Integration tests: SSE event → SWR revalidation → grid update flow.
- Accessibility: each interactive component passes `axe` checks.
- Mobile layout: viewport tests at 375px, 768px, 1280px.

### End-to-end spot checks

- Fully compliant PDF: upload → grade A → detail page shows veraPDF pass.
- Near-compliant PDF: upload → grade B/C → veraPDF cap explanation visible → remediate → grade improves.
- Font-problem PDF: grouped failure mode "Font compliance" shown; deterministic fix applied; version history shows before/after.
- Bulk: select 5 PDFs → Fix all → all transition to processing → SSE updates cards in real time.
- Mobile: entire flow (drop, view, filter, select, bulk download) works at 375px.

---

## Suggested Delivery Order

1. **Slice 1** — Unify score, grade, veraPDF (backend only; no frontend risk).
2. **Slice 4 backend** — Add `GET /api/queue/status` and `GET /api/queue/items/:id/versions`; extend queue payloads.
3. **Slice 5** — Next.js frontend rebuild (can start in parallel with Slices 2–3 once API shape is stable).
4. **Slice 2** — Failure profile (backend; surfaced by frontend once built).
5. **Slice 3** — Deterministic planner swap (purely internal; transparent to frontend).

---

## Defaults Chosen

- `veraPDF` becomes part of the score, not just a post-score cap.
- Grade `A` and score `100` both require passing `veraPDF`.
- Failure profiles are persisted in the document model first, then surfaced through the queue detail payload.
- Remediation planning becomes deterministic-first.
- AI remains only for semantic enrichment, not general repair planning.
- Frontend is Next.js 15 App Router with Tailwind v4 and SWR, mobile-first.
- Paginated card grid replaces the two-tab queue/history layout.
- Every PDF gets a dedicated detail page at `/pdf/[id]`.
- DB-backed `GET /api/queue/status` ensures frontend can always hydrate from a stable snapshot.
- SSE + SWR polling fallback ensures the UI is never blocked by backend activity.
