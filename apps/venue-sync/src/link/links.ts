import { AcousticSocket, LoopbackBus, WebAudioChannel, peerIdToByte } from '@ghost-acoustics/core';
import type { AcousticProfile } from '@ghost-acoustics/core';
import { loadGgwave } from './ggwaveLoader';

const STAGE_PEER_ID = 'stage';

/** One shared in-memory "room" for every loopback socket in this tab. */
export const loopbackBus = new LoopbackBus();

export interface StageLink {
  readonly socket: AcousticSocket;
  /** Present in live mode only: gives access to volume, output device and the test tone. */
  readonly audio: WebAudioChannel | null;
}

export interface StageLinkOptions {
  readonly loopback: boolean;
  readonly volume: number;
  readonly outputDeviceId: string | undefined;
  readonly profile: AcousticProfile;
  readonly onWarning: (message: string) => void;
}

/**
 * Stage side: transmit-only. In live mode the channel never opens the microphone,
 * so the broadcaster does not need a mic permission.
 */
export function createStageLink(options: StageLinkOptions): StageLink {
  if (options.loopback) {
    // simulateAirtime makes loopback take real airtime so the countdown and progress bar are honest.
    const socket = new AcousticSocket({
      peerId: STAGE_PEER_ID,
      mode: 'loopback',
      profile: options.profile,
      loopback: { bus: loopbackBus, simulateAirtime: true },
    });
    return { socket, audio: null };
  }
  const audio = new WebAudioChannel({
    ggwaveFactory: loadGgwave,
    receive: false,
    profile: options.profile,
    volume: options.volume,
    ...(options.outputDeviceId !== undefined ? { outputDeviceId: options.outputDeviceId } : {}),
    onWarning: options.onWarning,
  });
  return { socket: new AcousticSocket({ peerId: STAGE_PEER_ID, mode: 'live', profile: options.profile, channel: audio }), audio };
}

export interface AudienceLinkOptions {
  readonly loopback: boolean;
  readonly profile: AcousticProfile;
  readonly onWarning: (message: string) => void;
}

/** Audience side: listens with raw (unprocessed) microphone audio. Each device needs a unique peer ID. */
export function createAudienceLink(options: AudienceLinkOptions): AcousticSocket {
  // Frames whose src byte equals ours are ignored as self-echo, so never share the stage's address byte.
  let peerId: string;
  do {
    peerId = `audience-${Math.random().toString(36).slice(2, 8)}`;
  } while (peerIdToByte(peerId) === peerIdToByte(STAGE_PEER_ID));
  if (options.loopback) {
    return new AcousticSocket({ peerId, mode: 'loopback', profile: options.profile, loopback: { bus: loopbackBus } });
  }
  const audio = new WebAudioChannel({ ggwaveFactory: loadGgwave, profile: options.profile, onWarning: options.onWarning });
  return new AcousticSocket({ peerId, mode: 'live', profile: options.profile, channel: audio });
}
