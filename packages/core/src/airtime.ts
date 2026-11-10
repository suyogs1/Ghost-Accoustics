import {
  BASELINE_BITRATE_BPS,
  FRAME_OVERHEAD_BYTES,
  PROTOCOL_OVERHEAD_SECONDS,
} from './constants';

/** Total wire bytes for a payload: header (8) + payload + CRC-32 (4). */
export function frameBytesForPayload(payloadBytes: number): number {
  return FRAME_OVERHEAD_BYTES + payloadBytes;
}

/** Estimated airtime in seconds: (bytes * 8) / bitrate + fixed overhead. */
export function estimateAirtimeSeconds(
  frameBytes: number,
  bitrateBps: number = BASELINE_BITRATE_BPS,
): number {
  if (!(bitrateBps > 0)) throw new RangeError('bitrateBps must be > 0');
  return (frameBytes * 8) / bitrateBps + PROTOCOL_OVERHEAD_SECONDS;
}
