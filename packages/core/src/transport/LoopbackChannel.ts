import { estimateAirtimeSeconds } from '../airtime';
import { BASELINE_BITRATE_BPS } from '../constants';
import type { AcousticChannel, RxMeta } from './channel';

/** In-memory medium shared by loopback endpoints (a "room" with no speakers). */
export class LoopbackBus {
  private readonly endpoints = new Set<LoopbackChannel>();

  /** @internal */
  attach(channel: LoopbackChannel): void {
    this.endpoints.add(channel);
  }

  /** @internal */
  detach(channel: LoopbackChannel): void {
    this.endpoints.delete(channel);
  }

  /** Delivers to every listening endpoint except the sender (no self-echo). */
  broadcast(from: LoopbackChannel, bytes: Uint8Array, meta?: RxMeta): void {
    for (const endpoint of this.endpoints) {
      if (endpoint !== from) endpoint.receive(bytes, meta);
    }
  }
}

/** Process-wide default bus so `new AcousticSocket({ mode: 'loopback' })` just works. */
export const defaultLoopbackBus = new LoopbackBus();

export interface LoopbackChannelOptions {
  readonly bus?: LoopbackBus;
  /**
   * When true, `transmit` takes as long as the real airtime would. Useful for
   * demos; leave false for fast evaluation. Default false.
   */
  readonly simulateAirtime?: boolean;
  readonly bitrateBps?: number;
  /** Fraction (0..1) of received frames to drop, to exercise ARQ. Default 0. */
  readonly lossRate?: number;
  /** Random source for loss decisions, [0,1). Default Math.random. */
  readonly random?: () => number;
}

const clampRate = (rate: number): number => Math.min(1, Math.max(0, rate));

export class LoopbackChannel implements AcousticChannel {
  private readonly bus: LoopbackBus;
  private readonly simulateAirtime: boolean;
  private readonly bitrateBps: number;
  private onBytes: ((bytes: Uint8Array, meta?: RxMeta) => void) | null = null;
  private muted = false;
  private lossRate: number;
  private readonly random: () => number;
  /** Frames discarded because input was muted (mirrors a gated decoder). */
  mutedDrops = 0;
  /** Frames discarded by the simulated loss. */
  lossDrops = 0;

  constructor(options: LoopbackChannelOptions = {}) {
    this.bus = options.bus ?? defaultLoopbackBus;
    this.simulateAirtime = options.simulateAirtime ?? false;
    this.bitrateBps = options.bitrateBps ?? BASELINE_BITRATE_BPS;
    this.lossRate = clampRate(options.lossRate ?? 0);
    this.random = options.random ?? Math.random;
  }

  /** Change the simulated loss while running (0..1). */
  setLossRate(rate: number): void {
    this.lossRate = clampRate(rate);
  }

  async start(onBytes: (bytes: Uint8Array, meta?: RxMeta) => void): Promise<void> {
    this.onBytes = onBytes;
    this.bus.attach(this);
  }

  async stop(): Promise<void> {
    this.onBytes = null;
    this.bus.detach(this);
  }

  async transmit(bytes: Uint8Array): Promise<void> {
    const started = performance.now();
    if (this.simulateAirtime) {
      const ms = estimateAirtimeSeconds(bytes.length, this.bitrateBps) * 1000;
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
    }
    // Copy: the "air" must not alias the sender's buffer.
    const copy = bytes.slice();
    const meta: RxMeta = { measuredAirtimeSeconds: (performance.now() - started) / 1000 };
    // Deliver asynchronously, like a real decoder callback.
    queueMicrotask(() => this.bus.broadcast(this, copy, meta));
  }

  muteInput(muted: boolean): void {
    this.muted = muted;
  }

  /** @internal Called by the bus. */
  receive(bytes: Uint8Array, meta?: RxMeta): void {
    if (!this.onBytes) return;
    if (this.muted) {
      this.mutedDrops++;
      return;
    }
    if (this.lossRate > 0 && this.random() < this.lossRate) {
      this.lossDrops++;
      return;
    }
    this.onBytes(bytes.slice(), meta);
  }
}
