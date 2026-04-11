import { describe, expect, it } from 'vitest'
import {
  blockerFamiliesForKeys,
  blockerSignatureForKeys,
  buildRecoveryWaveHistory,
  buildRecoveryWaveManifest,
  isPlateauedHistory,
  latestOutcomePerPublication,
  type RecoveryWaveOutcome,
} from '../services/sub79RecoveryWave.js'

function makeOutcome(overrides: Partial<RecoveryWaveOutcome> = {}): RecoveryWaveOutcome {
  return {
    publicationId: '1001',
    publicationTitle: 'Example',
    status: 'failed_after_remediation',
    processedAt: '2026-04-10T00:00:00.000Z',
    remotePath: '/tmp/example.pdf',
    dominantSelectionFamily: 'font',
    runtimeWeightBucket: 'light',
    final: { overallScore: 69, grade: 'D', pageCount: 12, isScanned: false },
    gate: { blockingLocalFindingKeys: ['pdfua.logical_structure', 'pdfua.figure_alt_or_artifact'] },
    artifacts: { remediatedPdfPath: '/tmp/example-remediated.pdf' },
    ...overrides,
  }
}

describe('sub79RecoveryWave', () => {
  it('derives blocker signatures and families from blocking keys', () => {
    expect(blockerSignatureForKeys(['pdfua.figure_alt_or_artifact', 'pdfua.logical_structure'])).toBe(
      'pdfua.figure_alt_or_artifact + pdfua.logical_structure',
    )
    expect(blockerFamiliesForKeys(['pdfua.figure_alt_or_artifact', 'pdfua.logical_structure', 'pdfua.annotation_alt_contents'])).toEqual([
      'annotation',
      'figure',
      'structure',
    ])
  })

  it('marks a row plateaued only after two no-improvement transitions with no family shrink', () => {
    const history = [
      makeOutcome({ processedAt: '2026-04-08T00:00:00.000Z', final: { overallScore: 68, grade: 'D', pageCount: 12, isScanned: false } }),
      makeOutcome({ processedAt: '2026-04-09T00:00:00.000Z', final: { overallScore: 68, grade: 'D', pageCount: 12, isScanned: false } }),
      makeOutcome({ processedAt: '2026-04-10T00:00:00.000Z', final: { overallScore: 67, grade: 'D', pageCount: 12, isScanned: false } }),
    ]

    expect(isPlateauedHistory(history)).toBe(true)
  })

  it('builds the mixed core lane from current blocker truth instead of dominant selection family', () => {
    const allOutcomes = [
      makeOutcome({
        publicationId: 'core',
        dominantSelectionFamily: 'font',
        gate: { blockingLocalFindingKeys: ['pdfua.logical_structure', 'pdfua.figure_alt_or_artifact'] },
      }),
      makeOutcome({
        publicationId: 'plus',
        gate: { blockingLocalFindingKeys: ['pdfua.logical_structure', 'pdfua.figure_alt_or_artifact', 'pdfua.annotation_alt_contents'] },
      }),
      makeOutcome({
        publicationId: 'font',
        gate: { blockingLocalFindingKeys: ['pdfua.font_embedding'] },
      }),
    ]

    const manifest = buildRecoveryWaveManifest({
      laneName: 'mixed-structure-figure-core',
      sourceOutcomesPaths: ['/tmp/source.json'],
      latestOutcomes: latestOutcomePerPublication(allOutcomes),
      historyByPublicationId: buildRecoveryWaveHistory(allOutcomes),
    })

    expect(manifest.candidates.map(candidate => candidate.publicationId)).toEqual(['core'])
    expect(manifest.candidates[0]?.dominantSelectionFamily).toBe('font')
    expect(manifest.candidates[0]?.blockerSignature).toBe('pdfua.figure_alt_or_artifact + pdfua.logical_structure')
  })

  it('builds the mixed plus and font-led lanes with plateau metadata', () => {
    const history = [
      makeOutcome({
        publicationId: 'plus',
        processedAt: '2026-04-08T00:00:00.000Z',
        final: { overallScore: 70, grade: 'C', pageCount: 12, isScanned: false },
        gate: { blockingLocalFindingKeys: ['pdfua.logical_structure', 'pdfua.figure_alt_or_artifact', 'pdfua.annotation_alt_contents'] },
      }),
      makeOutcome({
        publicationId: 'plus',
        processedAt: '2026-04-09T00:00:00.000Z',
        final: { overallScore: 69, grade: 'D', pageCount: 12, isScanned: false },
        gate: { blockingLocalFindingKeys: ['pdfua.logical_structure', 'pdfua.figure_alt_or_artifact', 'pdfua.annotation_alt_contents'] },
      }),
      makeOutcome({
        publicationId: 'plus',
        processedAt: '2026-04-10T00:00:00.000Z',
        final: { overallScore: 68, grade: 'D', pageCount: 12, isScanned: false },
        gate: { blockingLocalFindingKeys: ['pdfua.logical_structure', 'pdfua.figure_alt_or_artifact', 'pdfua.annotation_alt_contents'] },
      }),
      makeOutcome({
        publicationId: 'font',
        gate: { blockingLocalFindingKeys: ['pdfua.font_embedding', 'pdfua.font_unicode'] },
      }),
    ]

    const latest = latestOutcomePerPublication(history)
    const historyByPublicationId = buildRecoveryWaveHistory(history)

    const plusManifest = buildRecoveryWaveManifest({
      laneName: 'mixed-structure-figure-plus',
      sourceOutcomesPaths: ['/tmp/source.json'],
      latestOutcomes: latest,
      historyByPublicationId,
    })
    const fontManifest = buildRecoveryWaveManifest({
      laneName: 'font-led-deterministic',
      sourceOutcomesPaths: ['/tmp/source.json'],
      latestOutcomes: latest,
      historyByPublicationId,
    })

    expect(plusManifest.candidates.map(candidate => candidate.publicationId)).toEqual(['plus'])
    expect(plusManifest.candidates[0]?.plateaued).toBe(true)
    expect(fontManifest.candidates.map(candidate => candidate.publicationId)).toEqual(['font'])
  })

  it('builds the sub79 tail canary from one-blocker, annotation+figure, and figure+table residue', () => {
    const outcomes = [
      makeOutcome({
        publicationId: 'one-blocker',
        final: { overallScore: 78, grade: 'C', pageCount: 8, isScanned: false },
        gate: { blockingLocalFindingKeys: ['pdfua.figure_alt_or_artifact'] },
      }),
      makeOutcome({
        publicationId: 'annotation-figure',
        final: { overallScore: 76, grade: 'C', pageCount: 12, isScanned: false },
        gate: { blockingLocalFindingKeys: ['pdfua.annotation_alt_contents', 'pdfua.figure_alt_or_artifact'] },
      }),
      makeOutcome({
        publicationId: 'figure-table',
        final: { overallScore: 74, grade: 'C', pageCount: 16, isScanned: false },
        gate: { blockingLocalFindingKeys: ['pdfua.figure_alt_or_artifact', 'pdfua.table_regularity'] },
      }),
      makeOutcome({
        publicationId: 'other',
        final: { overallScore: 61, grade: 'D', pageCount: 20, isScanned: false },
        gate: { blockingLocalFindingKeys: ['pdfua.logical_structure', 'pdfua.font_embedding', 'pdfua.table_regularity'] },
      }),
    ]

    const manifest = buildRecoveryWaveManifest({
      laneName: 'sub79-tail-canary',
      sourceOutcomesPaths: ['/tmp/source.json'],
      latestOutcomes: latestOutcomePerPublication(outcomes),
      historyByPublicationId: buildRecoveryWaveHistory(outcomes),
    })

    expect(manifest.candidates.map(candidate => candidate.publicationId)).toEqual([
      'one-blocker',
      'annotation-figure',
      'figure-table',
    ])
  })
})
