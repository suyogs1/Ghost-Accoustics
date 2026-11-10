import type { AcousticChannel, RxMeta } from './channel';

/**
 * getUserMedia constraints mandated by .kiro/steering/02_audio_hardware_guards.md.
 * Never rely on browser defaults for these flags.
 */
export const RAW_AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  },
  video: false,
};

/** Subset of the ggwave WASM module used by the runtime. */
export interface GgwaveParameters {
  sampleRateInp: number;
  sampleRateOut: number;
  [key: string]: unknown;
}

export interface GgwaveModule {
  getDefaultParameters(): GgwaveParameters;
  init(parameters: GgwaveParameters): number;
  /** Returns Float32 samples as raw bytes. */
  encode(instance: number, payload: Uint8Array, protocol: number, volume: number): Int8Array;
  /** `samples` is a Float32 chunk viewed as bytes. Returns the payload, or empty if none yet. */
  decode(instance: number, samples: Int8Array): Uint8Array | Int8Array | null | undefined;
  ProtocolId: Record<string, number>;
}

export type GgwaveFactory = () => Promise<GgwaveModule>;

export interface WebAudioChannelOptions {
  /** Defaults to the global `ggwave_factory` provided by ggwave.js. */
  readonly ggwaveFactory?: GgwaveFactory;
  /** Reuse an existing AudioContext (it is then not closed on stop). */
  readonly audioContext?: AudioContext;
  /** ggwave protocol key, e.g. GGWAVE_PROTOCOL_AUDIBLE_FAST (the spike default). */
  readonly protocol?: string;
  /** ggwave volume, 0-100. Keep moderate: clipping adds harmonics. Default 25. */
  readonly volume?: number;
  /**
   * Open the microphone and decode incoming audio. Default true.
   * Set false for transmit-only roles (e.g. a stage broadcaster) to avoid a mic prompt.
   */
  readonly receive?: boolean;
  /** Speaker to use (from enumerateDevices). Ignored where AudioContext.setSinkId is unsupported. */
  readonly outputDeviceId?: string;
  readonly onWarning?: (message: string) => void;
}

const CAPTURE_CHUNK = 1024;
const WORKLET_NAME = 'ghost-capture';
const WORKLET_SOURCE = `
class GhostCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${CAPTURE_CHUNK}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === ${CAPTURE_CHUNK}) {
        const out = this.buf.slice();
        this.port.postMessage(out, [out.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('${WORKLET_NAME}', GhostCapture);
`;

const RAW_FLAGS = ['echoCancellation', 'noiseSuppression', 'autoGainControl'] as const;

/** RMS above this (about -48 dBFS) marks the start of a transmission. */
const ONSET_RMS = 0.004;
/** Silence this long ends the current onset window. */
const QUIET_RESET_MS = 700;

type SinkCapableContext = AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };

function defaultFactory(): GgwaveFactory {
  const factory = (globalThis as { ggwave_factory?: GgwaveFactory }).ggwave_factory;
  if (!factory) {
    throw new Error('ggwave not loaded: include ggwave.js or pass `ggwaveFactory`.');
  }
  return factory;
}

/** Real speaker/microphone channel: ggwave over WebAudio with raw (unprocessed) capture. */
export class WebAudioChannel implements AcousticChannel {
  private ctx: AudioContext | null = null;
  private ownsContext = false;
  private ggwave: GgwaveModule | null = null;
  private instance = 0;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private muted = false;
  private volume: number;
  private outputDeviceId: string | undefined;
  private readonly warn: (message: string) => void;

  // Receive-side signal tracking (for measured airtime and level).
  private onsetMs: number | null = null;
  private lastActiveMs = 0;
  private peakRms = 0;
  /** Smoothed RMS of quiet audio, used as the noise floor for SNR estimates. */
  private noiseRms = 0;
  private analyser: AnalyserNode | null = null;

  constructor(private readonly options: WebAudioChannelOptions = {}) {
    this.warn = options.onWarning ?? ((m) => console.warn(`[ghost-acoustics] ${m}`));
    this.volume = options.volume ?? 25;
    this.outputDeviceId = options.outputDeviceId;
  }

  async start(onBytes: (bytes: Uint8Array, meta?: RxMeta) => void): Promise<void> {
    if (this.ctx) return;
    const ctx = this.options.audioContext ?? new AudioContext();
    this.ownsContext = !this.options.audioContext;
    this.ctx = ctx;
    // Must run from a user gesture (autoplay policy).
    await ctx.resume();
    await this.applyOutputDevice();

    const ggwave = await (this.options.ggwaveFactory ?? defaultFactory())();
    const params = ggwave.getDefaultParameters();
    params.sampleRateInp = ctx.sampleRate;
    params.sampleRateOut = ctx.sampleRate;
    this.instance = ggwave.init(params);
    this.ggwave = ggwave;

    if (this.options.receive === false) return;
    await this.startCapture(ctx, onBytes);
  }

