import {
  BASELINE_BITRATE_BPS,
  CRC_BYTES,
  HEADER_BYTES,
  MAX_AIRTIME_SECONDS,
  MAX_PAYLOAD_BYTES,
  SINGLE_FRAME_MAX_BYTES,
} from '@ghost-acoustics/core/constants';
import { estimateAirtimeSeconds, frameBytesForPayload } from '@ghost-acoustics/core/airtime';

export interface AirtimeReport {
  readonly payloadBits: number;
  readonly payloadBytes: number;
  readonly headerBytes: number;
  readonly crcBytes: number;
  /** Header (8) + payload + CRC-32 (4). */
  readonly frameBytes: number;
  readonly airtimeSeconds: number;
  readonly bitrateBps: number;
  /** Human-readable budget violations; empty when the message is within budget. */
  readonly violations: readonly string[];
  readonly ok: boolean;
}

/** Exact frame size and airtime for a payload, plus budget verdicts. */
export class AirtimeCalculator {
  readonly bitrateBps: number;

  constructor(bitrateBps: number = BASELINE_BITRATE_BPS) {
    if (!(bitrateBps > 0) || !Number.isFinite(bitrateBps)) throw new RangeError('bitrateBps must be a positive number');
    this.bitrateBps = bitrateBps;
  }

  frameBytes(payloadBytes: number): number {
    return frameBytesForPayload(payloadBytes);
  }

  airtimeSeconds(frameBytes: number): number {
    return estimateAirtimeSeconds(frameBytes, this.bitrateBps);
  }

  analyze(payloadBits: number): AirtimeReport {
    const payloadBytes = Math.ceil(payloadBits / 8);
    const frameBytes = this.frameBytes(payloadBytes);
    const airtimeSeconds = this.airtimeSeconds(frameBytes);

    const violations: string[] = [];
    if (payloadBytes > MAX_PAYLOAD_BYTES) {
      violations.push(`payload ${payloadBytes} B exceeds the ${MAX_PAYLOAD_BYTES} B maximum`);
    }
    if (frameBytes > SINGLE_FRAME_MAX_BYTES) {
      violations.push(`frame ${frameBytes} B exceeds the ${SINGLE_FRAME_MAX_BYTES} B single-frame budget`);
    }
    if (airtimeSeconds > MAX_AIRTIME_SECONDS + 1e-9) {
      violations.push(
        `airtime ${airtimeSeconds.toFixed(3)} s exceeds the ${MAX_AIRTIME_SECONDS.toFixed(1)} s budget at ${this.bitrateBps} bps`,
      );
    }

    return {
      payloadBits,
      payloadBytes,
      headerBytes: HEADER_BYTES,
      crcBytes: CRC_BYTES,
      frameBytes,
      airtimeSeconds,
      bitrateBps: this.bitrateBps,
      violations,
      ok: violations.length === 0,
    };
  }
}
