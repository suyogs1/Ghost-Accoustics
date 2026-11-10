import { estimateAirtimeSeconds } from '../airtime';
import {
  BASELINE_BITRATE_BPS,
  BROADCAST_PEER,
  CoreOpcode,
  DRAIN_CLEARANCE_MS,
  FIRST_APP_OPCODE,
  Flags,
  FRAME_OVERHEAD_BYTES,
  MAX_OPCODE,
} from '../constants';
import { decodeFrame, encodeFrame, peerIdToByte } from '../frame';
import type { Frame, FrameErrorCode } from '../frame';
import { DEFAULT_PROFILE } from '../profile';
import type { AcousticProfile } from '../profile';
import type { AcousticChannel, RxMeta } from './channel';
import { LoopbackChannel } from './LoopbackChannel';
import type { LoopbackChannelOptions } from './LoopbackChannel';
import { TypedEmitter } from './TypedEmitter';
import { WebAudioChannel } from './WebAudioChannel';
import type { WebAudioChannelOptions } from './WebAudioChannel';

/** `live` = real WebAudio mic/speaker. `loopback` = in-memory transfer, no hardware. */
export type SocketMode = 'live' | 'loopback';

/** Half-duplex link state: IDLE -> LISTENING -> TRANSMITTING -> DRAINING -> LISTENING. */
export type LinkState = 'IDLE' | 'LISTENING' | 'TRANSMITTING' | 'DRAINING';

export interface ReceivedFrame extends Frame {
  readonly receivedAtMs: number;
  /** Receive-side measurements from the channel, when it provides them. */
  readonly rx?: RxMeta;
}

export interface AirtimeEvent {
  /** Estimated airtime in seconds from the baseline bitrate. */
  readonly estimated: number;
  /** Measured playback duration in seconds (transmit start to playback end). */
  readonly measured: number;
  readonly frameBytes: number;
  readonly opcode: number;
  readonly kind: 'data' | 'ack';
  /** performance.now() when playback of this frame started. */
  readonly startedAt: number;
}

/** Reported to `SendOptions.onTransmit` each time a frame goes on the air. */
export interface TransmitInfo {
  /** 1 for the first transmission, 2+ for retransmissions. */
  readonly attempt: number;
  /** Total attempts allowed (first transmission plus retries). */
  readonly maxAttempts: number;
  readonly seq: number;
  readonly estimatedSeconds: number;
  /** performance.now() when playback started. */
  readonly startedAt: number;
}

export interface SendOptions {
  /** Called as each transmission (including retries) starts. */
  readonly onTransmit?: (info: TransmitInfo) => void;
}

/** Emitted for every ACK addressed to this socket, whether or not a send is waiting on it. */
export interface AckEvent {
  readonly src: number;
  readonly seq: number;
  readonly rx?: RxMeta;
}

export type DropReason =
  | 'half-duplex'
  | 'not-for-me'
  | 'own-frame'
  | Extract<FrameErrorCode, 'BadSync' | 'BadLength' | 'BadCrc'>;

export interface DropEvent {
  readonly reason: DropReason;
}

export interface SendResult {
  readonly delivered: boolean;
  /** Transmissions made, including the first. */
  readonly attempts: number;
  readonly seq: number;
  /** Round trip in ms: start of the successful transmission to ACK arrival. Null when not delivered. */
  readonly rttMs: number | null;
}

export interface SocketEvents {
  packet: ReceivedFrame;
  ack: AckEvent;
  airtime: AirtimeEvent;
  drop: DropEvent;
  state: LinkState;
  error: Error;
}

