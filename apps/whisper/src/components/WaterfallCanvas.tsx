import { useEffect, useMemo, useRef, useState } from 'react';
import { ACOUSTIC_PROFILES, ATMOSPHERE_BAND_HZ } from '@ghost-acoustics/core/profile';
import type { AcousticProfile } from '@ghost-acoustics/core/profile';
import { fromAnalyser } from './spectrum';
import type { SpectrumSource } from './spectrum';

interface Props {
  /** A live microphone tap (from AcousticSocket.analyser) ... */
  readonly analyser?: AnalyserNode | null;
  /** ... or any other source, such as the loopback simulation. Wins over `analyser`. */
  readonly source?: SpectrumSource | null;
  readonly simulated?: boolean;
  /** Selects the highlighted carrier band, the frequency window and the colour theme. */
  readonly profile: AcousticProfile;
}

/** The frequency window shown for each profile (the ultrasound one starts high to give the band room). */
const VIEW_HZ: Record<AcousticProfile, { from: number; to: number; ticksKhz: number[] }> = {
  'audible-fast': { from: 0, to: 7000, ticksKhz: [0, 1, 2, 3, 4, 5, 6, 7] },
  'haunted-atmosphere': { from: 0, to: 7000, ticksKhz: [0, 1, 2, 3, 4, 5, 6, 7] },
  'silent-ghost': { from: 12000, to: 22000, ticksKhz: [12, 14, 16, 18, 20, 22] },
};
/** The 2-4 kHz stretch where the audible tones are densest. */
const CORE_BAND_HZ = { lo: 2000, hi: 4000 } as const;
const FLOOR = 70; // magnitudes below this render as background
const CANVAS_HEIGHT_CSS = 260;

type Stop = readonly [position: number, r: number, g: number, b: number];

/** Builds a 256-entry RGB lookup table by interpolating between colour stops. */
function makePalette(stops: readonly Stop[]): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1]![0]) k++;
    const a = stops[k]!;
    const b = stops[k + 1]!;
    const f = (t - a[0]) / (b[0] - a[0]);
    lut[i * 3] = a[1] + (b[1] - a[1]) * f;
    lut[i * 3 + 1] = a[2] + (b[2] - a[2]) * f;
    lut[i * 3 + 2] = a[3] + (b[3] - a[3]) * f;
  }
  return lut;
}

/** Obsidian -> deep blue -> neon cyan -> amber -> hot white. */
const NEON_PALETTE = makePalette([
  [0.0, 6, 8, 14],
  [0.3, 8, 24, 58],
  [0.55, 0, 150, 190],
  [0.75, 25, 230, 255],
  [0.9, 255, 176, 46],
  [1.0, 255, 244, 210],
]);

/** Haunted Mask: obsidian -> bruised violet -> ectoplasm green -> pale bone. */
const HAUNTED_PALETTE = makePalette([
  [0.0, 8, 6, 14],
  [0.3, 38, 14, 70],
  [0.55, 118, 52, 190],
  [0.78, 120, 255, 110],
  [0.92, 214, 255, 170],
  [1.0, 250, 255, 232],
]);

function Ghost() {
  return (
    <svg className="ghost" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M12 2C7.6 2 5 5.3 5 9.4V21l2.4-2 2.3 2 2.3-2 2.3 2 2.3-2 2.4 2V9.4C19 5.3 16.4 2 12 2z" fill="currentColor" />
      <circle cx="9.3" cy="9.6" r="1.5" fill="#1a0f2b" />
      <circle cx="14.7" cy="9.6" r="1.5" fill="#1a0f2b" />
    </svg>
  );
}

