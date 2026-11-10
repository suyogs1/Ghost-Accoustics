import { estimateAirtimeSeconds, frameBytesForPayload } from '@ghost-acoustics/core/airtime';
import {
  BASELINE_BITRATE_BPS,
  CRC_BYTES,
  HEADER_BYTES,
  MAX_AIRTIME_SECONDS,
  MAX_PAYLOAD_BYTES,
  SINGLE_FRAME_MAX_BYTES,
} from '@ghost-acoustics/core/constants';

export interface AirtimeBudgetResult {
  readonly headerBytes: number;
  readonly payloadBytes: number;
  readonly crcBytes: number;
  readonly totalFrameBytes: number;
  readonly airtimeSeconds: number;
  /** True when the frame is over 32 bytes or over 4.0 s. */
  readonly exceedsSingleFrameBudget: boolean;
  /** True when the payload alone cannot fit the 64-byte MTU. */
  readonly exceedsMtu: boolean;
  readonly bitrateBps: number;
}

export function checkAirtimeBudget(payloadBytes: number, baudRate: number = BASELINE_BITRATE_BPS): AirtimeBudgetResult {
  const totalFrameBytes = frameBytesForPayload(payloadBytes);
  const airtimeSeconds = estimateAirtimeSeconds(totalFrameBytes, baudRate);
  return {
    headerBytes: HEADER_BYTES,
    payloadBytes,
    crcBytes: CRC_BYTES,
    totalFrameBytes,
    airtimeSeconds,
    exceedsSingleFrameBudget:
      totalFrameBytes > SINGLE_FRAME_MAX_BYTES || airtimeSeconds > MAX_AIRTIME_SECONDS + 1e-9,
    exceedsMtu: payloadBytes > MAX_PAYLOAD_BYTES,
    bitrateBps: baudRate,
  };
}
