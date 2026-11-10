import type { LinkState } from '@ghost-acoustics/core';
import type { ArqMetrics } from '../hooks/useWhisperNode';

interface Props {
  readonly metrics: ArqMetrics;
  readonly linkState: LinkState;
  readonly loopback: boolean;
}

const fmtMs = (ms: number | null): string => (ms === null ? '-' : `${Math.round(ms)} ms`);

export function TelemetryPanel({ metrics, linkState, loopback }: Props) {
  const { lastAirtime } = metrics;
  return (
    <section className="card telemetry" aria-label="Stop-and-Wait ARQ telemetry">
      <h3 className="card-title">Telemetry: Stop-and-Wait ARQ</h3>
      <dl className="metrics">
        <div>
          <dt>RTT</dt>
          <dd>
            {fmtMs(metrics.lastRttMs)}
            <small>avg {fmtMs(metrics.avgRttMs)}</small>
          </dd>
        </div>
        <div>
          <dt>Retransmissions</dt>
          <dd>
            {metrics.retransmissions}
            <small>
              {metrics.delivered} ok / {metrics.failed} failed
            </small>
          </dd>
        </div>
        <div>
          <dt>SNR estimate</dt>
          <dd>
            {metrics.snrDb === null ? (loopback ? 'digital' : 'n/a') : `${metrics.snrDb.toFixed(1)} dB`}
            <small>{metrics.snrDb === null ? (loopback ? 'no acoustic noise' : 'hear a packet first') : 'last frame heard'}</small>
          </dd>
        </div>
        <div>
          <dt>Last packet airtime</dt>
          <dd>
            {lastAirtime ? `${lastAirtime.measured.toFixed(2)} s` : '-'}
            <small>
              {lastAirtime ? `${lastAirtime.kind === 'ack' ? 'ACK' : 'data'}, est ${lastAirtime.estimated.toFixed(2)} s` : 'nothing sent yet'}
            </small>
          </dd>
        </div>
      </dl>
      <p className="muted telemetry-foot">
        Link {linkState}
        {metrics.corrupt > 0 && `, ${metrics.corrupt} corrupt frame${metrics.corrupt === 1 ? '' : 's'} rejected`}
      </p>
    </section>
  );
}
