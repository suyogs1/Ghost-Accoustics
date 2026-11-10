import { useMemo, useState } from 'react';
import { LoopbackBus } from '@ghost-acoustics/core';
import { DEFAULT_PROFILE } from '@ghost-acoustics/core/profile';
import type { AcousticProfile } from '@ghost-acoustics/core/profile';
import { NodePane } from './components/NodePane';
import { ProfileSelector } from './components/ProfileSelector';
import { SimulatedSpectrum } from './components/spectrum';
import { WaterfallCanvas } from './components/WaterfallCanvas';
import { useWhisperNode } from './hooks/useWhisperNode';
import { hex8 } from './whisper/text';

const ALICE_ID = 0x01;
const BOB_ID = 0x02;

export function App() {
  const [loopback, setLoopback] = useState(false);
  const [liveId, setLiveId] = useState(ALICE_ID);
  const [liveTarget, setLiveTarget] = useState(BOB_ID);
  const [volume, setVolume] = useState(50);
  const [lossPercent, setLossPercent] = useState(0);
  const [profile, setProfile] = useState<AcousticProfile>(DEFAULT_PROFILE);

  // One in-memory "room" and one simulated spectrum shared by both simulated nodes.
  const bus = useMemo(() => new LoopbackBus(), []);
  const spectrum = useMemo(() => new SimulatedSpectrum(), []);
  const kind = loopback ? 'loopback' : 'live';

  const left = useWhisperNode({
    name: loopback ? 'alice' : 'me',
    enabled: true,
    nodeId: loopback ? ALICE_ID : liveId,
    targetId: loopback ? BOB_ID : liveTarget,
    kind,
    bus,
    spectrum,
    lossPercent,
    volume,
    profile,
  });
  const right = useWhisperNode({
    name: 'bob',
    enabled: loopback,
    nodeId: BOB_ID,
    targetId: ALICE_ID,
    kind,
    bus,
    spectrum,
    lossPercent,
    volume,
    profile,
  });

  return (
    <div className={`app profile-${profile}`}>
      <label className="loopback-switch" title="Two simulated nodes in this tab, no sound needed">
        <input type="checkbox" checked={loopback} onChange={(e) => setLoopback(e.target.checked)} />
        <span>Loopback Simulation</span>
      </label>

      <header className="top">
        <h1 className="brand">Whisper</h1>
        <p className="tagline">Addressed messages over sound. Each one is acknowledged, or it tells you it failed.</p>
      </header>

      <main className="main">
        <WaterfallCanvas
          profile={profile}
          {...(loopback ? { source: spectrum, simulated: true } : { analyser: left.analyser })}
        />

        <ProfileSelector profile={profile} onChange={setProfile} />

        <section className="card channel" aria-label="Channel settings">
          {loopback ? (
            <div className="field">
              <label htmlFor="loss">Simulated packet loss: {lossPercent}%</label>
              <input
                id="loss"
                type="range"
                min={0}
                max={100}
                step={5}
                value={lossPercent}
                onChange={(e) => setLossPercent(Number(e.target.value))}
              />
              <span className="hint">
                Drops that share of frames arriving at either node, ACKs included. Raise it to watch retransmissions; at 100% every send ends FAILED.
              </span>
            </div>
          ) : (
            <div className="field">
              <label htmlFor="volume">Transmit volume: {volume}</label>
              <input id="volume" type="range" min={5} max={100} step={5} value={volume} onChange={(e) => setVolume(Number(e.target.value))} />
              <span className="hint">Open this page on a second device, set the IDs to mirror each other ({hex8(ALICE_ID)} to {hex8(BOB_ID)} and back), and start both radios.</span>
            </div>
          )}
        </section>

        {loopback ? (
          <div className="panes">
            <NodePane
              title="Node 0x01 (Alice)"
              idPrefix="alice"
              node={left}
              nodeId={ALICE_ID}
              targetId={BOB_ID}
              loopback
              onNodeId={() => undefined}
              onTargetId={() => undefined}
            />
            <NodePane
              title="Node 0x02 (Bob)"
              idPrefix="bob"
              node={right}
              nodeId={BOB_ID}
              targetId={ALICE_ID}
              loopback
              onNodeId={() => undefined}
              onTargetId={() => undefined}
            />
          </div>
        ) : (
          <div className="panes panes-single">
            <NodePane
              title="This device"
              idPrefix="me"
              node={left}
              nodeId={liveId}
              targetId={liveTarget}
              loopback={false}
              onNodeId={setLiveId}
              onTargetId={setLiveTarget}
            />
          </div>
        )}
      </main>
    </div>
  );
}
