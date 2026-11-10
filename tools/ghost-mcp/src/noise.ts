import { MTU_BYTES } from '@ghost-acoustics/core/constants';
import { decodeFrame } from '@ghost-acoustics/core/frame';
import { parseHex, seededRandom, toHex } from './hex';

export interface NoiseResult {
  /** True when the receiver's decoder accepted the (possibly corrupted) frame. */
  readonly delivered: boolean;
  readonly corruptedBits: number;
  readonly totalBits: number;
  /** Why the decoder rejected the frame, when it did. */
  readonly error?: 'BadSync' | 'BadLength' | 'BadCrc';
  /** Delivered although bits were flipped: a CRC-32 collision. */
  readonly undetectedCorruption: boolean;
  readonly receivedHex: string;
}

/**
 * Flips each bit independently with probability `berPercentage / 100`, then runs the
 * real decoder (sync, length and CRC-32 checks). Pass `seed` for a reproducible run.
 */
export function simulateChannelNoise(frameHex: string, berPercentage: number, seed?: number): NoiseResult {
  if (!(berPercentage >= 0 && berPercentage <= 100)) throw new Error('berPercentage must be between 0 and 100');
  const frame = parseHex(frameHex, MTU_BYTES);
  const rand = seed === undefined ? Math.random : seededRandom(seed);
  const p = berPercentage / 100;

  const received = frame.slice();
  let corruptedBits = 0;
  for (let bit = 0; bit < received.length * 8; bit++) {
    if (rand() < p) {
      received[bit >> 3]! ^= 0x80 >> (bit & 7);
      corruptedBits++;
    }
  }

  const result = decodeFrame(received);
  return {
    delivered: result.ok,
    corruptedBits,
    totalBits: frame.length * 8,
    ...(result.ok ? {} : { error: result.error }),
    undetectedCorruption: result.ok && corruptedBits > 0,
    receivedHex: toHex(received),
  };
}
