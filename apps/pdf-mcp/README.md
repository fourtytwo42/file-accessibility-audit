# pdf-mcp

MCP server for **PDF analysis and low-level remediation** using the same stack as `apps/api` (`analyzePDF`, `inspectPdfForRemediation`, `executeRemediationTool`, Python `pdf_structure_helper.py`). The **host LLM** chooses which remediation tools to run instead of the in-repo agent loop.

**Full guide (install, Cursor setup, tools, env, troubleshooting):** [MCP_SERVER.md](./MCP_SERVER.md)

## Requirements

- Node 18+
- pnpm (monorepo root install)
- Same tooling as the API: `qpdf`, Python 3 for `apps/api/scripts/pdf_structure_helper.py`, optional VeraPDF CLI, optional Adobe API (see root `AGENTS.md` / API `.env`)

## Install

From repository root:

```bash
pnpm install
```

## Run (stdio)

```bash
pnpm --filter pdf-mcp start
```

Or:

```bash
cd apps/pdf-mcp && pnpm exec tsx src/index.ts
```

## Cursor / MCP client

Add a server entry (paths are examples—use your absolute repo path):

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

See also [mcp.config.example.json](mcp.config.example.json).

## Tools

| Tool | Purpose |
|------|---------|
| `pdf_open` | Load PDF from allowlisted `path` or `base64`; returns `sessionId`. |
| `pdf_close` | Drop session. |
| `pdf_analyze` | Full analysis pipeline; set `skipVeraPdf: true` for faster iteration when acceptable. |
| `pdf_inspect` | Remediation context (figures, headings, tables, links, structure summary). Requires `pdf_analyze` first. |
| `pdf_apply_tool` | Run one remediation tool (`tool_name` + `arguments`). See `pdf_list_remediation_tools`. |
| `pdf_undo` | Restore buffer before last `pdf_apply_tool` (stack depth `PDF_MCP_MAX_UNDO`, default 8). |
| `pdf_write` | Write current buffer to an allowlisted path. |
| `pdf_list_remediation_tools` | All valid `tool_name` values. |
| `pdf_session_info` | Size, hash, whether analysis is loaded. |

After **any mutation** that applies changes, call **`pdf_analyze` and `pdf_inspect` again** before trusting previous candidate ids.

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `PDF_MCP_ALLOW_PATHS` | (empty) | Extra allowlist roots, separated by `path.delimiter` (`:` on Unix). |
| `PDF_MCP_MAX_BYTES` | `83886080` | Max PDF size (bytes) per session. |
| `PDF_MCP_MAX_SESSIONS` | `16` | Open sessions cap. |
| `PDF_MCP_MAX_UNDO` | `8` | Undo stack depth per session. |
| `PYTHON_PATH` | `python` | Python for structure helper (inherited from API). |
| `MANUAL_MCP_STRUCTURE_MAX_PAGES` | `240` | `run-manual-mcp-batch`: run `bootstrap_struct_tree` + native structure repairs when page count ≤ this and structure/figure/untagged-image blockers are present. |
| `MANUAL_MCP_MAX_FIGURE_OPS` | `48` | Cap on per-publication figure `pdf_apply_tool` calls (iterative; skips candidates that return `no_effect`). |
| `MANUAL_MCP_MIN_OVERALL_SCORE` | `90` | Manual MCP “pass”: overall score ≥ this, not scanned, no critical manual-review flags (blocking locals may remain). Set `MANUAL_MCP_STRICT_PROMOTION_GATE=1` for full grade A / 100 gate instead. |
| `MANUAL_MCP_STRICT_PROMOTION_GATE` | _(unset)_ | If `1`/`true`/`yes`, manual MCP batch uses the same strict promotion gate as replacement verification (A, 100, no blocking locals). |

Paths are allowed if they resolve under **repository root**, **`$HOME`**, or any `PDF_MCP_ALLOW_PATHS` entry.

`.env` is loaded from the repo root and `apps/api/.env` (same as the API).

## Tests

```bash
pnpm --filter pdf-mcp test
```

The `pdf_analyze` smoke test skips VeraPDF/Adobe but still uses qpdf, pdfjs, and Python inspect; allow up to ~2 minutes on cold runs.

## CLI demos (same stack as MCP)

These scripts use the same primitives as the MCP tools (`analyzePDF`, `inspectPdfForRemediation`, `executeRemediationTool`, or `remediatePdfWithAgent`). Use them when the MCP client is not connected.

- **Fixed tool batch (MCP-style):**  
  `pnpm --filter pdf-mcp exec tsx scripts/demo-mcp-style-fix.ts <input.pdf> [out.pdf]`
- **Full agent loop (stronger than a fixed list):**  
  `pnpm --filter pdf-mcp exec tsx scripts/run-agent-to-pass.ts <input.pdf> [out.pdf]`
- **Check promotion gate only:**  
  `pnpm --filter pdf-mcp exec tsx scripts/verify-gate.ts <file.pdf>`

Legacy ICJIA PDFs often stop below A/100 without many rounds or manual work; a known-good example that passes the gate is e.g. `Complete/1993-1994_Biennial_Report.pdf` (verify with `verify-gate.ts`).
