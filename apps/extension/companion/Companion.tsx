import { useEffect, useState, useSyncExternalStore } from 'react';
import { COMPANION_STATE_LABELS, getCompanionPosition, type CompanionUiStore } from './companion-ui';
import type { CompanionState } from '../session/session-state';
import type { SpeechProvider } from '../platform/speech-settings';
import { LATENCY_STAGE_LABELS } from '../runtime/latency';

export const COMPANION_STATUS_ID = 'voice-companion-status';

export function getCompanionButtonLabel(state: CompanionState): string {
  switch (state) {
    case 'listening':
    case 'thinking':
    case 'guiding':
    case 'speaking': return 'Stop task';
    case 'success':
    case 'error': return 'Start a new voice guidance request';
    case 'waiting': return 'Ask a follow-up question';
    default: return 'Start voice guidance';
  }
}

function formatLatency(durationMs: number): string {
  return durationMs >= 1_000 ? `${(durationMs / 1_000).toFixed(1)}s` : `${Math.round(durationMs)}ms`;
}

function Icon({ name }: { name: 'mic' | 'stop' | 'chevron' | 'settings' }) {
  const paths = {
    mic: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    chevron: <path d="m8 10 4 4 4-4" />,
    settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export default function Companion({ store }: { store: CompanionUiStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [expanded, setExpanded] = useState(Boolean(snapshot.instruction || snapshot.notice || snapshot.state === 'error'));
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    if (snapshot.instruction || snapshot.notice || snapshot.state === 'listening' || snapshot.state === 'error') setExpanded(true);
  }, [snapshot.instruction, snapshot.notice, snapshot.state]);
  const isListening = snapshot.state === 'listening';
  const isBusy = ['listening', 'thinking', 'guiding', 'speaking'].includes(snapshot.state);
  const statusLabel = snapshot.latencyNotice ? 'Still working…' : COMPANION_STATE_LABELS[snapshot.state];
  const measuredTotalMs = snapshot.latencyMetrics.filter((metric) => !['assessment', 'planning', 'selection', 'first-step', 'first-guidance', 'plan-completion'].includes(metric.stage)).reduce((sum, metric) => sum + metric.durationMs, 0);
  const position = snapshot.targetRect ? getCompanionPosition(snapshot.targetRect, viewport) : undefined;
  const targetSide = snapshot.targetRect && position ? position.left >= snapshot.targetRect.right ? 'right' : 'left' : undefined;
  const providerLabel = snapshot.speech.provider === 'meta' ? 'Meta STT' : 'Chrome STT';
  return (
    <section role="region" className={[
      'companion-surface', `companion-surface--${snapshot.state}`,
      targetSide ? `companion-surface--target-${targetSide}` : 'companion-surface--docked',
    ].join(' ')} aria-label="Voice companion" aria-busy={isBusy} data-companion-state={snapshot.state}
      data-companion-busy={isBusy} data-companion-latency={snapshot.latencyNotice ? 'slow' : 'normal'}>
      {position && <button className="companion-button" type="button" disabled={snapshot.providerPending} aria-label="Ask about the highlighted control"
        onClick={() => store.toggleListening()} style={{ left: `${position.left}px`, top: `${position.top}px` }}>
        <svg className="companion-cursor" viewBox="0 0 34 42" aria-hidden="true"><path d="M4 3.5v29.1l7.6-7.2 5.6 12.2 6.3-3-5.7-11.8h11.3L4 3.5Z" /></svg>
      </button>}
      <div className={`companion-panel${expanded ? ' companion-panel--expanded' : ''}`}>
        <div className="companion-bar">
          <button className={`companion-mic${isListening ? ' companion-mic--listening' : ''}`} type="button"
            aria-label={getCompanionButtonLabel(snapshot.state)} aria-describedby={COMPANION_STATUS_ID}
            aria-pressed={isListening} disabled={snapshot.providerPending} onClick={() => store.toggleListening()}>
            <Icon name={isBusy ? 'stop' : 'mic'} />
          </button>
          <div className="companion-heading">
            <span className="companion-status" id={COMPANION_STATUS_ID} role="status"
              aria-live={snapshot.state === 'error' ? 'assertive' : 'polite'} aria-atomic="true">{statusLabel}</span>
            <span className="companion-provider-label"><span className="companion-status-dot" />{providerLabel}</span>
          </div>
          <button type="button" className="companion-expand-button" aria-label={expanded ? 'Collapse voice companion' : 'Expand voice companion'}
            aria-expanded={expanded} aria-controls="voice-companion-body" onClick={() => setExpanded(!expanded)}><Icon name="chevron" /></button>
        </div>
        <div className="companion-expand" aria-hidden={!expanded} inert={!expanded}>
          <div className="companion-expand-inner">
            <div className="companion-body" id="voice-companion-body">
              {snapshot.state === 'error' ? <div className="companion-error" role="alert">
                <p>{snapshot.notice || 'Guidance stopped. Try the request again.'}</p>
                <button className="companion-retry" type="button" onClick={() => store.retryTask()}>Retry request</button>
              </div> : <>
                {snapshot.instruction && <p className="companion-instruction">{snapshot.instruction}</p>}
                {snapshot.state === 'listening' && <p className="companion-transcript">{snapshot.transcript || 'Speak your request…'}</p>}
                {snapshot.notice && <p role="status" className="companion-notice">{snapshot.notice}</p>}
                {!snapshot.instruction && !snapshot.notice && snapshot.state !== 'listening' && <p className="companion-hint">Tap the mic to ask for help.</p>}
              </>}
              <div className="companion-speech-control">
                <label htmlFor="voice-companion-provider">Speech input</label>
                <select id="voice-companion-provider" value={snapshot.speech.provider} disabled={snapshot.providerPending || isBusy}
                  onChange={(event) => { void store.changeSpeechProvider(event.target.value as SpeechProvider); }}>
                  <option value="chrome">Chrome</option><option value="meta">Meta STT</option>
                </select>
              </div>
              {(snapshot.providerNotice || snapshot.speech.meta?.message) && <p className="companion-provider-notice" role="status">{snapshot.providerNotice || snapshot.speech.meta?.message}</p>}
              <div className="companion-footer">
                <button type="button" className="companion-text-button" onClick={() => store.openSettings()}><Icon name="settings" />Speech settings</button>
                {isListening && <button className="companion-finish companion-text-button" type="button" onClick={() => store.finishRecording()}>Finish recording</button>}
                {(snapshot.taskActive || isBusy || snapshot.state === 'waiting') && <button className="companion-stop companion-text-button" type="button" aria-label="Stop task" title="Stop task" onClick={() => store.stopTask()}><Icon name="stop" />Stop</button>}
              </div>
              {snapshot.latencyMetrics.length > 0 && <details className="companion-latency">
                <summary aria-label="Show latency breakdown">{formatLatency(measuredTotalMs)} measured</summary>
                <ul className="companion-latency-popover">{snapshot.latencyMetrics.map((metric, index) => <li key={`${metric.stage}-${index}`}><span>{LATENCY_STAGE_LABELS[metric.stage]}</span><strong>{formatLatency(metric.durationMs)}</strong></li>)}</ul>
              </details>}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
