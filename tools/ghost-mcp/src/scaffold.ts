import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AirtimeCalculator,
  SchemaError,
  computeLayout,
  loadSchemaDir,
  parseMessageSchema,
  pascalCase,
} from '@ghost-acoustics/schema-compiler';
import {
  FRAME_OVERHEAD_BYTES,
  MAX_AIRTIME_SECONDS,
  SINGLE_FRAME_MAX_BYTES,
} from '@ghost-acoustics/core/constants';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const SCHEMAS_DIR = join(REPO_ROOT, 'packages', 'schema-compiler', 'schemas');

/** Types the scaffolder accepts. `uint` + `bits` is shorthand for an exactly-sized unsigned integer. */
export const SCAFFOLD_TYPES = ['uint8', 'uint16', 'uint32', 'uint', 'boolean', 'quantizedInt', 'bytes'] as const;

export interface ScaffoldField {
  readonly name: string;
  readonly type: (typeof SCAFFOLD_TYPES)[number];
  /** quantizedInt: wire width. uint: exact width. uint8/16/32: narrows the field if smaller than the type. */
  readonly bits?: number | undefined;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  /** bytes: maximum length in bytes. */
  readonly maxLength?: number | undefined;
  readonly description?: string | undefined;
}

export interface ScaffoldInput {
  readonly schemaName: string;
  readonly opcode: number;
  readonly fields: readonly ScaffoldField[];
  readonly description?: string | undefined;
  /** Validate and report, but do not write the file. */
  readonly dryRun?: boolean | undefined;
  /** Replace an existing schema file with the same name. */
  readonly overwrite?: boolean | undefined;
}

export interface ScaffoldResult {
  readonly written: boolean;
  readonly file: string;
  readonly withinBudget: boolean;
  readonly schema: Record<string, unknown>;
  readonly metrics: {
    readonly headerBytes: number;
    readonly payloadBits: number;
    /** Payload size at the maximum (a bytes field counts at its maxLength). */
    readonly payloadBytes: number;
    readonly variableLength: boolean;
    readonly crcBytes: number;
    readonly frameBytes: number;
    readonly airtimeSeconds: number;
    /** Data frame plus the 12-byte ACK that comes back. */
    readonly roundTripSeconds: number;
    readonly maxSingleFramePayloadBytes: number;
    readonly headroomBytes: number;
  };
  readonly warnings: readonly string[];
  readonly suggestions: readonly string[];
  readonly nextSteps: readonly string[];
}

const hex = (n: number): string => `0x${n.toString(16).toUpperCase().padStart(2, '0')}`;

function normalizeField(field: ScaffoldField, warnings: string[]): Record<string, unknown> {
  const base: Record<string, unknown> = { name: field.name };
  const note = field.description ? { description: field.description } : {};

  switch (field.type) {
    case 'boolean':
      return { ...base, type: 'boolean', ...note };
    case 'uint8':
    case 'uint16':
    case 'uint32': {
      const width = field.type === 'uint8' ? 8 : field.type === 'uint16' ? 16 : 32;
      if (field.bits !== undefined && field.bits < width) {
        warnings.push(`${field.name}: narrowed ${field.type} to ${field.bits} bits (saves ${width - field.bits} bits on the wire)`);
        return { ...base, type: 'quantizedInt', min: 0, max: 2 ** field.bits - 1, bits: field.bits, ...note };
      }
      if (field.bits !== undefined && field.bits > width) warnings.push(`${field.name}: bits ${field.bits} ignored for ${field.type}`);
      return { ...base, type: field.type, ...note };
    }
    case 'uint': {
      if (field.bits === undefined) throw new Error(`field "${field.name}": type "uint" needs "bits" (1..32)`);
      // quantizedInt over [0, 2^bits - 1] has step 1, so values round-trip exactly.
      return { ...base, type: 'quantizedInt', min: 0, max: 2 ** field.bits - 1, bits: field.bits, ...note };
    }
    case 'quantizedInt': {
      if (field.min === undefined || field.max === undefined || field.bits === undefined) {
        throw new Error(`field "${field.name}": quantizedInt needs "min", "max" and "bits"`);
      }
      return { ...base, type: 'quantizedInt', min: field.min, max: field.max, bits: field.bits, ...note };
    }
    case 'bytes': {
      if (field.maxLength === undefined) throw new Error(`field "${field.name}": bytes needs "maxLength"`);
      return { ...base, type: 'bytes', maxLength: field.maxLength, ...note };
    }
  }
}

