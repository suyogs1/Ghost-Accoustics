import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BASELINE_BITRATE_BPS, MAX_AIRTIME_SECONDS } from '@ghost-acoustics/core/constants';
import { AirtimeCalculator } from './airtime';
import { compileSchemas, loadSchemaDir, loadSchemaFile } from './compiler';
import type { CompiledMessage, LoadedSchema } from './compiler';
import { emitOpcodes, emitSerializers, emitTypes } from './emit';
import { SchemaError } from './schema';

const USAGE = `ghostc - GhostAcoustics schema compiler

Usage:
  ghostc compile [--schemas <dir>] [--out <dir>] [--bitrate <bps>]
      Compile every *.schema.json in <dir> (default: schemas) into
      <out>/types.ts, <out>/serializers.ts and <out>/opcodes.ts (default: generated).
  ghostc check <file.schema.json...> [--bitrate <bps>]
      Validate schemas and fail if any frame exceeds the airtime budget (${MAX_AIRTIME_SECONDS.toFixed(1)} s).

Baseline bitrate: ${BASELINE_BITRATE_BPS} bps.`;

interface ParsedArgs {
  readonly command: 'compile' | 'check' | 'help';
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-h' || arg === '--help') return { command: 'help', positional, flags };
    if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`flag ${arg} needs a value`);
      flags.set(arg.slice(2), value);
      i++;
    } else {
      positional.push(arg);
    }
  }
  const first = positional[0];
  if (first === 'compile' || first === 'check') {
    return { command: first, positional: positional.slice(1), flags };
  }
  if (first === 'help') return { command: 'help', positional, flags };
  return { command: 'compile', positional, flags };
}

function makeCalculator(flags: ReadonlyMap<string, string>): AirtimeCalculator {
  const raw = flags.get('bitrate');
  if (raw === undefined) return new AirtimeCalculator();
  const bps = Number(raw);
  if (!(bps > 0)) throw new Error(`--bitrate must be a positive number (got "${raw}")`);
  return new AirtimeCalculator(bps);
}

function describe(m: CompiledMessage): string {
  const { schema, report } = m;
  const op = `0x${schema.opcode.toString(16).toUpperCase().padStart(2, '0')}`;
  return (
    `${schema.name.padEnd(20)} ${op}  payload ${m.layout.variable ? "<=" : "  "}${String(report.payloadBytes).padStart(2)} B` +
    ` (${String(report.payloadBits).padStart(3)} bits)  frame ${String(report.frameBytes).padStart(2)} B` +
    `  airtime ${report.airtimeSeconds.toFixed(3)} s  ${report.ok ? 'OK' : 'OVER BUDGET'}`
  );
}

function runCompile(args: ParsedArgs): number {
  const schemasDir = resolve(args.flags.get('schemas') ?? 'schemas');
  const outDir = resolve(args.flags.get('out') ?? 'generated');
  if (!existsSync(schemasDir)) {
    console.error(`schemas directory not found: ${schemasDir}`);
    return 1;
  }

  const loaded = loadSchemaDir(schemasDir);
  if (loaded.length === 0) {
    console.error(`no *.schema.json files in ${schemasDir}`);
    return 1;
  }

  const calculator = makeCalculator(args.flags);
  const { messages, errors } = compileSchemas(loaded, calculator);
  for (const m of messages) console.log(describe(m));

  if (errors.length > 0) {
    console.error(`\nCompilation failed (${errors.length} error${errors.length === 1 ? '' : 's'}):`);
    for (const e of errors) console.error(`  - ${e}`);
    return 1;
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'types.ts'), emitTypes(messages));
  writeFileSync(join(outDir, 'serializers.ts'), emitSerializers(messages));
  writeFileSync(join(outDir, 'opcodes.ts'), emitOpcodes(messages));
  console.log(`\nWrote types.ts, serializers.ts, opcodes.ts to ${outDir}`);
  return 0;
}

function runCheck(args: ParsedArgs): number {
  if (args.positional.length === 0) {
    console.error('check: no schema files given');
    return 1;
  }
  const calculator = makeCalculator(args.flags);
  const loaded: LoadedSchema[] = [];
  let failed = false;
  for (const file of args.positional) {
    try {
      loaded.push(loadSchemaFile(file));
    } catch (err) {
      failed = true;
      console.error(err instanceof SchemaError ? err.message : `${file}: ${String(err)}`);
    }
  }
  const { messages, errors } = compileSchemas(loaded, calculator);
  for (const m of messages) console.log(describe(m));
  for (const e of errors) {
    failed = true;
    console.error(`  - ${e}`);
  }
  return failed ? 1 : 0;
}

/** Returns the process exit code. */
export function runCli(argv: readonly string[]): number {
  try {
    const args = parseArgs(argv);
    switch (args.command) {
      case 'help':
        console.log(USAGE);
        return 0;
      case 'check':
        return runCheck(args);
      case 'compile':
        return runCompile(args);
    }
  } catch (err) {
    console.error(err instanceof SchemaError ? err.message : `ghostc: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
