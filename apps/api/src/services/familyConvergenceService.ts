export interface FamilyConvergenceStepResult<TAction> {
  buffer: Buffer
  action: TAction | null
}

export interface FamilyConvergenceStep<TState, TAction> {
  key: string
  shouldRun?: (state: TState) => boolean
  execute: (input: {
    buffer: Buffer
    state: TState
    actions: TAction[]
  }) => Promise<FamilyConvergenceStepResult<TAction>>
}

export interface FamilyConvergenceTrace<TState, TAction> {
  baseline: TState
  steps: Array<{
    key: string
    action: TAction | null
    state: TState
  }>
}

export async function runFamilyConvergenceTrace<TState, TAction>(input: {
  initialBuffer: Buffer
  summarize: (buffer: Buffer, actions: TAction[]) => Promise<TState>
  steps: Array<FamilyConvergenceStep<TState, TAction>>
}): Promise<FamilyConvergenceTrace<TState, TAction>> {
  const actions: TAction[] = []
  let buffer = input.initialBuffer
  let currentState = await input.summarize(buffer, actions)
  const stepStates: FamilyConvergenceTrace<TState, TAction>['steps'] = []

  for (const step of input.steps) {
    if (step.shouldRun && !step.shouldRun(currentState)) {
      continue
    }
    const result = await step.execute({
      buffer,
      state: currentState,
      actions,
    })
    buffer = result.buffer
    if (result.action) actions.push(result.action)
    currentState = await input.summarize(buffer, actions)
    stepStates.push({
      key: step.key,
      action: result.action,
      state: currentState,
    })
  }

  return {
    baseline: await input.summarize(input.initialBuffer, []),
    steps: stepStates,
  }
}

