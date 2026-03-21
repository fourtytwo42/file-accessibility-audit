import type { PdfStructuralClass } from '../services/documentModel.js'

export interface Phase0VerificationManifest {
  blessedArtifacts: {
    baseline: string
    canary: string
  }
  requiredCanaryStructuralClasses: PdfStructuralClass[]
  allowKnownGaps: string[]
}

export const PHASE0_VERIFICATION_MANIFEST: Phase0VerificationManifest = {
  blessedArtifacts: {
    baseline: 'MitigationAttempts/phase0-baselines/2026-03-21T21-03-15Z.phase0-baseline.json',
    canary: 'MitigationAttempts/phase0-baselines/2026-03-21T21-03-15Z.phase0-canary.json',
  },
  requiredCanaryStructuralClasses: [
    'native_tagged',
    'partially_tagged',
    'scanned',
    'untagged_digital',
    'well_tagged',
  ],
  allowKnownGaps: [],
}
