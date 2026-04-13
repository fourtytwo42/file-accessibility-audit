import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

/** Monorepo root (pdfaf). */
export const REPO_ROOT = path.resolve(moduleDir, '..', '..', '..')

/** Subdirs of ICJIA-PDFs that may be symlinked to another volume (see scripts/setup-icjia-data-disk.sh). */
const ICJIA_PDF_SUBDIRS = ['artifacts', 'backups', 'staging', 'reports'] as const

export function defaultAllowPathRoots(): string[] {
  const roots = [REPO_ROOT, process.env.HOME || process.env.USERPROFILE || ''].filter(Boolean)
  const extra = process.env.PDF_MCP_ALLOW_PATHS
  if (extra) {
    for (const part of extra.split(path.delimiter)) {
      const trimmed = part.trim()
      if (trimmed) roots.push(path.resolve(trimmed))
    }
  }
  const icjiaBase = path.join(REPO_ROOT, 'ICJIA-PDFs')
  for (const sub of ICJIA_PDF_SUBDIRS) {
    const p = path.join(icjiaBase, sub)
    try {
      roots.push(fs.realpathSync(p))
    } catch {
      /* missing or unreadable */
    }
  }
  return [...new Set(roots.map(r => path.resolve(r)))]
}

export function resolveAllowedPath(inputPath: string, allowRoots: string[]): string {
  const resolved = path.resolve(inputPath)
  const real = (() => {
    try {
      return fs.realpathSync(resolved)
    } catch {
      return resolved
    }
  })()
  const norm = (p: string) => p.replace(/\\/g, '/')
  const ok = allowRoots.some(root => {
    const rr = (() => {
      try {
        return fs.realpathSync(root)
      } catch {
        return root
      }
    })()
    return norm(real).startsWith(norm(rr) + '/') || norm(real) === norm(rr)
  })
  if (!ok) {
    throw new Error(`Path not allowed by PDF_MCP_ALLOW_PATHS / default roots: ${inputPath}`)
  }
  return real
}