function budgetSuggestions(overBytes: number, schema: ReturnType<typeof parseMessageSchema>): string[] {
  const out: string[] = [];
  out.push(`Remove at least ${overBytes} byte${overBytes === 1 ? '' : 's'} (${overBytes * 8} bits) of payload to fit one frame.`);
  for (const field of schema.fields) {
    if (field.type === 'uint32') out.push(`${field.name}: uint32 uses 32 bits; use "uint" with the fewest bits that cover its range.`);
    else if (field.type === 'uint16') out.push(`${field.name}: uint16 uses 16 bits; a smaller "uint" or a quantizedInt may be enough.`);
    else if (field.type === 'bytes') {
      const smaller = Math.max(1, field.maxLength - overBytes);
      out.push(`${field.name}: lower maxLength from ${field.maxLength} to ${smaller} to save ${field.maxLength - smaller} byte(s).`);
    } else if (field.type === 'quantizedInt' && field.bits > 8) {
      out.push(`${field.name}: ${field.bits} bits of precision; each bit removed saves 1/8 byte.`);
    }
  }
  out.push('Split the message into two frames if every field is really needed.');
  return out;
}

/**
 * Builds a schema file from a field list, checks it against the airtime budget with the
 * real AirtimeCalculator, and (unless dry-run or over budget) writes it to the schemas folder.
 * Throws an Error with every problem found when the input is not a valid schema.
 */
export function generateSchemaScaffold(input: ScaffoldInput): ScaffoldResult {
  const warnings: string[] = [];
  const raw: Record<string, unknown> = {
    name: input.schemaName,
    opcode: hex(input.opcode),
    ...(input.description ? { description: input.description } : {}),
    fields: input.fields.map((f) => normalizeField(f, warnings)),
  };

  let schema;
  try {
    schema = parseMessageSchema(raw, `${input.schemaName}.schema.json`);
  } catch (err) {
    if (err instanceof SchemaError) throw new Error(`Invalid schema:\n  - ${err.problems.join('\n  - ')}`);
    throw err;
  }

  const file = join(SCHEMAS_DIR, `${schema.name}.schema.json`);
  const exists = existsSync(file);
  if (exists && !input.overwrite) {
    throw new Error(`${schema.name}.schema.json already exists; pass overwrite: true to replace it`);
  }

  // The new message must not collide with an existing one (other than the file it replaces).
  if (existsSync(SCHEMAS_DIR)) {
    for (const other of loadSchemaDir(SCHEMAS_DIR)) {
      if (other.schema.name === schema.name) continue;
      if (other.schema.opcode === schema.opcode) {
        throw new Error(`opcode ${hex(schema.opcode)} is already used by ${other.schema.name}`);
      }
    }
  }

  const layout = computeLayout(schema);
  const calculator = new AirtimeCalculator();
  const report = calculator.analyze(layout.payloadBits);
  const maxSingleFramePayloadBytes = SINGLE_FRAME_MAX_BYTES - FRAME_OVERHEAD_BYTES;
  const headroomBytes = maxSingleFramePayloadBytes - report.payloadBytes;
  const ackSeconds = calculator.airtimeSeconds(FRAME_OVERHEAD_BYTES);
  const roundTripSeconds = report.airtimeSeconds + ackSeconds;

  const suggestions: string[] = [];
  if (!report.ok) {
    warnings.push(...report.violations);
    suggestions.push(...budgetSuggestions(Math.max(1, -headroomBytes), schema));
  } else if (report.airtimeSeconds >= MAX_AIRTIME_SECONDS * 0.75) {
    warnings.push(
      `airtime ${report.airtimeSeconds.toFixed(2)} s is within budget but uses ${Math.round((report.airtimeSeconds / MAX_AIRTIME_SECONDS) * 100)}% of ${MAX_AIRTIME_SECONDS.toFixed(1)} s; a unicast round trip with ACK is ${roundTripSeconds.toFixed(2)} s`,
    );
    suggestions.push('Every byte costs 0.125 s. Consider narrowing fields so cues stay snappy.');
  }

  const withinBudget = report.ok;
  let written = false;
  if (withinBudget && !input.dryRun) {
    mkdirSync(SCHEMAS_DIR, { recursive: true });
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, { flag: input.overwrite ? 'w' : 'wx' });
    written = true;
  }

  const nextSteps = written
    ? [
        'pnpm compile  (generates types.ts, serializers.ts, opcodes.ts)',
        'pnpm test:pbt  (round-trip and budget properties)',
        `import { pack${pascalCase(schema.name)}, unpack${pascalCase(schema.name)} } from '@ghost-acoustics/schema-compiler/generated/serializers'`,
      ]
    : withinBudget
      ? ['Dry run only: call again without dryRun to write the file.']
      : ['Nothing was written. Fix the budget problems above and call again.'];

  return {
    written,
    file,
    withinBudget,
    schema: raw,
    metrics: {
      headerBytes: report.headerBytes,
      payloadBits: report.payloadBits,
      payloadBytes: report.payloadBytes,
      variableLength: layout.variable !== null,
      crcBytes: report.crcBytes,
      frameBytes: report.frameBytes,
      airtimeSeconds: report.airtimeSeconds,
      roundTripSeconds,
      maxSingleFramePayloadBytes,
      headroomBytes,
    },
    warnings,
    suggestions,
    nextSteps,
  };
}
