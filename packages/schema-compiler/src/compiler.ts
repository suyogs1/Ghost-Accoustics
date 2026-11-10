import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AirtimeCalculator } from './airtime';
import type { AirtimeReport } from './airtime';
import { computeLayout } from './bitpacker';
import type { PayloadLayout } from './bitpacker';
import { SchemaError, parseMessageSchema } from './schema';
import type { MessageSchema } from './schema';

export const SCHEMA_SUFFIX = '.schema.json';

export interface LoadedSchema {
  readonly source: string;
  readonly schema: MessageSchema;
}

export interface CompiledMessage {
  readonly source: string;
  readonly schema: MessageSchema;
  readonly layout: PayloadLayout;
  readonly report: AirtimeReport;
}

export interface CompileResult {
  /** Sorted by opcode. */
  readonly messages: readonly CompiledMessage[];
  /** Cross-schema and budget errors. Non-empty means no output should be written. */
  readonly errors: readonly string[];
}

/** Reads and validates one `.schema.json` file. */
export function loadSchemaFile(path: string): LoadedSchema {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new SchemaError(path, [`cannot read JSON: ${err instanceof Error ? err.message : String(err)}`]);
  }
  return { source: path, schema: parseMessageSchema(raw, path) };
}

/** Loads every `*.schema.json` directly inside `dir`, in filename order. */
export function loadSchemaDir(dir: string): LoadedSchema[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(SCHEMA_SUFFIX))
    .sort()
    .map((f) => loadSchemaFile(join(dir, f)));
}

export function compileSchemas(
  loaded: readonly LoadedSchema[],
  calculator: AirtimeCalculator = new AirtimeCalculator(),
): CompileResult {
  const errors: string[] = [];
  const names = new Map<string, string>();
  const opcodes = new Map<number, string>();

  const messages = loaded.map(({ source, schema }): CompiledMessage => {
    const layout = computeLayout(schema);
    const report = calculator.analyze(layout.payloadBits);

    const nameOwner = names.get(schema.name);
    if (nameOwner) errors.push(`${source}: duplicate message name ${schema.name} (also in ${nameOwner})`);
    names.set(schema.name, source);

    const opcodeOwner = opcodes.get(schema.opcode);
    if (opcodeOwner) {
      errors.push(`${source}: opcode 0x${schema.opcode.toString(16)} already used by ${opcodeOwner}`);
    }
    opcodes.set(schema.opcode, schema.name);

    for (const violation of report.violations) errors.push(`${source}: ${schema.name}: ${violation}`);
    return { source, schema, layout, report };
  });

  messages.sort((a, b) => a.schema.opcode - b.schema.opcode);
  return { messages, errors };
}
