import { FIRST_APP_OPCODE, MAX_OPCODE, MAX_PAYLOAD_BYTES } from '@ghost-acoustics/core/constants';

export type UIntType = 'uint8' | 'uint16' | 'uint32';

export interface UIntField {
  readonly name: string;
  readonly type: UIntType;
  readonly description?: string;
}

export interface BooleanField {
  readonly name: string;
  readonly type: 'boolean';
  readonly description?: string;
}

/**
 * A number in [min, max] stored in `bits` bits.
 * Wire value q = round((v - min) / (max - min) * (2^bits - 1)); decoded v = min + q * step.
 */
export interface QuantizedIntField {
  readonly name: string;
  readonly type: 'quantizedInt';
  readonly min: number;
  readonly max: number;
  readonly bits: number;
  readonly description?: string;
}

/**
 * Raw bytes (e.g. UTF-8 text) of 0..maxLength bytes. Must be the LAST field and start on a
 * byte boundary; its length is implied by the frame's payload length, so no length prefix
 * is spent on the wire. Budgets are computed at maxLength.
 */
export interface BytesField {
  readonly name: string;
  readonly type: 'bytes';
  readonly maxLength: number;
  readonly description?: string;
}

export type FieldSchema = UIntField | BooleanField | QuantizedIntField | BytesField;

export interface MessageSchema {
  /** SCREAMING_SNAKE_CASE, e.g. VENUE_CUE. */
  readonly name: string;
  /** Application opcode, 0x10..0xFF. */
  readonly opcode: number;
  readonly description?: string;
  readonly fields: readonly FieldSchema[];
}

export class SchemaError extends Error {
  readonly source: string;
  readonly problems: readonly string[];
  constructor(source: string, problems: readonly string[]) {
    super(`${source}:\n  - ${problems.join('\n  - ')}`);
    this.name = 'SchemaError';
    this.source = source;
    this.problems = problems;
  }
}

const MESSAGE_NAME = /^[A-Z][A-Z0-9_]*$/;
const FIELD_NAME = /^[a-z][A-Za-z0-9]*$/;
const MESSAGE_KEYS = new Set(['$schema', 'name', 'opcode', 'description', 'fields']);
const BASE_FIELD_KEYS = ['name', 'type', 'description'];
const QUANT_FIELD_KEYS = [...BASE_FIELD_KEYS, 'min', 'max', 'bits'];
const BYTES_FIELD_KEYS = [...BASE_FIELD_KEYS, 'maxLength'];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseOpcode(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (typeof raw === 'string' && /^0x[0-9a-f]{1,2}$/i.test(raw)) return Number.parseInt(raw, 16);
  return undefined;
}

/** Validates untrusted JSON and returns a typed schema. Throws SchemaError listing every problem. */
export function parseMessageSchema(raw: unknown, source: string): MessageSchema {
  const problems: string[] = [];
  if (!isRecord(raw)) throw new SchemaError(source, ['schema must be a JSON object']);

  for (const key of Object.keys(raw)) {
    if (!MESSAGE_KEYS.has(key)) problems.push(`unknown key "${key}"`);
  }

  const name = raw['name'];
  if (typeof name !== 'string' || !MESSAGE_NAME.test(name)) {
    problems.push('"name" must match /^[A-Z][A-Z0-9_]*$/');
  }

  const opcode = parseOpcode(raw['opcode']);
  if (opcode === undefined || opcode < FIRST_APP_OPCODE || opcode > MAX_OPCODE) {
    problems.push(
      `"opcode" must be a hex string or integer in 0x${FIRST_APP_OPCODE.toString(16)}..0x${MAX_OPCODE.toString(16)} (0x00-0x0F is reserved)`,
    );
  }

  const description = raw['description'];
  if (description !== undefined && typeof description !== 'string') problems.push('"description" must be a string');

  const rawFields = raw['fields'];
  const fields: FieldSchema[] = [];
  if (!Array.isArray(rawFields)) {
    problems.push('"fields" must be an array');
  } else {
    const seen = new Set<string>();
    rawFields.forEach((entry: unknown, i: number) => {
      const field = parseField(entry, `fields[${i}]`, problems);
      if (!field) return;
      if (seen.has(field.name)) problems.push(`fields[${i}]: duplicate field name "${field.name}"`);
      seen.add(field.name);
      fields.push(field);
    });
  }

  checkVariableField(fields, problems);

  if (problems.length > 0) throw new SchemaError(source, problems);
  return {
    name: name as string,
    opcode: opcode as number,
    ...(typeof description === 'string' ? { description } : {}),
    fields,
  };
}

