export type LatencyStage =
  | 'first-step'
  | 'first-guidance'
  | 'plan-completion'
  | 'assessment'
  | 'planning'
  | 'selection'
  | 'recording'
  | 'speech-to-text'
  | 'semantic-scan'
  | 'reasoning'
  | 'page-settle'
  | 'layout'
  | 'movement'
  | 'text-to-speech'
  | 'playback';

export type LatencyMetric = {
  stage: LatencyStage;
  durationMs: number;
  museCalls?: number;
  escalationReason?: 'none' | 'explanation' | 'consequence' | 'new-step';
};

export const LATENCY_STAGE_LABELS: Record<LatencyStage, string> = {
  'first-step': 'First complete step',
  'first-guidance': 'First validated guidance',
  'plan-completion': 'Full plan completion',
  assessment: 'Jev assessment',
  planning: 'Step planning',
  selection: 'DOM selection',
  recording: 'Recording',
  'speech-to-text': 'Speech recognition',
  'semantic-scan': 'Page scan',
  reasoning: 'Reasoning',
  'page-settle': 'Page settle',
  layout: 'Layout settle',
  movement: 'Companion movement',
  'text-to-speech': 'Speech synthesis',
  playback: 'Audio playback',
};

export function latencyDurationMs(startedAt: number, endedAt: number): number {
  return Math.max(0, Math.round((endedAt - startedAt) * 10) / 10);
}
