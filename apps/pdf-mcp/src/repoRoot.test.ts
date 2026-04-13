import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultAllowPathRoots, REPO_ROOT, resolveAllowedPath } from './repoRoot.ts'

describe('repoRoot', () => {
  it('REPO_ROOT exists', () => {
    expect(fs.existsSync(REPO_ROOT)).toBe(true)
    expect(fs.existsSync(path.join(REPO_ROOT, 'package.json'))).toBe(true)
  })

  it('resolveAllowedPath allows repo package.json', () => {
    const roots = defaultAllowPathRoots()
    const pkg = path.join(REPO_ROOT, 'package.json')
    expect(() => resolveAllowedPath(pkg, roots)).not.toThrow()
  })

  it('resolveAllowedPath rejects outside roots', () => {
    const roots = [REPO_ROOT]
    expect(() => resolveAllowedPath('/etc/passwd', roots)).toThrow(/not allowed/)
  })

  it('defaultAllowPathRoots allows paths under realpath(ICJIA-PDFs/artifacts)', () => {
    const artifacts = path.join(REPO_ROOT, 'ICJIA-PDFs', 'artifacts')
    if (!fs.existsSync(artifacts)) return
    const roots = defaultAllowPathRoots()
    const realArtifacts = fs.realpathSync(artifacts)
    const probe = path.join(realArtifacts, '.')
    expect(() => resolveAllowedPath(probe, roots)).not.toThrow()
  })
})
