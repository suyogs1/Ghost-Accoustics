import { estimateAirtimeSeconds } from '@ghost-acoustics/core/airtime';
import {
  CRC_BYTES,
  CoreOpcode,
  FRAME_OVERHEAD_BYTES,
  Flags,
  HEADER_BYTES,
  MTU_BYTES,
  RESERVED_FLAG_MASK,
  SYNC_WORD,
} from '@ghost-acoustics/core/constants';
import { crc32 } from '@ghost-acoustics/core/crc32';
import { OPCODE_REGISTRY } from '@ghost-acoustics/schema-compiler/generated/opcodes';
import { parseHex, toHex } from './hex';

const h8 = (n: number): string => `0x${n.toString(16).toUpperCase().padStart(2, '0')}`;
const h32 = (n: number): string => `0x${n.toString(16).toUpperCase().padStart(8, '0')}`;

function describeOpcode(opcode: number): { value: number; hex: string; name: string | null; kind: 'core' | 'app' | 'unknown' } {
  const core = Object.entries(CoreOpcode).find(([, v]) => v === opcode);
  if (core) return { value: opcode, hex: h8(opcode), name: core[0], kind: 'core' };
  const app = OPCODE_REGISTRY.find((info) => info.opcode === opcode);
  if (app) return { value: opcode, hex: h8(opcode), name: app.name, kind: 'app' };
  return { value: opcode, hex: h8(opcode), name: null, kind: 'unknown' };
}

export interface PacketInspection {
  readonly totalBytes: number;
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly header?: {
    readonly sync: string;
    readonly syncValid: boolean;
    readonly src: number;
    readonly dst: number;
    readonly broadcast: boolean;
    readonly seq: number;
    readonly flags: {
      readonly raw: string;
      readonly ack: boolean;
      readonly nack: boolean;
      readonly broadcast: boolean;
      readonly encrypted: boolean;
      readonly reservedBitsClear: boolean;
    };
    readonly opcode: ReturnType<typeof describeOpcode>;
    readonly length: number;
    readonly lengthMatches: boolean;
  };
  readonly payloadHex?: string;
  readonly crc32?: {
    readonly stored: string;
    readonly computed: string;
    readonly valid: boolean;
  };
  readonly airtimeSeconds: number;
}

/** Parses a raw frame capture. Always returns a structure, even for malformed input. */
export function inspectPacketCapture(rawHex: string): PacketInspection {
  const bytes = parseHex(rawHex, 4096);
  const errors: string[] = [];
  const airtimeSeconds = estimateAirtimeSeconds(bytes.length);

  if (bytes.length < FRAME_OVERHEAD_BYTES) {
    return {
      totalBytes: bytes.length,
      valid: false,
      errors: [`too short: ${bytes.length} bytes; a frame needs at least ${FRAME_OVERHEAD_BYTES} (header ${HEADER_BYTES} + CRC ${CRC_BYTES})`],
      airtimeSeconds,
    };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sync = view.getUint16(0);
  const flags = bytes[5]!;
  const length = bytes[7]!;
  const syncValid = sync === SYNC_WORD;
  const lengthMatches = length === bytes.length - FRAME_OVERHEAD_BYTES;
  const reservedBitsClear = (flags & RESERVED_FLAG_MASK) === 0;

  const crcOffset = bytes.length - CRC_BYTES;
  const stored = view.getUint32(crcOffset);
  const computed = crc32(bytes, 0, crcOffset);
  const crcValid = stored === computed;

  if (!syncValid) errors.push(`BadSync: expected 0xAA55, got 0x${sync.toString(16).toUpperCase().padStart(4, '0')}`);
  if (bytes.length > MTU_BYTES) errors.push(`BadLength: ${bytes.length} bytes exceeds the ${MTU_BYTES}-byte MTU`);
  if (!lengthMatches) {
    errors.push(`BadLength: length field says ${length} but the capture carries ${bytes.length - FRAME_OVERHEAD_BYTES} payload bytes`);
  }
  if (!crcValid) errors.push(`BadCrc: stored ${h32(stored)}, computed ${h32(computed)}`);
  if (!reservedBitsClear) errors.push('InvalidField: reserved flag bits are set');

  return {
    totalBytes: bytes.length,
    valid: errors.length === 0,
    errors,
    header: {
      sync: `0x${sync.toString(16).toUpperCase().padStart(4, '0')}`,
      syncValid,
      src: bytes[2]!,
      dst: bytes[3]!,
      broadcast: bytes[3] === 0,
      seq: bytes[4]!,
      flags: {
        raw: h8(flags),
        ack: (flags & Flags.ACK) !== 0,
        nack: (flags & Flags.NACK) !== 0,
        broadcast: (flags & Flags.BROADCAST) !== 0,
        encrypted: (flags & Flags.ENCRYPTED) !== 0,
        reservedBitsClear,
      },
      opcode: describeOpcode(bytes[6]!),
      length,
      lengthMatches,
    },
    payloadHex: toHex(bytes.subarray(HEADER_BYTES, crcOffset)),
    crc32: { stored: h32(stored), computed: h32(computed), valid: crcValid },
    airtimeSeconds,
  };
}
