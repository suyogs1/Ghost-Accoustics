import { severityName } from '../venue/cues';
import type { ReceivedEvent } from '../venue/decode';

interface Props {
  readonly event: Extract<ReceivedEvent, { kind: 'emergency' }>;
  readonly onDismiss: () => void;
}

export function EmergencyOverlay({ event, onDismiss }: Props) {
  const { beacon } = event;
  return (
    <div className="emergency" role="alertdialog" aria-modal="true" aria-labelledby="emergency-title">
      <p className="emergency-kicker">Emergency beacon #{beacon.alertId}</p>
      <h2 id="emergency-title" className="emergency-title">
        {severityName(beacon.severity)}
      </h2>
      <p className="emergency-note">Follow venue staff instructions. Sender battery {beacon.batteryPct}%.</p>
      <button type="button" className="btn btn-emergency-dismiss" onClick={onDismiss} autoFocus>
        Acknowledge
      </button>
    </div>
  );
}