  private async startCapture(ctx: AudioContext, onBytes: (bytes: Uint8Array, meta?: RxMeta) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia(RAW_AUDIO_CONSTRAINTS);
    const settings = this.stream.getAudioTracks()[0]?.getSettings() ?? {};
    for (const flag of RAW_FLAGS) {
      if (settings[flag] !== false) {
        this.warn(`browser left ${flag} = ${String(settings[flag])}; decoding may be unreliable`);
      }
    }

    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(ctx, WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (this.muted || !this.ggwave) {
        this.onsetMs = null;
        return;
      }
      const chunk = event.data;
      const nowMs = performance.now();
      this.trackSignal(chunk, ctx.sampleRate, nowMs);

      const result = this.ggwave.decode(
        this.instance,
        new Int8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      );
      if (result && result.length > 0) {
        const peakDb = this.peakRms > 0 ? 20 * Math.log10(this.peakRms) : null;
        const noiseDb = this.noiseRms > 0 ? 20 * Math.log10(this.noiseRms) : null;
        const meta: RxMeta = {
          ...(this.onsetMs !== null ? { measuredAirtimeSeconds: (nowMs - this.onsetMs) / 1000 } : {}),
          ...(peakDb !== null ? { peakLevelDb: peakDb } : {}),
          ...(noiseDb !== null ? { noiseFloorDb: noiseDb } : {}),
          ...(peakDb !== null && noiseDb !== null ? { snrDb: peakDb - noiseDb } : {}),
        };
        this.onsetMs = null;
        this.peakRms = 0;
        onBytes(new Uint8Array(result), meta);
      }
    };
    this.node = node;

    // No voice filters in the receive chain: mic -> worklet -> silent sink.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    const source = ctx.createMediaStreamSource(this.stream);
    source.connect(node);
    // Passive spectrum tap for visualisation; it changes nothing in the decode path.
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.35;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -25;
    source.connect(analyser);
    this.analyser = analyser;
    node.connect(sink);
    sink.connect(ctx.destination);
  }

  private trackSignal(chunk: Float32Array, sampleRate: number, nowMs: number): void {
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) sum += chunk[i]! * chunk[i]!;
    const rms = Math.sqrt(sum / chunk.length);
    if (rms > ONSET_RMS) {
      if (this.onsetMs === null) {
        this.onsetMs = nowMs - (chunk.length / sampleRate) * 1000;
        this.peakRms = 0;
      }
      this.lastActiveMs = nowMs;
      if (rms > this.peakRms) this.peakRms = rms;
    } else {
      // Quiet chunk: fold it into the noise floor estimate (slow exponential average).
      this.noiseRms = this.noiseRms === 0 ? rms : this.noiseRms * 0.98 + rms * 0.02;
      if (this.onsetMs !== null && nowMs - this.lastActiveMs > QUIET_RESET_MS) {
        this.onsetMs = null;
        this.peakRms = 0;
      }
    }
  }

  async stop(): Promise<void> {
    this.node?.disconnect();
    this.node = null;
    this.analyser?.disconnect();
    this.analyser = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.ctx && this.ownsContext) await this.ctx.close();
    this.ctx = null;
    this.ggwave = null;
  }

  async transmit(bytes: Uint8Array): Promise<void> {
    const ctx = this.ctx;
    const ggwave = this.ggwave;
    if (!ctx || !ggwave) throw new Error('WebAudioChannel not started');

    const protocolKey = this.options.protocol ?? 'GGWAVE_PROTOCOL_AUDIBLE_FAST';
    const protocol = ggwave.ProtocolId[protocolKey];
    if (protocol === undefined) throw new Error(`Unknown ggwave protocol ${protocolKey}`);

    const raw = ggwave.encode(this.instance, bytes, protocol, this.volume);
    // slice() guarantees a 4-byte-aligned, exactly-sized buffer for the Float32 view.
    const samples = new Float32Array(raw.slice().buffer);
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buffer.copyToChannel(samples, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    await new Promise<void>((resolve) => {
      source.onended = () => resolve();
      source.start();
    });
  }

  muteInput(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      this.onsetMs = null;
      this.peakRms = 0;
    }
  }

  outputLatencyMs(): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    return (ctx.outputLatency || ctx.baseLatency || 0) * 1000;
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  /** Transmit volume, 0-100 (ggwave scale). Takes effect on the next frame. */
  setVolume(volume: number): void {
    this.volume = Math.min(100, Math.max(0, volume));
  }

  /** Switch speaker. Returns false where the browser cannot route audio (e.g. Safari). */
  async setOutputDevice(deviceId: string | undefined): Promise<boolean> {
    this.outputDeviceId = deviceId;
    return this.applyOutputDevice();
  }

  /** Plays a short sine tone at the current volume so users can set device volume by ear. */
  async playTestTone(durationMs = 600, frequencyHz = 1000): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) throw new Error('WebAudioChannel not started');
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const level = (this.volume / 100) * 0.8;
    const t0 = ctx.currentTime;
    const end = t0 + durationMs / 1000;
    osc.frequency.value = frequencyHz;
    // Short fades avoid clicks.
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(level, t0 + 0.03);
    gain.gain.setValueAtTime(level, end - 0.05);
    gain.gain.linearRampToValueAtTime(0, end);
    osc.connect(gain).connect(ctx.destination);
    await new Promise<void>((resolve) => {
      osc.onended = () => resolve();
      osc.start(t0);
      osc.stop(end);
    });
  }

  private async applyOutputDevice(): Promise<boolean> {
    const ctx = this.ctx as SinkCapableContext | null;
    if (!ctx || this.outputDeviceId === undefined) return true;
    if (typeof ctx.setSinkId !== 'function') {
      this.warn('this browser cannot select an output device; using the system default');
      return false;
    }
    try {
      await ctx.setSinkId(this.outputDeviceId);
      return true;
    } catch (err) {
      this.warn(`could not switch output device: ${String(err)}`);
      return false;
    }
  }
}