export interface AcousticSocketOptions {
  /** Human-readable peer ID; hashed to a 1-byte wire address. */
  readonly peerId: string;
  /** Use this exact wire address (1..255) instead of hashing `peerId`. */
  readonly peerByte?: number;
  readonly mode: SocketMode;
  /** Transmission profile: audible, near-ultrasound or haunted-atmosphere. Default 'audible-fast'. */
  readonly profile?: AcousticProfile;
  /** Inject a custom channel (overrides `mode`'s default channel). */
  readonly channel?: AcousticChannel;
  readonly loopback?: LoopbackChannelOptions;
  readonly webAudio?: WebAudioChannelOptions;
  /** Input stays muted this long after playback ends. Default 150 ms. */
  readonly drainMs?: number;
  /** Slack added to the ACK wait window. Default 750 ms. */
  readonly ackMarginMs?: number;
  /** Retransmissions after the first attempt. Default 3. */
  readonly maxRetries?: number;
  readonly bitrateBps?: number;
  /** Padding added on top of the drain time before replying with an ACK. Default 100 ms. */
  readonly ackTurnaroundPadMs?: number;
  /** Window in which a repeated (src, seq) is treated as a retransmission. Default 30 s. */
  readonly dedupWindowMs?: number;
}

/** Runs async tasks one at a time, in order. A failed task does not block the next. */
class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const now = (): number => performance.now();

function assertAppOpcode(opcode: number): void {
  if (!Number.isInteger(opcode) || opcode < FIRST_APP_OPCODE || opcode > MAX_OPCODE) {
    throw new RangeError(`opcode must be an integer in 0x${FIRST_APP_OPCODE.toString(16)}..0x${MAX_OPCODE.toString(16)}`);
  }
}

/**
 * Half-duplex acoustic datagram socket.
 *
 * - `broadcast` is fire-and-forget (one-to-many, no ACK).
 * - `send` is unicast with Stop-and-Wait ARQ.
 * - Input is muted while transmitting and for a drain window afterwards,
 *   so the device never decodes its own speaker.
 */
export class AcousticSocket extends TypedEmitter<SocketEvents> {
  readonly peerId: string;
  readonly peerByte: number;
  readonly mode: SocketMode;

  private readonly channel: AcousticChannel;
  private readonly drainMs: number;
  private readonly ackMarginMs: number;
  private readonly maxRetries: number;
  private readonly bitrateBps: number;
  private readonly dedupWindowMs: number;
  private readonly ackTurnaroundPadMs: number;

  private linkState: LinkState = 'IDLE';
  private currentProfile: AcousticProfile;
  private running = false;
  private seq: number;
  private drops = 0;

  /** Serialises ARQ conversations (one outstanding datagram). */
  private readonly sendQueue = new Serial();
  /** Serialises physical transmissions (data and ACKs share one speaker). */
  private readonly txMutex = new Serial();
  private readonly pendingAcks = new Map<number, (acked: boolean) => void>();
  private readonly lastSeen = new Map<number, { seq: number; at: number }>();

  constructor(options: AcousticSocketOptions) {
    super();
    this.peerId = options.peerId;
    if (options.peerByte !== undefined && !(Number.isInteger(options.peerByte) && options.peerByte >= 1 && options.peerByte <= 255)) {
      throw new RangeError('peerByte must be an integer in 1..255 (0 is the broadcast address)');
    }
    this.peerByte = options.peerByte ?? peerIdToByte(options.peerId);
    this.mode = options.mode;
    this.drainMs = options.drainMs ?? DRAIN_CLEARANCE_MS;
    this.ackMarginMs = options.ackMarginMs ?? 750;
    this.maxRetries = options.maxRetries ?? 3;
    this.bitrateBps = options.bitrateBps ?? BASELINE_BITRATE_BPS;
    this.dedupWindowMs = options.dedupWindowMs ?? 30_000;
    this.ackTurnaroundPadMs = options.ackTurnaroundPadMs ?? 100;
    this.seq = Math.floor(Math.random() * 256);
    this.currentProfile = options.profile ?? DEFAULT_PROFILE;
    this.channel =
      options.channel ??
      (options.mode === 'live'
        ? new WebAudioChannel({ ...options.webAudio, profile: this.currentProfile })
        : new LoopbackChannel(options.loopback));
    // Only push a profile into an injected channel when one was asked for; otherwise leave its own.
    if (options.profile !== undefined) this.channel.setProfile?.(this.currentProfile);
  }

  get state(): LinkState {
    return this.linkState;
  }

  /** Frames heard while transmitting/draining (self-interference). */
  get selfInterferenceDrops(): number {
    return this.drops;
  }

  get profile(): AcousticProfile {
    return this.currentProfile;
  }

