import type { AcousticProfile } from '../profile';

/** Optional receive-side measurements a channel can attach to a decoded frame. */
export interface RxMeta {
  /** Time from first detected signal energy to successful decode, in seconds. */
  readonly measuredAirtimeSeconds?: number;
  /** Peak signal level while the frame was received, in dBFS (live audio only). */
  readonly peakLevelDb?: number;
  /** Estimated background level before the frame, in dBFS (live audio only). */
  readonly noiseFloorDb?: number;
  /** Peak level minus noise floor, in dB (live audio only). */
  readonly snrDb?: number;
}

/**
 * A raw byte pipe over some physical (or simulated) medium.
 * The socket owns framing, ARQ and half-duplex policy; the channel only moves bytes.
 */
export interface AcousticChannel {
  /** Begin receiving. Each decoded byte buffer is handed to `onBytes`. */
  start(onBytes: (bytes: Uint8Array, meta?: RxMeta) => void): Promise<void>;
  stop(): Promise<void>;
  /** Resolves when the last sample has finished playing out. */
  transmit(bytes: Uint8Array): Promise<void>;
  /** Gate the receive path. While muted, no decoding work is done. */
  muteInput(muted: boolean): void;
  /** Extra settle time (ms) the hardware needs after playback ends. */
  outputLatencyMs?(): number;
  /** Spectrum tap on the capture path, for visualisation. Null until started or when not capturing. */
  getAnalyser?(): AnalyserNode | null;
  /** Switch transmission profile (modulation band, receive filter, atmosphere). */
  setProfile?(profile: AcousticProfile): void;
  /** Called as soon as playback ends; the channel should settle audio effects within durationMs. */
  beginDrain?(durationMs: number): void;
}
