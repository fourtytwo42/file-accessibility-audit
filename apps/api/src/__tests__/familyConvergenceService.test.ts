import { describe, expect, it } from 'vitest'
import { runFamilyConvergenceTrace } from '../services/familyConvergenceService.js'

describe('familyConvergenceService', () => {
  it('runs a generic deterministic convergence chain and records step states', async () => {
    const trace = await runFamilyConvergenceTrace({
      initialBuffer: Buffer.from('baseline'),
      summarize: async (buffer, actions) => ({
        text: buffer.toString('utf8'),
        actionCount: actions.length,
      }),
      steps: [
        {
          key: 'repair_font_unicode_maps',
          execute: async ({ buffer }) => ({
            buffer: Buffer.from(`${buffer.toString('utf8')}|font`),
            action: { tool: 'repair_font_unicode_maps', outcome: 'applied' },
          }),
        },
        {
          key: 'replace_bookmarks_from_headings',
          shouldRun: state => state.text.includes('font'),
          execute: async ({ buffer }) => ({
            buffer: Buffer.from(`${buffer.toString('utf8')}|bookmarks`),
            action: { tool: 'replace_bookmarks_from_headings', outcome: 'applied' },
          }),
        },
      ],
    })

    expect(trace.baseline).toEqual({
      text: 'baseline',
      actionCount: 0,
    })
    expect(trace.steps.map(step => step.key)).toEqual([
      'repair_font_unicode_maps',
      'replace_bookmarks_from_headings',
    ])
    expect(trace.steps[0]?.state).toEqual({
      text: 'baseline|font',
      actionCount: 1,
    })
    expect(trace.steps[1]?.state).toEqual({
      text: 'baseline|font|bookmarks',
      actionCount: 2,
    })
  })
})

