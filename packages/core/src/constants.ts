/**
 * Single source of truth for wire-format and airtime constants.
 * Everything else (schema compiler, apps, MCP tools) imports from here.
 * See .kiro/specs/spec_01_frame_packing.md and .kiro/steering/01_airtime_budget_rules.md.
 */

/** Frame sync word, first two bytes on the wire (big-endian). */
export const SYNC_WORD = 0xaa55;

/** sync(2) src(1) dst(1) seq(1) flags(1) opcode(1) length(1). */
export const HEADER_BYTES = 8;
/** CRC-32 trailer. */
export const CRC_BYTES = 4;
/** Header + CRC: bytes added to every payload. */
export const FRAME_OVERHEAD_BYTES = HEADER_BYTES + CRC_BYTES;
/** Absolute framing ceiling. */
export const MTU_BYTES = 64;
/** MTU minus framing overhead. */
export const MAX_PAYLOAD_BYTES = MTU_BYTES - FRAME_OVERHEAD_BYTES;

/** Stricter budget for single-frame datagrams (wire bytes). */
export const SINGLE_FRAME_MAX_BYTES = 32;
/** Stricter budget for single-frame datagrams (seconds). */
export const MAX_AIRTIME_SECONDS = 4.0;

/** Baseline modulation rate used for airtime estimates (64 bps = 8 B/s). */
export const BASELINE_BITRATE_BPS = 64;
/** Fixed per-frame overhead added to the airtime estimate. */
export const PROTOCOL_OVERHEAD_SECONDS = 0;

/** Destination byte meaning "everyone". Real peers map to 1..255. */
export const BROADCAST_PEER = 0x00;

/** Half-duplex clearance after playback ends, before the decoder is unmuted. */
export const DRAIN_CLEARANCE_MS = 150;

/** Frame flag bits. Bits 4-7 are reserved and MUST be zero. */
export const Flags = {
  ACK: 0x01,
  NACK: 0x02,
  BROADCAST: 0x04,
  ENCRYPTED: 0x08,
} as const;
export const RESERVED_FLAG_MASK = 0xf0;

/** Opcodes 0x00-0x0F are reserved for the core protocol. */
export const CoreOpcode = {
  ACK: 0x01,
  NACK: 0x02,
  PING: 0x03,
} as const;
/** First opcode available to applications. */
export const FIRST_APP_OPCODE = 0x10;
export const MAX_OPCODE = 0xff;
