import { estimateAirtimeSeconds, frameBytesForPayload } from '@ghost-acoustics/core/airtime';
import { CRC_BYTES, FRAME_OVERHEAD_BYTES } from '@ghost-acoustics/core/constants';
import {
  WHISPER_MSG_FIXED_BYTES,
  WHISPER_MSG_TEXT_MAX_BYTES,
} from '@ghost-acoustics/schema-compiler/generated/serializers';

export const MAX_TEXT_BYTES = WHISPER_MSG_TEXT_MAX_BYTES;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

export function encodeText(text: string): Uint8Array {
  return encoder.encode(text);
}

export function decodeText(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Cuts `text` to at most `maxBytes` of UTF-8 without splitting a character. */
export function clampToBytes(text: string, maxBytes: number = MAX_TEXT_BYTES): string {
  let out = '';
  let used = 0;
  for (const ch of text) {
    const size = encoder.encode(ch).length;
    if (used + size > maxBytes) break;
    out += ch;
    used += size;
  }
  return out;
}

export interface WireCost {
  readonly textBytes: number;
  readonly payloadBytes: number;
  readonly frameBytes: number;
  readonly airtimeSeconds: number;
}

/** What a message of `textBytes` costs on the wire: the text length rides in the frame, so it is exact. */
export function wireCost(textBytes: number): WireCost {
  const payloadBytes = WHISPER_MSG_FIXED_BYTES + textBytes;
  const frameBytes = frameBytesForPayload(payloadBytes);
  return { textBytes, payloadBytes, frameBytes, airtimeSeconds: estimateAirtimeSeconds(frameBytes) };
}

/** Airtime of the 12-byte (header + CRC, empty payload) ACK that comes back. */
export const ACK_AIRTIME_SECONDS = estimateAirtimeSeconds(FRAME_OVERHEAD_BYTES);
export const ACK_FRAME_BYTES = FRAME_OVERHEAD_BYTES;
export { CRC_BYTES };

export function hex8(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(2, '0')}`;
}

/** Parses a hex node ID such as "0x2A" or "2a". Returns null unless it is in 1..255 (0 is broadcast). */
export function parseNodeId(input: string): number | null {
  const s = input.trim();
  if (!/^(0x)?[0-9a-f]{1,2}$/i.test(s)) return null;
  const value = Number.parseInt(s.replace(/^0x/i, ''), 16);
  return value >= 1 && value <= 255 ? value : null;
}
