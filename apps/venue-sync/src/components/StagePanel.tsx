import { OPCODE_REGISTRY } from '@ghost-acoustics/schema-compiler/generated/opcodes';
import { DRAIN_CLEARANCE_MS } from '@ghost-acoustics/core/constants';
import { useFrameClock } from '../hooks/useFrameClock';
import type { AudienceControls } from '../hooks/useAudienceLink';
import type { StageControls } from '../hooks/useStageLink';
import { CueButtons } from './CueButtons';
import { ReceivedSummary } from './ReceivedSummary';

interface Props {
  readonly stage: StageControls;
  readonly audience: AudienceControls;
  readonly loopback: boolean;
  readonly volume: number;
  readonly onVolume: (value: number) => void;
  readonly outputDeviceId: string | undefined;
  readonly onOutputDevice: (id: string | undefined) => void;
}

function TxProgressBar({ stage }: { readonly stage: StageControls }) {
  const { tx } = stage;
  const active = tx.phase !== 'idle';
  const now = useFrameClock(active);
  const elapsed = active ? Math.max(0, (now - tx.startedAt) / 1000) : 0;
  const total = tx.estimatedSeconds;
  const transmitting = tx.phase === 'transmitting';
  // Live playback can run slightly past the estimate: hold at 99% until the speaker really stops.
  const fraction = !active ? 0 : tx.phase === 'draining' ? 1 : Math.min(0.99, total > 0 ? elapsed / total : 0);
  const remaining = Math.max(0, total - elapsed);

  let label = 'Idle: ready to transmit';
  if (transmitting) label = remaining > 0 ? `Transmitting: ${remaining.toFixed(1)} s remaining` : 'Transmitting: finishing';
  if (tx.phase === 'draining') label = `Half-duplex drain (${DRAIN_CLEARANCE_MS} ms): input stays muted`;

  return (
    <div>
      <div
        className="progress"
        role="progressbar"
        aria-label="Transmission progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
      >
        <div className={`progress-fill ${tx.phase === 'draining' ? 'is-draining' : ''}`} style={{ width: `${fraction * 100}%` }} />
      </div>
      <p className="progress-label" aria-live="off">
        {label}
      </p>
    </div>
  );
}

export function StagePanel({ stage, audience, loopback, volume, onVolume, outputDeviceId, onOutputDevice }: Props) {
  const { last } = stage;
  return (
    <div className="panel-grid">
      <section className="card">
        <h2 className="card-title">Hardware</h2>
        {loopback ? (
          <p className="muted">Loopback Simulation is on: frames travel through memory, no speaker is used.</p>
        ) : (
          <>
            <div className="field">
              <label htmlFor="output-device">Output device</label>
              <select
                id="output-device"
                value={outputDeviceId ?? ''}
                disabled={!stage.canSelectOutput}
                onChange={(e) => onOutputDevice(e.target.value === '' ? undefined : e.target.value)}
              >
                <option value="">System default</option>
                {stage.devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
              {!stage.canSelectOutput && (
                <p className="hint">This browser plays through the system default output (use the device sound settings).</p>
              )}
            </div>
            <div className="field">
              <label htmlFor="volume">Transmit volume: {volume}</label>
              <input
                id="volume"
                type="range"
                min={5}
                max={100}
                step={5}
                value={volume}
                onChange={(e) => onVolume(Number(e.target.value))}
              />
            </div>
            <div className="row">
              <button type="button" className="btn" onClick={() => void stage.playTestTone()} disabled={stage.tx.phase !== 'idle'}>
                Volume check (test tone)
              </button>
              {!stage.armed && (
                <button type="button" className="btn btn-primary" onClick={() => void stage.arm()}>
                  Enable speaker
                </button>
              )}
              {stage.armed && <span className="badge badge-ok">Speaker ready</span>}
            </div>
            <p className="hint">Turn the device volume up, then use the test tone to confirm the room can hear it.</p>
          </>
        )}
        {stage.warning && <p className="alert alert-warn">{stage.warning}</p>}
        {stage.error && (
          <p className="alert alert-error" role="alert">
            {stage.error}{' '}
            <button type="button" className="link" onClick={stage.clearError}>
              Dismiss
            </button>
          </p>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">Cues</h2>
        <CueButtons stage={stage} />
      </section>

      <section className="card">
        <h2 className="card-title">Telemetry</h2>
        <TxProgressBar stage={stage} />
        <table className="table">
          <caption className="sr-only">Wire cost of each broadcast message</caption>
          <thead>
            <tr>
              <th scope="col">Message</th>
              <th scope="col">Payload</th>
              <th scope="col">Frame</th>
              <th scope="col">Est. airtime</th>
            </tr>
          </thead>
          <tbody>
            {OPCODE_REGISTRY.map((info) => (
              <tr key={info.name}>
                <th scope="row">
                  {info.name}
                  <span className="muted"> {info.hex}</span>
                </th>
                <td>{info.payloadBytes} B</td>
                <td>{info.frameBytes} B</td>
                <td>{info.airtimeSeconds.toFixed(2)} s</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="kv">
          <dt>Link state</dt>
          <dd>{stage.linkState}</dd>
          <dt>Last sent</dt>
          <dd>
            {last
              ? `${last.label}: ${last.frameBytes} B, measured ${last.measured.toFixed(2)} s vs ${last.estimated.toFixed(2)} s est`
              : 'nothing yet'}
          </dd>
        </dl>
      </section>

      {loopback && (
        <div className="preview">
          <h2 className="card-title">Audience preview (loopback)</h2>
          <ReceivedSummary event={audience.event} stats={audience.stats} loopback compact />
        </div>
      )}
    </div>
  );
}