export function WaterfallCanvas({ analyser = null, source = null, simulated = false, profile }: Props) {
  const info = ACOUSTIC_PROFILES[profile];
  const view = VIEW_HZ[profile];
  const haunted = info.atmosphere;
  const palette = haunted ? HAUNTED_PALETTE : NEON_PALETTE;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  const spectrum = useMemo<SpectrumSource | null>(
    () => source ?? (analyser ? fromAnalyser(analyser) : null),
    [source, analyser],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let row: ImageData | null = null;
    let bins = new Uint8Array(spectrum?.binCount ?? 1);
    let columnToBin: Int32Array = new Int32Array(0);
    let columnToBinEnd: Int32Array = new Int32Array(0);

    const layout = (): void => {
      const dpr = window.devicePixelRatio || 1;
      width = Math.max(1, Math.floor(wrap.clientWidth * dpr));
      height = Math.max(1, Math.floor(CANVAS_HEIGHT_CSS * dpr));
      canvas.width = width;
      canvas.height = height;
      ctx.fillStyle = `rgb(${palette[0]}, ${palette[1]}, ${palette[2]})`;
      ctx.fillRect(0, 0, width, height);
      const step = Math.max(1, Math.round(dpr));
      row = ctx.createImageData(width, step);
      if (spectrum) {
        bins = new Uint8Array(spectrum.binCount);
        const binHz = spectrum.sampleRate / 2 / spectrum.binCount;
        columnToBin = new Int32Array(width);
        columnToBinEnd = new Int32Array(width);
        for (let x = 0; x < width; x++) {
          const lo = view.from + (x / width) * (view.to - view.from);
          const hi = view.from + ((x + 1) / width) * (view.to - view.from);
          columnToBin[x] = Math.min(spectrum.binCount - 1, Math.floor(lo / binHz));
          columnToBinEnd[x] = Math.min(spectrum.binCount - 1, Math.max(columnToBin[x]!, Math.floor(hi / binHz)));
        }
      }
    };
    layout();

    const observer = new ResizeObserver(layout);
    observer.observe(wrap);

    let raf = 0;
    const frame = (): void => {
      raf = requestAnimationFrame(frame);
      if (!row || !spectrum || pausedRef.current) return;
      const dpr = window.devicePixelRatio || 1;
      const step = Math.max(1, Math.round(dpr));

      // Scroll the history down by one row, then paint the newest spectrum slice at the top.
      ctx.drawImage(canvas, 0, 0, width, height - step, 0, step, width, height - step);
      spectrum.read(bins as Uint8Array<ArrayBuffer>);
      const data = row.data;
      for (let x = 0; x < width; x++) {
        let peak = 0;
        for (let b = columnToBin[x]!; b <= columnToBinEnd[x]!; b++) if (bins[b]! > peak) peak = bins[b]!;
        // Gate the room noise, then stretch what is left so packets stand out.
        const norm = peak <= FLOOR ? 0 : (peak - FLOOR) / (255 - FLOOR);
        const level = Math.min(255, Math.round(Math.pow(norm, 0.75) * 255));
        const o = x * 4;
        data[o] = palette[level * 3]!;
        data[o + 1] = palette[level * 3 + 1]!;
        data[o + 2] = palette[level * 3 + 2]!;
        data[o + 3] = 255;
      }
      for (let r = 1; r < step; r++) data.copyWithin(r * width * 4, 0, width * 4);
      ctx.putImageData(row, 0, 0);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [spectrum, palette, view]);

  const pct = (hz: number): string => `${((hz - view.from) / (view.to - view.from)) * 100}%`;
  const carrier = info.carrierBandHz;
  const khz = (hz: number): string => (hz / 1000).toFixed(1);

  return (
    <section className={`card waterfall ${haunted ? 'is-haunted' : ''}`} aria-label="Acoustic waterfall">
      <div className="waterfall-head">
        <h2 className="card-title">Acoustic waterfall</h2>
        <div className="waterfall-tools">
          {haunted && (
            <span className="chip chip-haunted" role="status">
              <Ghost /> HAUNTED MASK
            </span>
          )}
          {simulated && <span className="chip chip-sim">simulated signal</span>}
          {!spectrum && <span className="chip">no signal source</span>}
          <button type="button" className="btn btn-small" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
            {paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </div>

      <div className="waterfall-frame" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="waterfall-canvas"
          style={{ height: CANVAS_HEIGHT_CSS }}
          role="img"
          aria-label="Scrolling spectrogram: frequency left to right, newest at the top"
        />
        <div
          className={`band band-carrier ${info.ultrasound ? 'is-ultrasound' : ''}`}
          style={{ left: pct(carrier.lo), width: pct(carrier.hi + view.from - carrier.lo) }}
        >
          <span className="band-label">
            {info.ultrasound ? 'Silent Ghost carrier' : 'FSK carrier'} ≈ {khz(carrier.lo)}–{khz(carrier.hi)} kHz
          </span>
        </div>
        {!info.ultrasound && (
          <div className="band band-core" style={{ left: pct(CORE_BAND_HZ.lo), width: pct(CORE_BAND_HZ.hi + view.from - CORE_BAND_HZ.lo) }}>
            <span className="band-label">2–4 kHz</span>
          </div>
        )}
        {haunted && (
          <div
            className="band band-mask"
            style={{ left: pct(ATMOSPHERE_BAND_HZ.lo), width: pct(ATMOSPHERE_BAND_HZ.hi + view.from - ATMOSPHERE_BAND_HZ.lo) }}
          >
            <span className="band-label band-label-mask">wind mask</span>
          </div>
        )}
        {haunted && <div className="mist" aria-hidden="true" />}
        {!spectrum && <p className="waterfall-empty">Start the radio to see the live microphone spectrum.</p>}
      </div>

      <div className="axis" aria-hidden="true">
        {view.ticksKhz.map((k) => (
          <span key={k} style={{ left: pct(k * 1000) }}>
            {k} kHz
          </span>
        ))}
      </div>
    </section>
  );
}
