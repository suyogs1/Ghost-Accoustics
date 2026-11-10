import { ACOUSTIC_PROFILES, ATMOSPHERE_BAND_HZ, DEFAULT_PROFILE } from '@ghost-acoustics/core/profile';
import type { AcousticProfile } from '@ghost-acoustics/core/profile';

/** Anything the waterfall can draw: a live AnalyserNode or a simulated source. */
export interface SpectrumSource {
  readonly sampleRate: number;
  /** Number of frequency bins `read` fills; bin i covers i * sampleRate / (2 * binCount) Hz. */
  readonly binCount: number;
  /** Fills `out` (length >= binCount) with magnitudes 0..255. */
  read(out: Uint8Array<ArrayBuffer>): void;
}

export function fromAnalyser(analyser: AnalyserNode): SpectrumSource {
  return {
    sampleRate: analyser.context.sampleRate,
    binCount: analyser.frequencyBinCount,
    read: (out) => analyser.getByteFrequencyData(out),
  };
}

/**
 * Stand-in spectrum for Loopback Simulation, where no audio is produced: a noise floor
 * plus hopping multi-tone bursts across the carrier band while any node is "transmitting".
 */
export class SimulatedSpectrum implements SpectrumSource {
  readonly sampleRate = 48_000;
  readonly binCount = 2048;
  private readonly transmitting = new Set<string>();
  private tones: number[] = [];
  private nextHopAt = 0;
  private profile: AcousticProfile = DEFAULT_PROFILE;

  setTransmitting(owner: string, on: boolean): void {
    if (on) this.transmitting.add(owner);
    else this.transmitting.delete(owner);
  }

  /** Move the simulated carrier to the band of the selected profile. */
  setProfile(profile: AcousticProfile): void {
    if (profile === this.profile) return;
    this.profile = profile;
    this.tones = [];
  }

  read(out: Uint8Array<ArrayBuffer>): void {
    const binHz = this.sampleRate / 2 / this.binCount;
    // Room noise: stronger at the low end, a gentle random shimmer elsewhere.
    for (let i = 0; i < this.binCount; i++) {
      const hz = i * binHz;
      const lowRumble = hz < 600 ? 55 * (1 - hz / 600) : 0;
      out[i] = Math.min(255, 38 + Math.random() * 16 + lowRumble);
    }
    if (this.transmitting.size === 0) return;

    const now = performance.now();
    const info = ACOUSTIC_PROFILES[this.profile];

    // Haunted Mask: a slow swirl of wind energy between 300 and 800 Hz under the data.
    if (info.atmosphere) {
      const centre = (ATMOSPHERE_BAND_HZ.lo + ATMOSPHERE_BAND_HZ.hi) / 2 + 250 * Math.sin(now / 1800);
      for (let i = 0; i < this.binCount; i++) {
        const hz = i * binHz;
        if (hz > ATMOSPHERE_BAND_HZ.hi + 150) break;
        const falloff = Math.exp(-(((hz - centre) / 140) ** 2));
        out[i] = Math.max(out[i]!, 95 + 130 * falloff * (0.7 + Math.random() * 0.3));
      }
    }

    if (now >= this.nextHopAt || this.tones.length === 0) {
      // ggwave spaces its tones 46.875 Hz apart; each symbol lights up several of them at once.
      const spacing = Math.max(1, Math.round(46.875 / binHz));
      const lo = Math.floor(info.carrierBandHz.lo / binHz);
      const slots = Math.floor((info.carrierBandHz.hi - info.carrierBandHz.lo) / 46.875);
      this.tones = Array.from({ length: 7 }, () => lo + Math.floor(Math.random() * slots) * spacing);
      this.nextHopAt = now + 45; // one FSK symbol
    }
    for (const bin of this.tones) {
      for (let d = -2; d <= 2; d++) {
        const i = bin + d;
        if (i < 0 || i >= this.binCount) continue;
        const strength = d === 0 ? 255 : Math.abs(d) === 1 ? 225 : 170;
        out[i] = Math.max(out[i]!, strength - Math.random() * 20);
      }
    }
  }
}
