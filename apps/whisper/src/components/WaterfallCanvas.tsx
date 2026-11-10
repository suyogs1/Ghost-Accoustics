import { useEffect, useMemo, useRef, useState } from 'react';
import { CARRIER_BAND_HZ, CORE_BAND_HZ, fromAnalyser } from './spectrum';
import type { SpectrumSource } from './spectrum';

interface Props {
  /** A live microphone tap (from AcousticSocket.analyser) ... */
  readonly analyser?: AnalyserNode | null;
  /** ... or any other source, such as the loopback simulation. Wins over `analyser`. */
  readonly source?: SpectrumSource | null;
  readonly simulated?: boolean;
}

const MAX_HZ = 7000;
const FLOOR = 70; // magnitudes below this render as background
const CANVAS_HEIGHT_CSS = 260;
const AXIS_TICKS_KHZ = [0, 1, 2, 3, 4, 5, 6, 7];

/** Obsidian -> deep blue -> neon cyan -> amber -> hot white, as a 256-entry RGB lookup table. */
const STOPS: readonly (readonly [number, number, number, number])[] = [
  [0.0, 6, 8, 14],
  [0.3, 8, 24, 58],
  [0.55, 0, 150, 190],
  [0.75, 25, 230, 255],
  [0.9, 255, 176, 46],
  [1.0, 255, 244, 210],
];

const PALETTE: Uint8ClampedArray = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < STOPS.length - 2 && t > STOPS[k + 1]![0]) k++;
    const a = STOPS[k]!;
    const b = STOPS[k + 1]!;
    const f = (t - a[0]) / (b[0] - a[0]);
    lut[i * 3] = a[1] + (b[1] - a[1]) * f;
    lut[i * 3 + 1] = a[2] + (b[2] - a[2]) * f;
    lut[i * 3 + 2] = a[3] + (b[3] - a[3]) * f;
  }
  return lut;
})();

const OBSIDIAN = `rgb(${PALETTE[0]}, ${PALETTE[1]}, ${PALETTE[2]})`;

export function WaterfallCanvas({ analyser = null, source = null, simulated = false }: Props) {
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
      ctx.fillStyle = OBSIDIAN;
      ctx.fillRect(0, 0, width, height);
      const step = Math.max(1, Math.round(dpr));
      row = ctx.createImageData(width, step);
      if (spectrum) {
        bins = new Uint8Array(spectrum.binCount);
        const binHz = spectrum.sampleRate / 2 / spectrum.binCount;
        columnToBin = new Int32Array(width);
        columnToBinEnd = new Int32Array(width);
        for (let x = 0; x < width; x++) {
          const lo = (x / width) * MAX_HZ;
          const hi = ((x + 1) / width) * MAX_HZ;
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
        data[o] = PALETTE[level * 3]!;
        data[o + 1] = PALETTE[level * 3 + 1]!;
        data[o + 2] = PALETTE[level * 3 + 2]!;
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
  }, [spectrum]);

  const pct = (hz: number): string => `${(hz / MAX_HZ) * 100}%`;

  return (
    <section className="card waterfall" aria-label="Acoustic waterfall">
      <div className="waterfall-head">
        <h2 className="card-title">Acoustic waterfall</h2>
        <div className="waterfall-tools">
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
        <div className="band band-carrier" style={{ left: pct(CARRIER_BAND_HZ.lo), width: pct(CARRIER_BAND_HZ.hi - CARRIER_BAND_HZ.lo) }}>
          <span className="band-label">FSK carrier ≈ 1.9–6.2 kHz</span>
        </div>
        <div className="band band-core" style={{ left: pct(CORE_BAND_HZ.lo), width: pct(CORE_BAND_HZ.hi - CORE_BAND_HZ.lo) }}>
          <span className="band-label">2–4 kHz</span>
        </div>
        {!spectrum && <p className="waterfall-empty">Start the radio to see the live microphone spectrum.</p>}
      </div>

      <div className="axis" aria-hidden="true">
        {AXIS_TICKS_KHZ.map((k) => (
          <span key={k} style={{ left: pct(k * 1000) }}>
            {k} kHz
          </span>
        ))}
      </div>
    </section>
  );
}
