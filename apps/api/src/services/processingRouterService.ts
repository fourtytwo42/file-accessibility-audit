import type { AnalysisResult } from './pdfAnalyzer.js'

export type ProcessingPath = 'agent_patch'

export function chooseProcessingPath(_result: AnalysisResult): ProcessingPath {
  return 'agent_patch'
}
