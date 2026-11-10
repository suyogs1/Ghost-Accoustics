import { estimateAirtimeSeconds } from './airtime';
import {
  CRC_BYTES,
  FRAME_OVERHEAD_BYTES,
  HEADER_BYTES,
  MAX_AIRTIME_SECONDS,
  MAX_PAYLOAD_BYTES,
  MTU_BYTES,
  RESERVED_FLAG_MASK,
  SINGLE_FRAME_MAX_BYTES,
  SYNC_WORD,
} from './constants';
import { crc32 } from './crc32';

/**
 * Wire layout (big-endian), see spec_01_frame_packing.md:
 *
 *   0  sync    u16  0xAA55
 *   2  src     u8   sender peer byte
 *   3  dst     u8   target peer byte (0 = broadcast)
 *   4  seq     u8
 *   5  flags   u8
 *   6  opcode  u8
 *   7  length  u8   payload length N (0..52)
 *   8  payload N bytes
 *   8+N crc32  u32  over bytes [0, 8+N)
 */
export interface Frame {
  src: number;
  dst: number;
  seq: number;
  flags: number;
  opcode: number;
  payload: Uint8Array;
}

export type FrameErrorCode =
  | 'InvalidField'
  | 'PayloadTooLarge'
  | 'BudgetExceeded'
  | 'BadSync'
  | 'BadLength'
  | 'BadCrc';

export class FrameError extends Error {
  readonly code: FrameErrorCode;
  constructor(code: FrameErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'FrameError';
    this.code = code;
  }
}

export type DecodeResult =
  | { readonly ok: true; readonly frame: Frame }
  | { readonly ok: false; readonly error: Exclude<FrameErrorCode, 'InvalidField' | 'PayloadTooLarge' | 'BudgetExceeded'> };

export interface EncodeOptions {
  /** Reject frames over 32 bytes / 4.0 s (single-frame datagram rule). Default true. */
  readonly enforceBudget?: boolean;
  /** Bitrate used for the airtime budget check. */
  readonly bitrateBps?: number;
}

const isByte = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 0xff;

export function encodeFrame(frame: Frame, options: EncodeOptions = {}): Uint8Array {
  const { src, dst, seq, flags, opcode, payload } = frame;
  for (const [name, value] of [['src', src], ['dst', dst], ['seq', seq], ['flags', flags], ['opcode', opcode]] as const) {
    if (!isByte(value)) throw new FrameError('InvalidField', `${name} must be a byte (got ${value})`);
  }
  if ((flags & RESERVED_FLAG_MASK) !== 0) {
    throw new FrameError('InvalidField', 'reserved flag bits must be 0');
  }
  if (payload.length > MAX_PAYLOAD_BYTES) {
    throw new FrameError('PayloadTooLarge', `${payload.length} > ${MAX_PAYLOAD_BYTES} bytes`);
  }

  const total = FRAME_OVERHEAD_BYTES + payload.length;
  if (options.enforceBudget ?? true) {
    const airtime = estimateAirtimeSeconds(total, options.bitrateBps);
    if (total > SINGLE_FRAME_MAX_BYTES || airtime > MAX_AIRTIME_SECONDS + 1e-9) {
      throw new FrameError(
        'BudgetExceeded',
        `${total} B / ${airtime.toFixed(2)} s exceeds ${SINGLE_FRAME_MAX_BYTES} B / ${MAX_AIRTIME_SECONDS.toFixed(1)} s`,
      );
    }
  }

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(0, SYNC_WORD);
  out[2] = src;
  out[3] = dst;
  out[4] = seq;
  out[5] = flags;
  out[6] = opcode;
  out[7] = payload.length;
  out.set(payload, HEADER_BYTES);
  view.setUint32(total - CRC_BYTES, crc32(out, 0, total - CRC_BYTES));
  return out;
}

/** Never throws: returns a typed error for any malformed input. */
export function decodeFrame(bytes: Uint8Array): DecodeResult {
  if (bytes.length < FRAME_OVERHEAD_BYTES || bytes.length > MTU_BYTES) {
    return { ok: false, error: 'BadLength' };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0) !== SYNC_WORD) return { ok: false, error: 'BadSync' };
  if (bytes[7] !== bytes.length - FRAME_OVERHEAD_BYTES) return { ok: false, error: 'BadLength' };
  const end = bytes.length - CRC_BYTES;
  if (crc32(bytes, 0, end) !== view.getUint32(end)) return { ok: false, error: 'BadCrc' };
  return {
    ok: true,
    frame: {
      src: bytes[2]!,
      dst: bytes[3]!,
      seq: bytes[4]!,
      flags: bytes[5]!,
      opcode: bytes[6]!,
      payload: bytes.slice(HEADER_BYTES, end),
    },
  };
}

/** Maps a string peer ID to a 1..255 wire byte (FNV-1a). 0 is reserved for broadcast. */
export function peerIdToByte(peerId: string): number {
  if (peerId.length === 0) throw new RangeError('peerId must not be empty');
  let h = 0x811c9dc5;
  for (let i = 0; i < peerId.length; i++) {
    h = Math.imul(h ^ peerId.charCodeAt(i), 0x01000193) >>> 0;
  }
  return (h % 255) + 1;
}
