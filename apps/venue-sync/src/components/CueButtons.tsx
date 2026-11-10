import type { StageControls } from '../hooks/useStageLink';
import { CUE_ACTIONS } from '../venue/cues';

interface Props {
  readonly stage: StageControls;
  /** Smaller layout used for the loopback test strip on the audience screen. */
  readonly compact?: boolean;
}

export function CueButtons({ stage, compact = false }: Props) {
  const disabled = stage.busy || stage.tx.phase !== 'idle';
  return (
    <div className={compact ? 'cues cues-compact' : 'cues'}>
      {CUE_ACTIONS.map((action) => (
        <button
          key={action.id}
          type="button"
          className="btn cue"
          disabled={disabled}
          onClick={() => void stage.sendCue(action.label, action.cue)}
        >
          <span className="cue-label">{action.label}</span>
          {!compact && <span className="cue-hint">{action.hint}</span>}
        </button>
      ))}
      <button
        type="button"
        className="btn cue cue-emergency"
        disabled={disabled}
        onClick={() => void stage.sendEmergency('Emergency Beacon')}
      >
        <span className="cue-label">Emergency Beacon</span>
        {!compact && <span className="cue-hint">CRITICAL, all devices</span>}
      </button>
    </div>
  );
}
