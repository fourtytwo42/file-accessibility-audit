import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BulkActionBar } from '@/components/grid/BulkActionBar'
import { FilterBar } from '@/components/grid/FilterBar'
import { PdfCard } from '@/components/grid/PdfCard'
import { DropZone } from '@/components/upload/DropZone'
import { GradePanel } from '@/components/detail/GradePanel'

describe('DropZone', () => {
  it('forwards selected files', () => {
    const onFilesSelected = vi.fn()
    render(<DropZone onFilesSelected={onFilesSelected} />)

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['pdf'], 'example.pdf', { type: 'application/pdf' })
    fireEvent.change(input, { target: { files: [file] } })

    expect(onFilesSelected).toHaveBeenCalledWith([file])
  })
})

describe('PdfCard', () => {
  it('renders standards-aware summary data', () => {
    render(
      <PdfCard
        item={{
          id: '1',
          clientId: 'c1',
          filename: 'example.pdf',
          md5: 'a'.repeat(32),
          sizeBytes: 100,
          mimeType: 'application/pdf',
          state: 'complete',
          uploadProgress: 100,
          processingProgress: 100,
          processingStage: 'Complete',
          processingPath: 'agent_patch',
          pathFallbacks: [],
          reconstructionStatus: 'completed',
          documentModelStatus: 'completed',
          pageCount: 4,
          overallScore: 91,
          grade: 'B',
          originalScore: 60,
          originalGrade: 'D',
          rebuiltScore: 91,
          rebuiltGrade: 'B',
          standardsSummary: {
            gradeBasis: { currentGrade: 'B', currentScore: 91, gradeReducedByStandards: true, scoreCappedByStandards: false },
            veraPdf: { status: 'failed', failedChecks: 2 },
            failureOverview: { topFailureModes: [{ key: 'pdfua.page_tabs', label: 'Page tab order metadata', count: 2, classification: 'deterministic', blocking: true }] },
            plannerOverview: { autoRunnableOpportunityCount: 1, blockedOpportunityCount: 0, deterministicIssueCount: 1, semanticIssueCount: 0, manualOnlyIssueCount: 0 },
          },
          error: null,
          reconstructionError: null,
          createdAt: '2026-03-13T00:00:00.000Z',
          updatedAt: '2026-03-13T00:00:00.000Z',
          uploadStartedAt: null,
          uploadCompletedAt: null,
          processingStartedAt: null,
          completedAt: null,
          expiresAt: '2026-04-13T00:00:00.000Z',
          canRetry: false,
          canCancel: false,
          canDownloadOriginal: true,
          canDownloadRebuilt: true,
        }}
        selected={false}
        onToggle={() => {}}
      />,
    )

    expect(screen.getByText('Top issue: Page tab order metadata')).toBeInTheDocument()
    expect(screen.getByText('91/100')).toBeInTheDocument()
  })

  it('uses processing progress instead of completed upload progress while processing', () => {
    render(
      <PdfCard
        item={{
          id: '2',
          clientId: 'c1',
          filename: 'processing.pdf',
          md5: 'b'.repeat(32),
          sizeBytes: 100,
          mimeType: 'application/pdf',
          state: 'processing',
          uploadProgress: 100,
          processingProgress: 38,
          processingStage: 'Analyzing original PDF',
          processingPath: 'agent_patch',
          pathFallbacks: [],
          reconstructionStatus: 'processing',
          documentModelStatus: 'processing',
          pageCount: null,
          overallScore: null,
          grade: null,
          originalScore: null,
          originalGrade: null,
          rebuiltScore: null,
          rebuiltGrade: null,
          standardsSummary: null,
          error: null,
          reconstructionError: null,
          createdAt: '2026-03-13T00:00:00.000Z',
          updatedAt: '2026-03-13T00:00:30.000Z',
          uploadStartedAt: null,
          uploadCompletedAt: null,
          processingStartedAt: null,
          completedAt: null,
          expiresAt: '2026-04-13T00:00:00.000Z',
          canRetry: false,
          canCancel: false,
          canDownloadOriginal: false,
          canDownloadRebuilt: false,
        }}
        selected={false}
        onToggle={() => {}}
      />,
    )

    const progressFill = document.querySelector('[style*="width: 38%"]')
    expect(progressFill).toBeTruthy()
  })
})

