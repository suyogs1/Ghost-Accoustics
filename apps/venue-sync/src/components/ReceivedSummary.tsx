import type { AudienceStats } from '../hooks/useAudienceLink';
import { paletteColor, readableTextOn, severityName, stageStateName } from '../venue/cues';
import type { ReceivedEvent } from '../venue/decode';

interface Props {
  readonly event: ReceivedEvent | null;
  readonly stats: AudienceStats;
  readonly loopback: boolean;
  readonly compact?: boolean;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function airtimeText(event: ReceivedEvent): string {
  if (event.measuredAirtime === null) return `n/a (est ${event.estimatedAirtime.toFixed(2)} s)`;
  const delta = event.measuredAirtime - event.estimatedAirtime;
  const sign = delta >= 0 ? '+' : '-';
  return `${event.measuredAirtime.toFixed(2)} s vs ${event.estimatedAirtime.toFixed(2)} s est (${sign}${Math.abs(delta).toFixed(2)})`;
}

export function ReceivedSummary({ event, stats, loopback, compact = false }: Props) {
  if (!event) {
    return (
      <section className="card" aria-live="polite">
        <h2 className="card-title">Last frame</h2>
        <p className="muted">Nothing received yet. Cues from the stage appear here the moment they decode.</p>
      </section>
    );
  }

  const isCue = event.kind === 'cue';
  const headline = isCue ? stageStateName(event.cue.stageState) : `ALERT ${severityName(event.beacon.severity)}`;
  const subline = isCue ? `Cue #${event.cue.cueId}` : `Alert #${event.beacon.alertId}, sender battery ${event.beacon.batteryPct}%`;
  const accent = isCue ? event.cue.accentColor : null;

  return (
    <section className="card" aria-live="polite">
      <h2 className="card-title">Last frame</h2>
      <div className="summary-head">
        {accent !== null && (
          <span
            className="swatch"
            style={{ background: paletteColor(accent), color: readableTextOn(accent) }}
            title={`Palette index ${accent}`}
          >
            {accent}
          </span>
        )}
        <div>
          <p className="summary-state">{headline}</p>
          <p className="muted">{subline}</p>
        </div>
        <span className="badge badge-ok" title="Frame passed the CRC-32 check before reaching the app">
          CRC-32 MATCH
        </span>
      </div>

      <dl className="kv">
        <dt>Arrived</dt>
        <dd>{formatTime(event.arrivedAt)}</dd>
        <dt>Airtime</dt>
        <dd>{airtimeText(event)}</dd>
        <dt>Signal</dt>
        <dd>{event.peakLevelDb !== null ? `${event.peakLevelDb.toFixed(1)} dBFS peak` : loopback ? 'digital (loopback)' : 'n/a'}</dd>
        <dt>Frame</dt>
        <dd>
          {event.frameBytes} B, CRC {event.crc}
        </dd>
        {!compact && (
          <>
            <dt>Source</dt>
            <dd>
              peer 0x{event.src.toString(16).toUpperCase().padStart(2, '0')}, seq {event.seq}
            </dd>
            <dt>Link health</dt>
            <dd>
              {stats.accepted} accepted, {stats.rejected} rejected (corrupt)
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}
