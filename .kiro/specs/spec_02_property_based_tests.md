# Spec 02: Property-Based Testing

Property-based tests use [fast-check](https://github.com/dubzzz/fast-check) with Vitest. Requirements use EARS syntax.

## Scope

- `packages/core`: frame encode/decode, CRC-32.
- `packages/schema-compiler`: generated bit-packed serializers/deserializers.
- `tools/ghost-mcp`: `run_pbt_suite` executes these suites on demand.

## Requirements

### Roundtrip losslessness

1. FOR ALL valid frames `f` (src 0-255, dst 0-255, seq 0-255, flags with reserved bits 0, opcode 0-255, payload 0-52 bytes), `decode(encode(f))` SHALL equal `f`.
2. FOR ALL schemas and values inside declared ranges, `deserialize(serialize(v))` SHALL equal `quantize(v)`, where `quantize` rounds to the declared step.
3. FOR ALL values outside a declared range, THE serializer SHALL throw a range error and SHALL NOT wrap silently.
4. FOR ALL byte arrays `b`, `crc32(b)` SHALL be deterministic and SHALL equal a reference table-driven implementation.

### Wire-budget bounds

5. FOR ALL valid single-frame datagrams, `encode(f).length` SHALL be at most 32.
6. FOR ALL valid frames, `encode(f).length` SHALL be at most 64 and SHALL equal `12 + payload.length`.
7. FOR ALL compiled schemas, the reported wire byte length SHALL equal the actual serialized length for every generated value (fixed-width schemas) or bound it from above (variable-width).
8. FOR ALL single-frame datagrams, estimated airtime SHALL be at most 4.0 s and SHALL be monotonically non-decreasing in wire bytes.

### Corruption detection

9. FOR ALL valid frames and any single flipped bit in the encoded bytes, THE decoder SHALL return an error (`BadSync`, `BadLength` or `BadCrc`) and SHALL NOT deliver a payload.
10. FOR ALL valid frames and any truncation, THE decoder SHALL return `BadLength` or `BadCrc`.
11. FOR ALL random byte arrays, THE decoder SHALL NOT throw. It SHALL return either a frame or a typed error.

### Channel simulation

12. FOR ALL valid frames passed through the simulated noisy channel with bit-error rate 0, the output SHALL equal the input.
13. FOR ALL valid frames and any bit-error rate above 0, every delivered frame SHALL be byte-identical to a transmitted frame (no corrupted frame is accepted).

### Harness rules

14. Each property SHALL run at least 1000 cases by default (`numRuns`). Properties that drive real timers (Stop-and-Wait ARQ over a lossy loopback) MAY run fewer cases, but not fewer than 40.
15. Failing seeds SHALL be printed and reproducible through `fc.assert(..., { seed, path })`.
16. Arbitraries for frames and schemas SHALL live in one shared test-utils module and SHALL NOT be duplicated per package.