describe('GradePanel', () => {
  it('shows standards explanation text', () => {
    render(
      <GradePanel
        item={{
          id: '1',
          clientId: 'c1',
          filename: 'example.pdf',
          md5: 'a'.repeat(32),
          sizeBytes: 100,
          mimeType: 'application/pdf',
          state: 'complete',
          uploadProgress: 100,
          processingProgress: 100,
          processingStage: 'Complete',
          processingPath: 'agent_patch',
          pathFallbacks: [],
          reconstructionStatus: 'manual_review_required',
          documentModelStatus: 'completed',
          pageCount: 4,
          overallScore: 99,
          grade: 'B',
          originalScore: 61,
          originalGrade: 'D',
          rebuiltScore: 99,
          rebuiltGrade: 'B',
          standardsSummary: null,
          standardsDetail: {
            gradeBasis: {
              currentScore: 99,
              currentGrade: 'B',
              originalScore: 61,
              originalGrade: 'D',
              rebuiltScore: 99,
              rebuiltGrade: 'B',
              gradeReducedByStandards: true,
              scoreCappedByStandards: true,
              summaryText: 'veraPDF still fails despite a high heuristic score.',
            },
            veraPdf: {
              current: { status: 'failed', failedChecks: 1, profile: null, flavour: null, topFailures: [] },
              original: { status: 'failed', failedChecks: 12, profile: null, flavour: null, topFailures: [] },
              rebuilt: { status: 'failed', failedChecks: 1, profile: null, flavour: null, topFailures: [] },
            },
            failureModes: [],
            plannerEvidence: null,
            remediationSummary: {
              deterministicIssueCount: 1,
              semanticIssueCount: 0,
              manualOnlyIssueCount: 0,
              autoRunnableOpportunityCount: 1,
              blockedOpportunityCount: 0,
              manualReviewRequired: true,
            },
          },
          result: {},
          originalResult: {},
          rebuiltResult: {},
          documentModel: null,
          aiAppliedChanges: [],
          aiSuggestedChanges: [],
          confidenceSummary: null,
          manualReviewFlags: [],
          error: null,
          reconstructionError: null,
          createdAt: '',
          updatedAt: '',
          uploadStartedAt: null,
          uploadCompletedAt: null,
          processingStartedAt: null,
          completedAt: null,
          expiresAt: '',
          canRetry: false,
          canCancel: false,
          canDownloadOriginal: true,
          canDownloadRebuilt: true,
        }}
      />,
    )

    expect(screen.getByText(/veraPDF still fails/i)).toBeInTheDocument()
    expect(screen.getByText(/Standards validation still limits/i)).toBeInTheDocument()
  })
})

describe('BulkActionBar', () => {
  it('renders the selected count', () => {
    render(
      <BulkActionBar
        count={3}
        busy={false}
        onClear={() => {}}
        onDelete={() => {}}
        onDownload={() => {}}
        onReanalyze={() => {}}
        onRemediate={() => {}}
      />,
    )

    expect(screen.getByText('3 selected')).toBeInTheDocument()
  })
})

describe('FilterBar', () => {
  it('keeps advanced controls collapsed until toggled on compact layouts', () => {
    const onChange = vi.fn()
    render(
      <FilterBar
        filters={{
          search: '',
          status: 'all',
          grade: 'all',
          sort: 'created_desc',
          pageSize: 25,
        }}
        onChange={onChange}
        showing={10}
        total={24}
      />,
    )

    const toggle = screen.getByRole('button', { name: /toggle filters and sort/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })
})
