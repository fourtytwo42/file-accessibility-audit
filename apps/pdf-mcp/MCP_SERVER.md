# PDF MCP server (`pdf-mcp`)

This document describes the **pdfaf PDF MCP server**: what it does, how to install it, how to wire it into Cursor (or another MCP client), and how to use it safely.

## What it is

- A **Model Context Protocol (stdio)** server that exposes tools for:
  - **Analyzing** PDFs (scores, grades, VeraPDF-related signals, local standards, categories—same pipeline as `apps/api`).
  - **Repairing** PDFs by applying **individual remediation tools** (`set_document_title`, `embed_missing_fonts_in_place`, `repair_structure_conformance`, …) that map to `executeRemediationTool` in the API.
- The **host LLM** (e.g. Cursor) decides **which** tool to call and **with what arguments**; the server does not run the long internal agent loop unless you use the separate CLI scripts.

**Implementation:** [`apps/pdf-mcp/src/index.ts`](src/index.ts), [`registerTools.ts`](src/registerTools.ts). It imports [`apps/api`](../api) services directly (same Python `pdf_structure_helper.py`, qpdf, pdfjs, etc.).

## Prerequisites

| Requirement | Notes |
|-------------|--------|
| **Node.js** | 18+ |
| **pnpm** | Monorepo uses `pnpm`; install from repo root. |
| **Repo clone** | Server must run with `cwd` set to the **repository root** so `pnpm --filter pdf-mcp` and API paths resolve. |
| **qpdf** | Used by analysis; install per your OS. |
| **Python 3** | For `apps/api/scripts/pdf_structure_helper.py`. Override binary with `PYTHON_PATH` if needed. |
| **VeraPDF** (optional) | For full standards validation when `pdf_analyze` does not skip it. |
| **Adobe PDF Services** (optional) | Controlled by API `REMEDIATION` / `.env`; not required for many flows. |

Operational context for Strapi / bulk workflows lives in the root [`AGENTS.md`](../../AGENTS.md).

## Installation

1. Clone the repo and enter it:

   ```bash
   cd /path/to/pdfaf
   ```

2. Install dependencies (installs `pdf-mcp` with the rest of the workspace):

   ```bash
   pnpm install
   ```

3. Ensure API environment is configured if you rely on Adobe or custom paths:

   - Copy or edit **`.env`** at the repo root and/or **`apps/api/.env`** as you do for the API.  
   The MCP process loads both (see [`src/index.ts`](src/index.ts)).

No separate global `npm install -g` is required.

## Running the server (stdio)

From the **repository root**:

```bash
pnpm --filter pdf-mcp start
```

Equivalent:

```bash
cd apps/pdf-mcp && pnpm exec tsx src/index.ts
```

The process reads JSON-RPC messages on **stdin** and writes responses on **stdout**. Do not pipe unrelated data into it; use an MCP-aware client (Cursor, Claude Desktop, MCP Inspector, etc.).

## Using with Cursor

1. Open **Cursor Settings → MCP** (or edit your MCP config JSON, depending on Cursor version).

2. Add a server definition. **Replace** `/absolute/path/to/pdfaf` with your real repo path:

   ```json
   {
     "mcpServers": {
       "pdfaf-pdf": {
         "command": "pnpm",
         "args": ["--filter", "pdf-mcp", "exec", "tsx", "src/index.ts"],
         "cwd": "/absolute/path/to/pdfaf"
       }
     }
   }
   ```

3. Restart MCP / reload the window if the client requires it.

4. In chat, enable the **pdfaf-pdf** tools and follow the workflow below.

A copy-paste example also lives in [`mcp.config.example.json`](mcp.config.example.json).

### Other clients

Any MCP client that supports **stdio** transport can spawn the same `command` / `args` / `cwd`. For **Claude Desktop**, the same JSON shape is typically under the user’s Claude config; adjust paths for your machine.

## Recommended workflow

