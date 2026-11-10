import type { EmergencyBeacon, VenueCue } from '@ghost-acoustics/schema-compiler/generated/types';

/** Wire values of `VENUE_CUE.stageState`. */
export const STAGE_STATE_NAMES = ['IDLE', 'INTRO', 'VERSE', 'CHORUS', 'OUTRO'] as const;
export type StageStateName = (typeof STAGE_STATE_NAMES)[number];

/** Wire values of `EMERGENCY_BEACON.severity`. */
export const SEVERITY_NAMES: Readonly<Record<number, string>> = { 1: 'LOW', 2: 'MED', 3: 'CRITICAL' };

export function stageStateName(value: number): string {
  return STAGE_STATE_NAMES[value] ?? `UNKNOWN(${value})`;
}

export function severityName(value: number): string {
  return SEVERITY_NAMES[value] ?? `UNKNOWN(${value})`;
}

/** The visual effect a receiver plays is derived from the state alone: nothing extra rides the wire. */
export type EffectName = 'none' | 'strobe' | 'pulse' | 'wave' | 'fade';

export function effectForState(value: number): EffectName {
  switch (STAGE_STATE_NAMES[value]) {
    case 'INTRO':
      return 'strobe';
    case 'VERSE':
      return 'pulse';
    case 'CHORUS':
      return 'wave';
    case 'OUTRO':
      return 'fade';
    default:
      return 'none';
  }
}

export interface CueAction {
  readonly id: 'intro-strobe' | 'chorus-wave' | 'crowd-pulse';
  readonly label: string;
  readonly hint: string;
  readonly cue: VenueCue;
}

export const CUE_ACTIONS: readonly CueAction[] = [
  {
    id: 'intro-strobe',
    label: 'Intro Strobe',
    hint: 'INTRO, gold',
    cue: { cueId: 101, stageState: 1, accentColor: 43 },
  },
  {
    id: 'chorus-wave',
    label: 'Chorus Wave',
    hint: 'CHORUS, cyan',
    cue: { cueId: 301, stageState: 3, accentColor: 128 },
  },
  {
    id: 'crowd-pulse',
    label: 'Crowd Pulse',
    hint: 'VERSE, magenta',
    cue: { cueId: 201, stageState: 2, accentColor: 213 },
  },
];

export const EMERGENCY_ALERT_ID = 911;

export function emergencyBeacon(batteryPct: number): EmergencyBeacon {
  return { alertId: EMERGENCY_ALERT_ID, severity: 3, batteryPct: Math.min(100, Math.max(0, Math.round(batteryPct))) };
}

// ---- palette ---------------------------------------------------------------

/** 256-entry hue wheel: the same index renders the same color on every device. */
export function paletteColor(index: number): string {
  const hue = ((index & 0xff) / 256) * 360;
  return `hsl(${hue.toFixed(1)} 92% 55%)`;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

/** Black or white, whichever is more readable on the palette color (WCAG relative luminance). */
export function readableTextOn(index: number): string {
  const hue = ((index & 0xff) / 256) * 360;
  const [r, g, b] = hslToRgb(hue, 0.92, 0.55).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.3 ? '#0b0d12' : '#ffffff';
}
