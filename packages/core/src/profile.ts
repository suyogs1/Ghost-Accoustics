/**
 * Transmission profiles. Pure data (no DOM), so apps, tools and tests can all import it.
 *
 * Carrier bands were measured by encoding a 16-byte frame with the bundled ggwave build at
 * 44.1 and 48 kHz and taking an FFT (components above 5% of the peak):
 *   AUDIBLE_FAST      1.86 - 6.20 kHz
 *   ULTRASOUND_FAST   14.98 - 19.33 kHz
 * Both take the same airtime for the same payload (1.83 s for 16 bytes), so the airtime
 * budget is identical across profiles.
 */
export type AcousticProfile = 'audible-fast' | 'silent-ghost' | 'haunted-atmosphere';

export interface ProfileInfo {
  readonly id: AcousticProfile;
  /** Full label for dropdowns. */
  readonly label: string;
  readonly description: string;
  /** ggwave protocol key used to modulate the data. */
  readonly protocol: 'GGWAVE_PROTOCOL_AUDIBLE_FAST' | 'GGWAVE_PROTOCOL_ULTRASOUND_FAST';
  /** Where the FSK tones actually sit, in Hz. */
  readonly carrierBandHz: { readonly lo: number; readonly hi: number };
  /**
   * High-pass cutoff applied to the receive path, or null for none. Ultrasound uses it to
   * discard room noise; it sits below the lowest tone so the data survives.
   */
  readonly receiveHighpassHz: number | null;
  /** Overlay a procedural spooky sound while transmitting. */
  readonly atmosphere: boolean;
  /** Needs a sample rate high enough for near-ultrasound (>= 40 kHz). */
  readonly ultrasound: boolean;
}

export const ACOUSTIC_PROFILES: Readonly<Record<AcousticProfile, ProfileInfo>> = {
  'audible-fast': {
    id: 'audible-fast',
    label: 'Audible Fast (Robust)',
    description: 'Standard audible FSK. Works on almost any speaker and microphone.',
    protocol: 'GGWAVE_PROTOCOL_AUDIBLE_FAST',
    carrierBandHz: { lo: 1900, hi: 6200 },
    receiveHighpassHz: null,
    atmosphere: false,
    ultrasound: false,
  },
  'silent-ghost': {
    id: 'silent-ghost',
    label: 'Silent Ghost (ultrasound 15-19 kHz)',
    description:
      'Near-ultrasound FSK that most adults cannot hear. Needs hardware that reproduces and records 15-19 kHz, so range is shorter.',
    protocol: 'GGWAVE_PROTOCOL_ULTRASOUND_FAST',
    carrierBandHz: { lo: 15000, hi: 19300 },
    receiveHighpassHz: 14000,
    atmosphere: false,
    ultrasound: true,
  },
  'haunted-atmosphere': {
    id: 'haunted-atmosphere',
    label: 'Haunted Mask (Kiroween Edition)',
    description: 'Audible FSK hidden under a procedural wind howl and creak. Same data, spookier room.',
    protocol: 'GGWAVE_PROTOCOL_AUDIBLE_FAST',
    carrierBandHz: { lo: 1900, hi: 6200 },
    receiveHighpassHz: null,
    atmosphere: true,
    ultrasound: false,
  },
};

export const PROFILE_ORDER: readonly AcousticProfile[] = ['audible-fast', 'silent-ghost', 'haunted-atmosphere'];
export const DEFAULT_PROFILE: AcousticProfile = 'audible-fast';

/** The haunted mask lives well below the data tones: bandpassed noise swept across this range. */
export const ATMOSPHERE_BAND_HZ = { lo: 300, hi: 800 } as const;

export function isAcousticProfile(value: unknown): value is AcousticProfile {
  return typeof value === 'string' && value in ACOUSTIC_PROFILES;
}