  /**
   * Switch profile at runtime. Sender and receiver must use the same band: an ultrasound
   * receiver filters out audible frames, and vice versa.
   */
  setProfile(profile: AcousticProfile): void {
    this.currentProfile = profile;
    this.channel.setProfile?.(profile);
  }

  /** Spectrum tap on the capture path (live mode, once started); null otherwise. */
  get analyser(): AnalyserNode | null {
    return this.channel.getAnalyser?.() ?? null;
  }

  /** Opens the channel. In live mode this must be called from a user gesture. */
  async start(): Promise<void> {
    if (this.running) return;
    await this.channel.start((bytes, meta) => this.onBytes(bytes, meta));
    this.running = true;
    this.setState('LISTENING');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    for (const settle of [...this.pendingAcks.values()]) settle(false);
    this.pendingAcks.clear();
    await this.channel.stop();
    this.setState('IDLE');
  }

  /** One-to-many datagram. No ACK is requested or expected. */
  broadcast(opcode: number, payload: Uint8Array): Promise<AirtimeEvent> {
    assertAppOpcode(opcode);
    return this.sendQueue.run(() =>
      this.transmitFrame(
        { src: this.peerByte, dst: BROADCAST_PEER, seq: this.nextSeq(), flags: Flags.BROADCAST, opcode, payload },
        'data',
      ),
    );
  }

