import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { AudiencePanel } from './components/AudiencePanel';
import { EmergencyOverlay } from './components/EmergencyOverlay';
import { StagePanel } from './components/StagePanel';
import { useAudienceLink } from './hooks/useAudienceLink';
import { useStageLink } from './hooks/useStageLink';
import { useWakeLock } from './hooks/useWakeLock';
import { effectForState, paletteColor, readableTextOn } from './venue/cues';

type Role = 'stage' | 'audience';

export function App() {
  const [role, setRole] = useState<Role>('stage');
  const [loopback, setLoopback] = useState(false);
  const [volume, setVolume] = useState(50);
  const [outputDeviceId, setOutputDeviceId] = useState<string | undefined>(undefined);

  const stage = useStageLink(loopback, volume, outputDeviceId);
  const audience = useAudienceLink(loopback);
  const { status: audienceStatus, join: joinAudience, leave: leaveAudience } = audience;

  // Loopback: the stage screen carries a live audience preview, so a solo judge sees both ends.
  // Live: the microphone is only open while the Audience tab is in use.
  useEffect(() => {
    if (loopback && role === 'stage' && audienceStatus === 'off') void joinAudience();
    if (!loopback && role === 'stage' && audienceStatus !== 'off') void leaveAudience();
  }, [loopback, role, audienceStatus, joinAudience, leaveAudience]);

  useWakeLock(role === 'audience' && audienceStatus === 'listening');

  const event = audience.event;
  const cueEvent = role === 'audience' && event?.kind === 'cue' ? event : null;
  const emergency = role === 'audience' && event?.kind === 'emergency' ? event : null;

  const accent = cueEvent ? cueEvent.cue.accentColor : null;
  const style = (
    accent === null
      ? {}
      : { '--screen-bg': paletteColor(accent), '--screen-fg': readableTextOn(accent) }
  ) as CSSProperties;
  const effect = cueEvent ? effectForState(cueEvent.cue.stageState) : 'none';

  return (
    <div className={`app role-${role} ${accent !== null ? 'has-accent' : ''}`} style={style}>
      {/* Re-keyed per frame so the effect replays even when the same cue arrives twice. */}
      {effect !== 'none' && <div key={audience.eventCount} className={`fx fx-${effect}`} aria-hidden="true" />}

      <label className="loopback-switch" title="Run stage and audience inside this tab, no sound needed">
        <input type="checkbox" checked={loopback} onChange={(e) => setLoopback(e.target.checked)} />
        <span>Loopback Simulation</span>
      </label>

      <header className="top">
        <div>
          <h1 className="brand">Venue Sync</h1>
          <p className="tagline">GhostAcoustics broadcast. No Wi-Fi, no pairing.</p>
        </div>
        <div className="seg" role="group" aria-label="Operating mode">
          <button type="button" className="seg-btn" aria-pressed={role === 'stage'} onClick={() => setRole('stage')}>
            Stage / Broadcaster
          </button>
          <button type="button" className="seg-btn" aria-pressed={role === 'audience'} onClick={() => setRole('audience')}>
            Audience / Receiver
          </button>
        </div>
      </header>

      <main className="main">
        {role === 'stage' ? (
          <StagePanel
            stage={stage}
            audience={audience}
            loopback={loopback}
            volume={volume}
            onVolume={setVolume}
            outputDeviceId={outputDeviceId}
            onOutputDevice={setOutputDeviceId}
          />
        ) : (
          <AudiencePanel audience={audience} stage={stage} loopback={loopback} />
        )}
      </main>

      {emergency && <EmergencyOverlay key={audience.eventCount} event={emergency} onDismiss={audience.dismiss} />}
    </div>
  );
}
