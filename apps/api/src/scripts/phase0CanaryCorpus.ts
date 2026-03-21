import type { PdfStructuralClass } from '../services/documentModel.js'

export interface Phase0CanaryPinnedEntry {
  filename: string
  pdfPath: string
  sourceSet: '3rdpass_pass' | '3rdpass_fail' | 'downloads'
  why: string
  expectedSignals: string[]
  verificationLocks?: {
    disallowedAutoRunnableKeys?: string[]
    requiredFailureProfileKeys?: string[]
    requiredPlannerOpportunityKeys?: string[]
    requiredAutoRunnableKeys?: string[]
  }
}

export const PHASE0_CANARY_PINNED: Phase0CanaryPinnedEntry[] = [
  {
    filename: 'Addressing Police Stress FINAL-220523T17215932.pdf',
    pdfPath: '3rdPass/Pass/Addressing Police Stress FINAL-220523T17215932.pdf',
    sourceSet: '3rdpass_pass',
    why: 'Only passing file in the 21-file Acrobat sample; guards against scoring drift on a near-clean well-tagged document.',
    expectedSignals: ['structural_class.well_tagged', 'adobe.figures_alt_text', 'adobe.tagged_annotations'],
    verificationLocks: {
      disallowedAutoRunnableKeys: ['bootstrap_struct_tree:document:document'],
    },
  },
  {
    filename: 'Evaluation of the Lake County Adult Probation.pdf',
    pdfPath: '3rdPass/Fail/Evaluation of the Lake County Adult Probation.pdf',
    sourceSet: '3rdpass_fail',
    why: 'Known regression-sensitive native-tagged file with heading/planner history in REMEDIATION_PROGRESS.md.',
    expectedSignals: ['structural_class.well_tagged', 'regression.heading_mutation', 'adobe.tagged_annotations'],
    verificationLocks: {
      disallowedAutoRunnableKeys: ['bootstrap_struct_tree:document:document'],
    },
  },
  {
    filename: 'Traffic and Pedestrian Stop Data Use and Collection Task Force 2025 Report - FINAL 2-24-25-250328T14564559.pdf',
    pdfPath: '3rdPass/Fail/Traffic and Pedestrian Stop Data Use and Collection Task Force 2025 Report - FINAL 2-24-25-250328T14564559.pdf',
    sourceSet: '3rdpass_fail',
    why: 'Modern native-tagged report with Acrobat alt-text and annotation-content history.',
    expectedSignals: ['structural_class.native_tagged', 'adobe.nested_alt_text', 'regression.alt_text_vs_heading_cleanup'],
    verificationLocks: {
      disallowedAutoRunnableKeys: ['bootstrap_struct_tree:document:document'],
    },
  },
  {
    filename: 'Prescription drug November 2008.pdf',
    pdfPath: '3rdPass/Fail/Prescription drug November 2008.pdf',
    sourceSet: '3rdpass_fail',
    why: 'Known font/encoding and figure-repair canary from the small-PDF campaign.',
    expectedSignals: ['structural_class.well_tagged', 'adobe.figures_alt_text', 'regression.font_unicode'],
    verificationLocks: {
      disallowedAutoRunnableKeys: ['bootstrap_struct_tree:document:document'],
    },
  },
  {
    filename: 'GTF-juvenilesentencing.pdf',
    pdfPath: '3rdPass/Fail/GTF-juvenilesentencing.pdf',
    sourceSet: '3rdpass_fail',
    why: 'Known planner/orchestration regression canary for native-tagged logical-structure fixes.',
    expectedSignals: ['structural_class.native_tagged', 'adobe.other_elements_alt_text', 'regression.native_structure_orchestration'],
    verificationLocks: {
      disallowedAutoRunnableKeys: ['bootstrap_struct_tree:document:document'],
    },
  },
  {
    filename: 'CMVoga.pdf',
    pdfPath: '3rdPass/Fail/CMVoga.pdf',
    sourceSet: '3rdpass_fail',
    why: 'Native-tagged document with historical font-finalization fixes that should remain stable.',
    expectedSignals: ['structural_class.native_tagged', 'regression.font_finalization'],
    verificationLocks: {
      disallowedAutoRunnableKeys: ['bootstrap_struct_tree:document:document'],
    },
  },
  {
    filename: '2014_CVPP_Reentry_Report-191011T20093121.pdf',
    pdfPath: 'Downloads/2014_CVPP_Reentry_Report-191011T20093121.pdf',
    sourceSet: 'downloads',
    why: 'Pinned partially tagged canary discovered from Downloads so Phase 0 covers the partial-tag family deterministically.',
    expectedSignals: ['structural_class.partially_tagged'],
  },
  {
    filename: '2016_Motor_Vehicle_Annual_Report.pdf',
    pdfPath: 'Downloads/2016_Motor_Vehicle_Annual_Report.pdf',
    sourceSet: 'downloads',
    why: 'Pinned untagged-digital canary discovered from Downloads so Phase 0 covers the untagged family deterministically.',
    expectedSignals: ['structural_class.untagged_digital'],
  },
  {
    filename: 'A Trip to the State Fair.pdf',
    pdfPath: 'Downloads/A Trip to the State Fair.pdf',
    sourceSet: 'downloads',
    why: 'Pinned scanned canary discovered from Downloads so Phase 0 covers the scanned family deterministically.',
    expectedSignals: ['structural_class.scanned'],
  },
]

export interface Phase0DynamicClassTarget {
  structuralClass: PdfStructuralClass
  searchRoot: string
  why: string
}

export const PHASE0_CANARY_DYNAMIC_CLASS_TARGETS: Phase0DynamicClassTarget[] = [
  {
    structuralClass: 'scanned',
    searchRoot: 'Downloads',
    why: 'Phase 0 canary must include at least one scanned PDF.',
  },
  {
    structuralClass: 'untagged_digital',
    searchRoot: 'Downloads',
    why: 'Phase 0 canary must include at least one untagged-digital PDF.',
  },
  {
    structuralClass: 'partially_tagged',
    searchRoot: 'Downloads',
    why: 'Phase 0 canary must include at least one partially tagged PDF.',
  },
] as const
