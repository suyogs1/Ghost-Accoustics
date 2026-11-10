import { ATMOSPHERE_BAND_HZ } from '../profile';

const CENTER_HZ = (ATMOSPHERE_BAND_HZ.lo + ATMOSPHERE_BAND_HZ.hi) / 2; // 550
const SWEEP_HZ = (ATMOSPHERE_BAND_HZ.hi - ATMOSPHERE_BAND_HZ.lo) / 2; // +/- 250
const NOISE_SECONDS = 3;

/** Soft, low-weighted noise (wind-like), generated once per AudioContext. */
const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();
function windBuffer(ctx: AudioContext): AudioBuffer {
  const cached = noiseCache.get(ctx);
  if (cached) return cached;
  const length = ctx.sampleRate * NOISE_SECONDS;
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < length; i++) {
    // Leaky integrator of white noise = brown-ish noise: energy piles up at low frequencies.
    last = (last + 0.04 * (Math.random() * 2 - 1)) / 1.02;
    data[i] = last * 3.5;
  }
  // Cross-fade the loop point so the wind does not click once per cycle.
  const fade = Math.floor(ctx.sampleRate * 0.05);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    data[i] = data[i]! * t + data[length - fade + i]! * (1 - t);
  }
  noiseCache.set(ctx, buffer);
  return buffer;
}

/**
 * Procedural spooky bed for the Haunted Mask profile: wind (looped noise), a gliding
 * sawtooth "howl" and a low square "creak", all pushed through one bandpass filter whose
 * centre drifts between 300 and 800 Hz. It stays far below the data tones (1.9 kHz and up).
 */
export class HauntedMask {
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly nodes: AudioNode[] = [];
  private readonly master: GainNode;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private done = false;

  constructor(
    private readonly ctx: AudioContext,
    private readonly level: number,
  ) {
    const t = ctx.currentTime;
    this.master = ctx.createGain();
    this.master.gain.setValueAtTime(0, t);

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = CENTER_HZ;
    band.Q.value = 3;

    // Slow drift of the filter centre: 300 .. 800 Hz.
    const drift = this.lfo(0.17, SWEEP_HZ);
    drift.connect(band.frequency);

    // Wind.
    const wind = ctx.createBufferSource();
    wind.buffer = windBuffer(ctx);
    wind.loop = true;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.9;
    wind.connect(windGain).connect(band);
    this.sources.push(wind);

    // Howl: sawtooth that glides and wobbles.
    const howl = ctx.createOscillator();
    howl.type = 'sawtooth';
    howl.frequency.value = 150;
    this.lfo(0.23, 55).connect(howl.frequency);
    this.lfo(5.4, 4).connect(howl.frequency);
    const howlGain = ctx.createGain();
    howlGain.gain.value = 0.22;
    this.lfo(0.31, 0.12).connect(howlGain.gain);
    howl.connect(howlGain).connect(band);
    this.sources.push(howl);

    // Creak: a low square wave that swells in and out, rich in harmonics once bandpassed.
    const creak = ctx.createOscillator();
    creak.type = 'square';
    creak.frequency.value = 41;
    this.lfo(0.09, 9).connect(creak.frequency);
    const creakGain = ctx.createGain();
    creakGain.gain.value = 0.08;
    this.lfo(0.41, 0.07).connect(creakGain.gain);
    creak.connect(creakGain).connect(band);
    this.sources.push(creak);

    band.connect(this.master).connect(ctx.destination);
    this.nodes.push(band, this.master, windGain, howlGain, creakGain);
  }

  /** An oscillator-based modulator: value swings +/- `depth` around the target's own value. */
  private lfo(frequencyHz: number, depth: number): GainNode {
    const osc = this.ctx.createOscillator();
    osc.frequency.value = frequencyHz;
    const gain = this.ctx.createGain();
    gain.gain.value = depth;
    osc.connect(gain);
    this.sources.push(osc);
    this.nodes.push(gain);
    return gain;
  }

  /** Begin sounding now (call at the same moment as the data playback). */
  start(fadeInMs = 120): void {
    const t = this.ctx.currentTime;
    for (const s of this.sources) s.start(t);
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(0, t);
    this.master.gain.linearRampToValueAtTime(this.level, t + fadeInMs / 1000);
  }

  /** Ramp to silence over `durationMs`, then release every node. Safe to call repeatedly. */
  fadeOut(durationMs: number): void {
    if (this.done) return;
    const t = this.ctx.currentTime;
    const seconds = Math.max(0.05, durationMs / 1000);
    const param = this.master.gain;
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(0, t + seconds);
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => this.dispose(), durationMs + 60);
  }

  dispose(): void {
    if (this.done) return;
    this.done = true;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        // Already stopped.
      }
    }
    for (const n of this.nodes) n.disconnect();
    this.master.disconnect();
  }
}
