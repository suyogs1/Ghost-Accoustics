# Spec 03: Schema Compiler (`ghostc`)

Requirements use EARS syntax. "The compiler" is `@ghost-acoustics/schema-compiler`. Constants come from `packages/core/src/constants.ts`.

## Schema format

One message per `*.schema.json` file:

```json
{
  "name": "VENUE_CUE",
  "opcode": "0x10",
  "fields": [
    { "name": "cueId", "type": "uint16" },
    { "name": "stageState", "type": "uint8" }
  ]
}
```

Field types and bit widths:

| Type           | Bits | Extra properties         |
|----------------|-----:|--------------------------|
| `uint8`        | 8    |                          |
| `uint16`       | 16   |                          |
| `uint32`       | 32   |                          |
| `boolean`      | 1    |                          |
| `quantizedInt` | `bits` | `min`, `max`, `bits`   |
| `bytes`        | 0..`maxLength` x 8 | `maxLength` (1-52) |

## Requirements

### Schema validation

1. THE compiler SHALL require `name` to match `/^[A-Z][A-Z0-9_]*$/` and each field name to match `/^[a-z][A-Za-z0-9]*$/`.
2. THE compiler SHALL require `opcode` to be an integer or `0x..` hex string in `0x10..0xFF`.
3. IF two schemas share a message name or an opcode, THEN THE compiler SHALL fail and SHALL NOT write output.
4. IF a field name repeats within a message, THEN THE compiler SHALL fail.
5. IF a schema contains an unknown key or an unknown field type, THEN THE compiler SHALL fail and report every problem found in that file.

### Field quantization

6. THE compiler SHALL require `quantizedInt` to declare finite `min` and `max` with `min < max`, and an integer `bits` in `1..32`.
7. WHEN packing a `quantizedInt`, THE serializer SHALL write `q = round((v - min) * (2^bits - 1) / (max - min))`.
8. WHEN unpacking a `quantizedInt`, THE deserializer SHALL return `min + q * (max - min) / (2^bits - 1)`.
9. THE quantization error of a roundtrip SHALL NOT exceed half a step, where `step = (max - min) / (2^bits - 1)`.
10. IF a value is outside `[min, max]` or is NaN, THEN THE serializer SHALL throw a `RangeError` and SHALL NOT clamp or wrap.
11. WHEN packing `uint8`, `uint16` or `uint32`, THE serializer SHALL throw a `RangeError` for any value that is not an integer within the type's range.

### Bit-packing and limits

12. THE compiler SHALL pack fields in declared order, MSB-first, with no padding between fields.
13. THE compiler SHALL zero-pad the final partial byte, so `payloadBytes = ceil(totalBits / 8)`.
14. THE compiler SHALL NOT write field names, type tags or lengths on the wire.
15. IF `payloadBytes` exceeds 52, THEN THE compiler SHALL fail with a payload-size error.
16. THE compiler SHALL compute `frameBytes = 8 (header) + payloadBytes + 4 (CRC-32)`.

### Variable-length bytes

16a. THE compiler SHALL require a `bytes` field to be the last field of its message and to start on a byte boundary.
16b. THE compiler SHALL NOT write a length prefix for a `bytes` field: the receiver SHALL infer its length from the frame's payload length.
16c. THE compiler SHALL compute payload size, frame size and airtime at the field's `maxLength`, and SHALL fail the build if that worst case exceeds a budget.
16d. THE generated `pack` for such a message SHALL throw a `RangeError` when the supplied bytes exceed `maxLength`, and SHALL return the number of bytes actually written.
16e. THE generated `unpack` SHALL accept an `end` bound and SHALL return the `bytes` field as a view into the input buffer (no copy).

### Airtime budget

17. THE compiler SHALL compute `airtimeSeconds = frameBytes * 8 / bitrate_bps`, with a baseline of 64 bps.
18. IF `airtimeSeconds` exceeds 4.0, or `frameBytes` exceeds 32, THEN THE compiler SHALL fail and SHALL NOT write output.
19. THE compiler SHALL print, for every message, the opcode, payload bytes and bits, frame bytes and airtime seconds.

Note: with an 8-byte header and 4-byte trailer, the 4.0 s / 32 byte budget caps a single-frame payload at 20 bytes. The 52-byte payload limit (64-byte MTU) is the outer bound for multi-frame use.

### Generated output

20. THE compiler SHALL write `types.ts`, `serializers.ts` and `opcodes.ts` into the output directory.
21. THE `types.ts` file SHALL contain one strongly typed interface per message and a `MessageTypeMap`.
22. THE `serializers.ts` file SHALL export `pack<Name>(msg, out, offset?)` and `unpack<Name>(buf, out, offset?)` for each message.
23. THE generated `pack` and `unpack` functions SHALL NOT allocate: `pack` writes into a caller-supplied buffer and `unpack` fills a caller-supplied object.
24. THE generated functions SHALL throw `RangeError` when the buffer is too small for the payload.
25. THE `opcodes.ts` file SHALL export a hex-valued `Opcode` registry and an `OPCODE_REGISTRY` with each message's payload bytes, frame bytes and airtime.
26. THE generated serializers SHALL produce byte-identical output to the runtime bit-packer (`packMessage` / `unpackMessage`).
27. THE compiler SHALL produce identical output for identical input (deterministic ordering by opcode).

### Commit guard

28. WHEN a commit stages a `*.schema.json` file, THE pre-commit hook (`.kiro/hooks/pre-commit-airtime-guard.sh`) SHALL run `ghostc check` on it and block the commit if any frame exceeds 4.0 s of airtime.
29. IF the compiler cannot be run, THEN THE hook SHALL block the commit (fail closed).