  /**
   * Unicast datagram with Stop-and-Wait ARQ. Resolves `delivered: false` after all retries.
   * `target` is a peer ID string (hashed) or a raw wire address byte (1..255).
   */
  send(target: string | number, opcode: number, payload: Uint8Array, options: SendOptions = {}): Promise<SendResult> {
    assertAppOpcode(opcode);
    const dst = typeof target === 'number' ? target : peerIdToByte(target);
    if (!Number.isInteger(dst) || dst < 1 || dst > 255) {
      return Promise.reject(new RangeError('target address must be an integer in 1..255'));
    }
    if (dst === this.peerByte) {
      return Promise.reject(new Error(`peer "${String(target)}" has this socket's own address byte`));
    }
    return this.sendQueue.run(async () => {
      const seq = this.nextSeq();
      const frame: Frame = { src: this.peerByte, dst, seq, flags: 0, opcode, payload };
      const ackWindowMs = this.ackTurnaroundMs() + this.airtimeMs(FRAME_OVERHEAD_BYTES) + this.ackMarginMs;
      const attempts = this.maxRetries + 1;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const waiter = this.expectAck(dst, seq);
        let report: AirtimeEvent;
        try {
          report = await this.transmitFrame(frame, 'data', (startedAt, estimatedSeconds) =>
            options.onTransmit?.({ attempt, maxAttempts: attempts, seq, estimatedSeconds, startedAt }),
          );
        } catch (err) {
          waiter.cancel();
          throw err;
        }
        if (await waiter.wait(ackWindowMs)) {
          const ackedAt = waiter.ackedAt();
          return { delivered: true, attempts: attempt, seq, rttMs: ackedAt === null ? null : ackedAt - report.startedAt };
        }
      }
      return { delivered: false, attempts, seq, rttMs: null };
    });
  }

  // ---- transmit path ------------------------------------------------------

  private transmitFrame(
    frame: Frame,
    kind: 'data' | 'ack',
    onStart?: (startedAt: number, estimatedSeconds: number) => void,
  ): Promise<AirtimeEvent> {
    return this.txMutex.run(async () => {
      // Encode first: budget/size errors must not touch the radio state.
      const bytes = encodeFrame(frame, { bitrateBps: this.bitrateBps });
      const estimated = estimateAirtimeSeconds(bytes.length, this.bitrateBps);

      this.channel.muteInput(true);
      this.setState('TRANSMITTING');
      let report: AirtimeEvent;
      try {
        const start = now();
        onStart?.(start, estimated);
        await this.channel.transmit(bytes);
        report = {
          estimated,
          measured: (now() - start) / 1000,
          frameBytes: bytes.length,
          opcode: frame.opcode,
          kind,
          startedAt: start,
        };
      } finally {
        this.setState('DRAINING');
        const drainMs = this.drainMs + (this.channel.outputLatencyMs?.() ?? 0);
        this.channel.beginDrain?.(drainMs);
        await sleep(drainMs);
        this.channel.muteInput(false);
        this.setState(this.running ? 'LISTENING' : 'IDLE');
      }
      this.emit('airtime', report);
      return report;
    });
  }

  private nextSeq(): number {
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0xff;
    return seq;
  }

  private airtimeMs(frameBytes: number): number {
    return estimateAirtimeSeconds(frameBytes, this.bitrateBps) * 1000;
  }

  /** Delay before replying with an ACK so the sender's drain window has closed. */
  private ackTurnaroundMs(): number {
    return this.drainMs + this.ackTurnaroundPadMs + (this.channel.outputLatencyMs?.() ?? 0);
  }

  // ---- receive path -------------------------------------------------------

  private onBytes(bytes: Uint8Array, meta?: RxMeta): void {
    if (this.linkState === 'TRANSMITTING' || this.linkState === 'DRAINING') {
      this.drops++;
      this.emit('drop', { reason: 'half-duplex' });
      return;
    }
    if (!this.running) return;

    const result = decodeFrame(bytes);
    if (!result.ok) {
      this.emit('drop', { reason: result.error });
      return;
    }
    const frame = result.frame;
    if (frame.src === this.peerByte) {
      this.emit('drop', { reason: 'own-frame' });
      return;
    }
    if (frame.dst !== BROADCAST_PEER && frame.dst !== this.peerByte) {
      this.emit('drop', { reason: 'not-for-me' });
      return;
    }

    if ((frame.flags & Flags.ACK) !== 0) {
      const key = (frame.src << 8) | frame.seq;
      if (frame.dst === this.peerByte) {
        this.emit('ack', { src: frame.src, seq: frame.seq, ...(meta ? { rx: meta } : {}) });
        const settle = this.pendingAcks.get(key);
        if (settle) {
          this.pendingAcks.delete(key);
          settle(true);
        }
      }
      return;
    }

    if (!this.isDuplicate(frame)) {
      this.emit('packet', { ...frame, receivedAtMs: Date.now(), ...(meta ? { rx: meta } : {}) });
    }
    // Always re-ACK unicast, even duplicates: our earlier ACK may have been lost.
    if (frame.dst === this.peerByte) this.scheduleAck(frame.src, frame.seq);
  }

  private isDuplicate(frame: Frame): boolean {
    const at = Date.now();
    const prev = this.lastSeen.get(frame.src);
    this.lastSeen.set(frame.src, { seq: frame.seq, at });
    return prev !== undefined && prev.seq === frame.seq && at - prev.at <= this.dedupWindowMs;
  }

  private scheduleAck(to: number, seq: number): void {
    setTimeout(() => {
      if (!this.running) return;
      const ack: Frame = {
        src: this.peerByte,
        dst: to,
        seq,
        flags: Flags.ACK,
        opcode: CoreOpcode.ACK,
        payload: new Uint8Array(0),
      };
      this.transmitFrame(ack, 'ack').catch((err: unknown) =>
        this.emit('error', err instanceof Error ? err : new Error(String(err))),
      );
    }, this.ackTurnaroundMs());
  }

  private expectAck(
    from: number,
    seq: number,
  ): { wait(ms: number): Promise<boolean>; cancel(): void; ackedAt(): number | null } {
    const key = (from << 8) | seq;
    let resolveAck: (acked: boolean) => void = () => undefined;
    const promise = new Promise<boolean>((resolve) => {
      resolveAck = resolve;
    });
    let arrivedAt: number | null = null;
    const settle = (acked: boolean): void => {
      if (acked && arrivedAt === null) arrivedAt = now();
      resolveAck(acked);
    };
    this.pendingAcks.set(key, settle);
    return {
      ackedAt: () => arrivedAt,
      wait: (ms) => {
        const timer = setTimeout(() => settle(false), ms);
        return promise.finally(() => {
          clearTimeout(timer);
          this.pendingAcks.delete(key);
        });
      },
      cancel: () => {
        this.pendingAcks.delete(key);
        settle(false);
      },
    };
  }

  private setState(next: LinkState): void {
    if (this.linkState === next) return;
    this.linkState = next;
    this.emit('state', next);
  }
}