function parseField(entry: unknown, where: string, problems: string[]): FieldSchema | undefined {
  if (!isRecord(entry)) {
    problems.push(`${where}: must be an object`);
    return undefined;
  }
  const before = problems.length;
  const type = entry['type'];
  const name = entry['name'];
  const allowed = type === 'quantizedInt' ? QUANT_FIELD_KEYS : type === 'bytes' ? BYTES_FIELD_KEYS : BASE_FIELD_KEYS;
  for (const key of Object.keys(entry)) {
    if (!allowed.includes(key)) problems.push(`${where}: unknown key "${key}" for type ${String(type)}`);
  }
  if (typeof name !== 'string' || !FIELD_NAME.test(name)) {
    problems.push(`${where}: "name" must be camelCase (/^[a-z][A-Za-z0-9]*$/)`);
  }
  const description = typeof entry['description'] === 'string' ? { description: entry['description'] } : {};

  switch (type) {
    case 'uint8':
    case 'uint16':
    case 'uint32':
    case 'boolean':
      if (problems.length > before) return undefined;
      return { name: name as string, type, ...description };
    case 'quantizedInt': {
      const { min, max, bits } = entry;
      if (typeof min !== 'number' || !Number.isFinite(min)) problems.push(`${where}: "min" must be a finite number`);
      if (typeof max !== 'number' || !Number.isFinite(max)) problems.push(`${where}: "max" must be a finite number`);
      if (typeof min === 'number' && typeof max === 'number' && !(min < max)) problems.push(`${where}: "min" must be < "max"`);
      if (typeof bits !== 'number' || !Number.isInteger(bits) || bits < 1 || bits > 32) {
        problems.push(`${where}: "bits" must be an integer in 1..32`);
      }
      if (problems.length > before) return undefined;
      return { name: name as string, type, min: min as number, max: max as number, bits: bits as number, ...description };
    }
    case 'bytes': {
      const { maxLength } = entry;
      if (typeof maxLength !== 'number' || !Number.isInteger(maxLength) || maxLength < 1 || maxLength > MAX_PAYLOAD_BYTES) {
        problems.push(`${where}: "maxLength" must be an integer in 1..${MAX_PAYLOAD_BYTES}`);
      }
      if (problems.length > before) return undefined;
      return { name: name as string, type, maxLength: maxLength as number, ...description };
    }
    default:
      problems.push(`${where}: "type" must be one of uint8, uint16, uint32, boolean, quantizedInt, bytes`);
      return undefined;
  }
}

/** Exact number of payload bits a field occupies. */
export function fieldBitWidth(field: FieldSchema): number {
  switch (field.type) {
    case 'uint8':
      return 8;
    case 'uint16':
      return 16;
    case 'uint32':
      return 32;
    case 'boolean':
      return 1;
    case 'quantizedInt':
      return field.bits;
    case 'bytes':
      return field.maxLength * 8;
  }
}

/** Variable-width fields take 0..max bytes depending on the frame's payload length. */
export const isVariableField = (field: FieldSchema): field is BytesField => field.type === 'bytes';

/** A bytes field must be last and byte-aligned, since its length is implied by the frame. */
function checkVariableField(fields: readonly FieldSchema[], problems: string[]): void {
  let bits = 0;
  fields.forEach((field, i) => {
    if (field.type === 'bytes') {
      if (i !== fields.length - 1) problems.push(`field "${field.name}": a bytes field must be the last field`);
      if (bits % 8 !== 0) {
        problems.push(
          `field "${field.name}": a bytes field must start on a byte boundary (${bits} bits precede it); pad with booleans or widen earlier fields`,
        );
      }
    }
    bits += fieldBitWidth(field);
  });
}

/** Largest wire value for `bits` bits (2^bits - 1), safe up to 32 bits. */
export const maxWireValue = (bits: number): number => 2 ** bits - 1;

/** Smallest representable increment of a quantizedInt field. */
export function quantizationStep(field: QuantizedIntField): number {
  return (field.max - field.min) / maxWireValue(field.bits);
}
