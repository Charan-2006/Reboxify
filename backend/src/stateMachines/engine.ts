export interface TransitionResult<TState extends string> {
  allowed: boolean;
  from: TState;
  to: TState;
  reason?: string;
}

export class StateMachine<TState extends string> {
  constructor(
    public readonly entityName: string,
    private readonly transitions: Record<TState, readonly TState[]>
  ) {}

  canTransition(from: TState, to: TState): boolean {
    const allowedTargets = this.transitions[from];
    if (!allowedTargets) return false;
    return allowedTargets.includes(to);
  }

  validateTransition(from: TState, to: TState): TransitionResult<TState> {
    if (from === to) {
      return {
        allowed: false,
        from,
        to,
        reason: `${this.entityName} is already in state ${from}.`,
      };
    }

    if (!this.canTransition(from, to)) {
      return {
        allowed: false,
        from,
        to,
        reason: `Invalid ${this.entityName} state transition from ${from} to ${to}.`,
      };
    }

    return { allowed: true, from, to };
  }

  getAllowedNextStates(from: TState): readonly TState[] {
    return this.transitions[from] ?? [];
  }
}

