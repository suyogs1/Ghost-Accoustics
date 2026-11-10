import type { AudienceControls } from '../hooks/useAudienceLink';
import type { StageControls } from '../hooks/useStageLink';
import { paletteColor, readableTextOn, severityName, stageStateName } from '../venue/cues';
import { CueButtons } from './CueButtons';
import { ReceivedSummary } from './ReceivedSummary';

interface Props {
  readonly audience: AudienceControls;
  readonly stage: StageControls;
  readonly loopback: boolean;
}

export function AudiencePanel({ audience, stage, loopback }: Props) {
  const { status, event } = audience;
  const listening = status === 'listening';

  return (
    <div className="panel-grid">
      <section className="hero">
        {!listening ? (
          <>
            <button
              type="button"
              className="btn btn-join"
              onClick={() => void audience.join()}
              disabled={status === 'joining'}
            >
              {status === 'joining' ? 'Joining...' : 'Join Arena (Listen)'}
            </button>
            <p className="hero-note">
              {loopback
                ? 'Loopback Simulation: listens to the in-page stage, no microphone needed.'
                : 'Tap to allow the microphone. Keep this screen open and your volume up.'}
            </p>
          </>
        ) : event === null ? (
          <>
            <p className="hero-status">
              <span className="pulse-dot" aria-hidden="true" /> Listening for cues
            </p>
            <p className="hero-note">Waiting for the stage. The screen reacts the instant a frame decodes.</p>
          </>
        ) : event.kind === 'cue' ? (
          <div aria-live="assertive">
            <p className="hero-kicker">Cue #{event.cue.cueId}</p>
            <p className="hero-state">{stageStateName(event.cue.stageState)}</p>
            <p className="hero-note">
              Accent{' '}
              <span
                className="swatch swatch-inline"
                style={{ background: paletteColor(event.cue.accentColor), color: readableTextOn(event.cue.accentColor) }}
              >
                {event.cue.accentColor}
              </span>
            </p>
          </div>
        ) : (
          <div aria-live="assertive">
            <p className="hero-kicker">Alert #{event.beacon.alertId}</p>
            <p className="hero-state">{severityName(event.beacon.severity)}</p>
          </div>
        )}
        {listening && (
          <button type="button" className="btn btn-quiet" onClick={() => void audience.leave()}>
            Leave
          </button>
        )}
      </section>

      {audience.warning && <p className="alert alert-warn">{audience.warning}</p>}
      {audience.error && (
        <p className="alert alert-error" role="alert">
          {audience.error}
        </p>
      )}

      <ReceivedSummary event={event} stats={audience.stats} loopback={loopback} />

      {audience.history.length > 1 && (
        <section className="card">
          <h2 className="card-title">Recent</h2>
          <ol className="history">
            {audience.history.slice(1).map((h) => (
              <li key={`${h.arrivedAt}-${h.seq}`}>
                {h.kind === 'cue' ? `${stageStateName(h.cue.stageState)} cue #${h.cue.cueId}` : `ALERT ${severityName(h.beacon.severity)}`}
                <span className="muted">
                  {' '}
                  {new Date(h.arrivedAt).toLocaleTimeString([], { hour12: false })}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {loopback && (
        <section className="card">
          <h2 className="card-title">Loopback test controls</h2>
          <p className="hint">Send a cue from the in-page stage and watch this screen react.</p>
          <CueButtons stage={stage} compact />
        </section>
      )}
    </div>
  );
}
