export interface RunFooterState {
  showLog: boolean;
  inRecovery: boolean;
  hasPreview: boolean;
  awaitingPhase2Start: boolean;
}

export type RunFooterScope = 'run' | 'recovery' | 'approval' | 'phase2Start' | 'log';

export function resolveRunFooterScope(state: RunFooterState): RunFooterScope {
  if (state.showLog) return 'log';
  if (state.hasPreview) return 'approval';
  if (state.awaitingPhase2Start) return 'phase2Start';
  if (state.inRecovery) return 'recovery';
  return 'run';
}