1. **`pdf_open`**  
   - Provide exactly one of:
     - `path`: file on disk (must be under the [path allowlist](#path-allowlist-and-security)).
     - `base64`: raw PDF bytes (no path check on content).  
   - Always set `filename` (logical name for logs/analysis).  
   - Response includes `sessionId`, `byteSize`, `sha256`.

2. **`pdf_analyze`**  
   - Pass `sessionId`.  
   - Optional: `full: true` for the full analysis object (large).  
   - Optional: `skipVeraPdf: true` / `skipAdobe: true` for faster iteration when you accept less validation.  
   - Optional: `analysisProfile`: `"full_final"` (default) or `"remediation_fast"`.

3. **`pdf_inspect`**  
   - Requires a successful **`pdf_analyze`** on that session first.  
   - Returns candidates (figures, headings, tables, links, etc.) and structure/qpdf summaries (trimmed for size).

4. **`pdf_list_remediation_tools`**  
   - Lists every valid `tool_name` for **`pdf_apply_tool`**.

5. **`pdf_apply_tool`**  
   - `sessionId`, `tool_name`, `arguments` (object, tool-specific).  
   - Optional: `rationale`, `confidence` (0–1).  
   - After a **successful mutation**, treat **candidate ids as stale** until you re-run **`pdf_analyze`** and **`pdf_inspect`**.

6. **`pdf_undo`** (optional)  
   - Reverts the buffer to before the last `pdf_apply_tool` (stack depth capped by `PDF_MCP_MAX_UNDO`).

7. **`pdf_write`**  
   - Writes the current session buffer to an **allowlisted** output path.

8. **`pdf_close`**  
   - Drops the session from memory.

9. **`pdf_session_info`**  
   - Quick status: size, hash, whether analysis is loaded, action log length.

### Important behavior

- **Mutations invalidate** cached inspection context; the server clears analysis after document-changing applies so the next `pdf_analyze` reflects the new bytes.
- **Passing** (grade **A**, score **100**, no blocking local findings, etc.) is defined by the same promotion logic as the rest of the repo—see `evaluatePromotionGate` in the API. Real-world PDFs often need **many** tool calls; do not expect one-shot fixes on complex legacy files.

## Tool reference (summary)

| Tool | Arguments (main) | Notes |
|------|------------------|--------|
| `pdf_open` | `filename`, and `path` **or** `base64` | Creates session. |
| `pdf_close` | `sessionId` | |
| `pdf_analyze` | `sessionId`, optional `full`, `skipVeraPdf`, `skipAdobe`, `analysisProfile` | Can be slow (full pipeline). |
| `pdf_inspect` | `sessionId` | Needs prior `pdf_analyze`. |
| `pdf_apply_tool` | `sessionId`, `tool_name`, optional `arguments`, `rationale`, `confidence` | Core mutation primitive. |
| `pdf_undo` | `sessionId` | |
| `pdf_write` | `sessionId`, `path` | Output path must be allowlisted. |
| `pdf_list_remediation_tools` | (none) | |
| `pdf_session_info` | `sessionId` | |

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PDF_MCP_ALLOW_PATHS` | _(empty)_ | Extra directory roots allowed for `pdf_open` / `pdf_write`, separated by the OS path delimiter (`:` on Linux/macOS). |
| `PDF_MCP_MAX_BYTES` | `83886080` (~80 MiB) | Maximum PDF size per session. |
| `PDF_MCP_MAX_SESSIONS` | `16` | Maximum concurrent open sessions. |
| `PDF_MCP_MAX_UNDO` | `8` | Undo stack depth per session (max 32 enforced in code). |
| `PYTHON_PATH` | `python` | Python executable for the structure helper. |

`.env` loading: repo root and `apps/api/.env` (same as the API).

## Path allowlist and security

- Opening or writing files by path is allowed only if the resolved real path is under:
  - the **repository root**, or  
  - **`$HOME`** (or `USERPROFILE` on Windows), or  
  - any root listed in **`PDF_MCP_ALLOW_PATHS`**.
- **`pdf_open` with `base64`** bypasses path checks on input (size limit still applies). **`pdf_write`** always requires an allowed path.
- The server does **not** run arbitrary shell commands; mutations go through fixed API/Python entrypoints.

## Performance and timeouts

- **`pdf_analyze`** with full profile, VeraPDF, and structure scoring can take **tens of seconds to minutes** on large PDFs.
- Cursor or other clients may impose their own **tool timeouts**; if calls abort, try smaller PDFs, `skipVeraPdf: true`, or `remediation_fast` where appropriate.
- The MCP server does not yet expose a separate timeout knob per tool; long runs are governed by the API and OS.

## Troubleshooting

| Symptom | Things to check |
|---------|------------------|
| `Path not allowed` | Put files under repo, home, or set `PDF_MCP_ALLOW_PATHS`. |
| `Unknown sessionId` | Session expired or never created; call `pdf_open` again. |
| `Call pdf_analyze before pdf_inspect` | Run `pdf_analyze` after `pdf_open`. |
| `Unknown tool_name` | Call `pdf_list_remediation_tools`; use exact names. |
| Python / structure errors | `PYTHON_PATH`, venv, and `apps/api/scripts/pdf_structure_helper.py` dependencies. |
| qpdf / VeraPDF errors | Install binaries; see API docs and `AGENTS.md`. |
| MCP not connecting | `cwd` must be repo root; `pnpm install` done; Node/pnpm on PATH for the spawned process. |

## Tests and CLI helpers

```bash
pnpm --filter pdf-mcp test
pnpm --filter pdf-mcp typecheck
```

Scripts that mirror MCP primitives without an MCP client (see [`README.md`](README.md)):

- `scripts/demo-mcp-style-fix.ts` — fixed batch of remediation tools.
- `scripts/run-agent-to-pass.ts` — full `remediatePdfWithAgent` loop.
- `scripts/verify-gate.ts` — `analyzePDF` + promotion gate only.

## Related files

| File | Role |
|------|------|
| [`README.md`](README.md) | Short package overview + links. |
| [`mcp.config.example.json`](mcp.config.example.json) | Example Cursor/MCP JSON snippet. |
| [`package.json`](package.json) | Scripts and dependencies. |
| [`../../AGENTS.md`](../../AGENTS.md) | Agency PDF workflows (separate from MCP). |
