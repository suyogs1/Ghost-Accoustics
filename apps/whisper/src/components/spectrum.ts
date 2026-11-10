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

/** Where ggwave's FSK tones live (measured from its audible-fast encoder at 48 kHz). */
export const CARRIER_BAND_HZ = { lo: 1900, hi: 6200 } as const;
/** The dense core of the carrier band. */
export const CORE_BAND_HZ = { lo: 2000, hi: 4000 } as const;

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

  setTransmitting(owner: string, on: boolean): void {
    if (on) this.transmitting.add(owner);
    else this.transmitting.delete(owner);
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
    if (now >= this.nextHopAt || this.tones.length === 0) {
      // ggwave spaces its tones 46.875 Hz apart; each symbol lights up several of them at once.
      const spacing = Math.max(1, Math.round(46.875 / binHz));
      const lo = Math.floor(CARRIER_BAND_HZ.lo / binHz);
      const slots = Math.floor((CARRIER_BAND_HZ.hi - CARRIER_BAND_HZ.lo) / 46.875);
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
