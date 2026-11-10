# Airtime Budget Rules

Sound is slow (about 8-16 bytes/second). Every byte has a physical time cost, so the airtime budget is a hard constraint, not a guideline.

## Hard limits

- A single-frame datagram MUST NOT exceed **32 wire bytes** (sync word, header, payload and CRC-32 all included).
- A single-frame datagram MUST NOT exceed **4.0 seconds** of estimated airtime.
- Both limits apply together. A frame that violates either one is rejected.
- The 64-byte MTU in `spec_01_frame_packing.md` is the absolute framing ceiling. The 32-byte limit is the stricter budget for single-frame datagrams. Frames between 33 and 64 bytes are only allowed through explicit multi-frame paths, never as a single datagram.

## Airtime formula

```
airtime_seconds = (wire_bytes * 8) / effective_bitrate_bps + protocol_overhead_seconds
```

- `effective_bitrate_bps` and `protocol_overhead_seconds` come from one shared constants module in `packages/core`. Never hardcode them elsewhere.
- Planning default: 8 bytes/second (conservative end of the 8-16 range).

## Encoding rules

- Bit-pack. Do NOT put raw JSON, UTF-8 field names, or text-encoded numbers on the wire.
- Every numeric field declares a range and quantization step in its schema. Use the fewest bits that cover it.
- Booleans take 1 bit. Enums take `ceil(log2(n))` bits. Field names never go on the wire.
- Prefer small IDs (cue IDs of 2-4 bytes) over descriptive strings.
- Schema compiler output MUST report exact wire byte length and estimated airtime for every message, and fail the build when a limit is exceeded.

## Checklist for any new message type

1. Declare fields with range and quantization.
2. Compile it and read the reported wire bytes and airtime.
3. Confirm wire bytes <= 32 and airtime <= 4.0 s.
4. Add a property-based test covering the bound (see `spec_02_property_based_tests.md`).
