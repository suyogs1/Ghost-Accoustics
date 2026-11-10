# Spec 04: Live Schema Generation

Lets Kiro (or any MCP client) design a new message while the project is running: scaffold the schema file, prove it fits the airtime budget, generate its serializers and tests, and surface it in the apps. Requirements use EARS syntax. Related: `spec_03_schema_compiler.md` (compiler rules), `01_airtime_budget_rules.md` (limits).

## Components

| Part | Where | Status |
|------|-------|--------|
| `generate_schema_scaffold` MCP tool | `tools/ghost-mcp/src/scaffold.ts`, registered in `index.ts` | Implemented |
| Compile, budget and PBT hook | `.kiro/hooks/on-schema-change-pbt.sh`, registered by `on-schema-created-pbt.json` and `on-schema-saved-pbt.json` | Implemented |
| Pre-commit airtime guard | `.kiro/hooks/pre-commit-airtime-guard.sh` | Implemented (Spec 03) |
| Automatic UI component binding | generated field metadata and form renderer | **Planned, not built** |

## Flow

```
Kiro / MCP client
  -> generate_schema_scaffold { schemaName, opcode, fields }
       validates, checks budget, writes packages/schema-compiler/schemas/<NAME>.schema.json
  -> hook on-schema-change-pbt.sh (PostFileCreate / PostFileSave)
       1. ghostc compile      -> generated/types.ts, serializers.ts, opcodes.ts
       2. ghostc check        -> every frame <= 32 bytes and <= 4.0 s
       3. run_pbt_suite       -> round-trip, budget and ARQ properties
  -> app code imports pack<Name> / unpack<Name> and the Opcode registry
```

## Requirements

### Live schema registration

1. WHEN `generate_schema_scaffold` is called with a valid `schemaName`, `opcode` and `fields`, THE tool SHALL write `packages/schema-compiler/schemas/<schemaName>.schema.json` and report `written: true`.
2. THE tool SHALL build the file path only from the validated schema name (`/^[A-Z][A-Z0-9_]*$/`) and SHALL NOT accept a path from the caller.
3. IF the input is not a valid schema (bad names, unknown types, missing `min`/`max`/`bits`/`maxLength`, misplaced `bytes` field), THEN THE tool SHALL return an error that lists every problem and SHALL NOT write a file.
4. IF the opcode is already used by another schema, THEN THE tool SHALL return an error naming the existing message and SHALL NOT write a file.
5. IF a schema file of the same name exists and `overwrite` is not true, THEN THE tool SHALL refuse to replace it.
6. THE tool SHALL accept the field types `uint8`, `uint16`, `uint32`, `uint` (with `bits`), `boolean`, `quantizedInt` and `bytes`, and SHALL store a `uint` of N bits as an exactly-sized quantized integer so values round-trip losslessly.
7. WHEN a `uint8`, `uint16` or `uint32` field is given a `bits` value smaller than its width, THE tool SHALL narrow the field to that width and SHALL report the saving as a warning.
8. WHERE `dryRun` is true, THE tool SHALL perform every check and return the metrics without writing the file.

### Runtime airtime budget verification

9. THE tool SHALL compute payload bits and bytes, frame bytes (`8 + payload + 4`) and airtime with the same `AirtimeCalculator` that `ghostc` uses.
10. THE tool SHALL report `payloadBytes`, `frameBytes`, `airtimeSeconds`, the airtime of a unicast round trip (data frame plus the 12-byte ACK), and the remaining payload headroom against the 20-byte single-frame limit.
11. IF the frame exceeds 32 bytes or 4.0 s, THEN THE tool SHALL report `withinBudget: false`, SHALL NOT write the file, and SHALL return the violations plus concrete suggestions (fields to narrow, `bytes` lengths to lower, or splitting the message).
12. IF the airtime is within budget but at least 75% of it, THEN THE tool SHALL return a warning that includes the round-trip time.
13. THE tool SHALL size a message containing a `bytes` field at that field's `maxLength` and SHALL flag the result as variable-length.

### Automation hook

14. WHEN a `*.schema.json` file is created or saved, THE hook SHALL run `ghostc compile`, then `ghostc check` over the whole schemas folder, then the property-based test suite.
15. IF any step fails, THEN THE hook SHALL stop, print which step failed and exit non-zero.
16. THE hook SHALL treat any frame larger than 32 bytes as a failure.
17. THE property-test step SHALL use the same runner as the `run_pbt_suite` MCP tool.
18. THE hook SHALL NOT write any `*.schema.json` file, so it cannot trigger itself.

### Automatic UI component binding (planned)

19. WHEN `ghostc compile` runs, THE compiler SHALL also emit field metadata for every message (name, type, range or bit width, description, enum labels if declared).
20. WHEN field metadata exists for a message, THE app SHALL render a send form for it with an input matched to each field type: a number input bounded by `min`/`max`, a toggle for `boolean`, and a text input counting bytes for `bytes`.
21. WHEN the user edits the form, THE app SHALL show the message's payload bytes, frame bytes and airtime from the generated registry before sending.
22. WHEN a message is received, THE app SHALL look up its opcode in the generated registry and display the decoded fields without hand-written code for that message.
23. IF an opcode is not in the registry, THEN THE app SHALL show the raw frame instead of dropping it.
