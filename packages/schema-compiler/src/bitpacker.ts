import { fieldBitWidth, maxWireValue } from './schema';
import type { BytesField, FieldSchema, MessageSchema, QuantizedIntField } from './schema';

/**
 * Wire format of a payload: fields in declared order, MSB-first, no padding
 * between fields, zero-padded to a whole byte at the end. A trailing `bytes`
 * field is byte-aligned; its length is implied by the frame's payload length.
 */
export interface FieldSlot {
  readonly field: FieldSchema;
  readonly bitOffset: number;
  readonly bitWidth: number;
}

export interface PayloadLayout {
  readonly slots: readonly FieldSlot[];
  /** Bits at the maximum size (a `bytes` field counts at its maxLength). */
  readonly payloadBits: number;
  /** Payload bytes at the maximum size; this is what budgets are checked against. */
  readonly payloadBytes: number;
  /** Bytes taken by everything before the variable-length field (all of it when there is none). */
  readonly fixedBytes: number;
  /** The trailing variable-length field, if any. */
  readonly variable: BytesField | null;
}

export function computeLayout(schema: MessageSchema): PayloadLayout {
  let bitOffset = 0;
  let variable: BytesField | null = null;
  let fixedBits = 0;
  const slots = schema.fields.map((field): FieldSlot => {
    const bitWidth = fieldBitWidth(field);
    const slot = { field, bitOffset, bitWidth };
    if (field.type === 'bytes') variable = field;
    else fixedBits = bitOffset + bitWidth;
    bitOffset += bitWidth;
    return slot;
  });
  return {
    slots,
    payloadBits: bitOffset,
    payloadBytes: Math.ceil(bitOffset / 8),
    fixedBytes: Math.ceil(fixedBits / 8),
    variable,
  };
}

/** Writes the low `width` bits (<= 32) of `value`, MSB first. The target region must be zeroed. */
export function writeBits(buf: Uint8Array, bitPos: number, value: number, width: number): void {
  let remaining = width;
  let pos = bitPos;
  while (remaining > 0) {
    const bitInByte = pos & 7;
    const space = 8 - bitInByte;
    const take = remaining < space ? remaining : space;
    const chunk = Math.floor(value / 2 ** (remaining - take)) & ((1 << take) - 1);
    buf[pos >>> 3]! |= chunk << (space - take);
    pos += take;
    remaining -= take;
  }
}

/** Reads `width` bits (<= 32) as an unsigned integer, MSB first. */
export function readBits(buf: Uint8Array, bitPos: number, width: number): number {
  let remaining = width;
  let pos = bitPos;
  let result = 0;
  while (remaining > 0) {
    const bitInByte = pos & 7;
    const space = 8 - bitInByte;
    const take = remaining < space ? remaining : space;
    const chunk = (buf[pos >>> 3]! >>> (space - take)) & ((1 << take) - 1);
    result = result * (1 << take) + chunk;
    pos += take;
    remaining -= take;
  }
  return result;
}

export function quantize(field: QuantizedIntField, value: number, label: string): number {
  if (!(value >= field.min && value <= field.max)) {
    throw new RangeError(`${label}: ${value} outside [${field.min}, ${field.max}]`);
  }
  const levels = maxWireValue(field.bits);
  return Math.round(((value - field.min) * levels) / (field.max - field.min));
}

export function dequantize(field: QuantizedIntField, wire: number): number {
  const levels = maxWireValue(field.bits);
  return field.min + (wire * (field.max - field.min)) / levels;
}

export type FieldValue = number | boolean | Uint8Array;
export type MessageValue = Readonly<Record<string, FieldValue>>;

function encodeScalar(field: Exclude<FieldSchema, BytesField>, value: FieldValue | undefined, label: string): number {
  switch (field.type) {
    case 'boolean':
      if (typeof value !== 'boolean') throw new TypeError(`${label}: expected boolean`);
      return value ? 1 : 0;
    case 'quantizedInt':
      if (typeof value !== 'number') throw new TypeError(`${label}: expected number`);
      return quantize(field, value, label);
    default: {
      if (typeof value !== 'number') throw new TypeError(`${label}: expected number`);
      const max = maxWireValue(fieldBitWidth(field));
      if (!Number.isInteger(value) || value < 0 || value > max) {
        throw new RangeError(`${label}: ${value} is not an integer in [0, ${max}]`);
      }
      return value;
    }
  }
}

/** Packs `value` into `out` at byte `offset`. Returns the number of bytes written. */
export function packInto(schema: MessageSchema, value: MessageValue, out: Uint8Array, offset = 0): number {
  const layout = computeLayout(schema);
  let bytes: Uint8Array | null = null;
  if (layout.variable) {
    const raw = value[layout.variable.name];
    const label = `${schema.name}.${layout.variable.name}`;
    if (!(raw instanceof Uint8Array)) throw new TypeError(`${label}: expected Uint8Array`);
    if (raw.length > layout.variable.maxLength) {
      throw new RangeError(`${label}: ${raw.length} bytes exceeds the maximum of ${layout.variable.maxLength}`);
    }
    bytes = raw;
  }
  const size = layout.fixedBytes + (bytes ? bytes.length : 0);
  if (out.length - offset < size) {
    throw new RangeError(`${schema.name}: need ${size} bytes at offset ${offset}`);
  }
  out.fill(0, offset, offset + size);
  const base = offset * 8;
  for (const slot of layout.slots) {
    if (slot.field.type === 'bytes') continue;
    const label = `${schema.name}.${slot.field.name}`;
    writeBits(out, base + slot.bitOffset, encodeScalar(slot.field, value[slot.field.name], label), slot.bitWidth);
  }
  if (bytes) out.set(bytes, offset + layout.fixedBytes);
  return size;
}

/** Convenience wrapper that allocates exactly-sized output. */
export function packMessage(schema: MessageSchema, value: MessageValue): Uint8Array {
  const out = new Uint8Array(computeLayout(schema).payloadBytes);
  const written = packInto(schema, value, out);
  return out.subarray(0, written);
}

/**
 * Unpacks into an existing object. For a `bytes` field the target receives a view into
 * `buf` (no copy), so copy it if `buf` will be reused. `end` bounds the payload; it matters
 * for variable-length messages because the length is implied by it.
 */
export function unpackInto<T extends Record<string, FieldValue>>(
  schema: MessageSchema,
  buf: Uint8Array,
  target: T,
  offset = 0,
  end: number = buf.length,
): T {
  const layout = computeLayout(schema);
  const size = end - offset;
  const variable = layout.variable;
  if (size < layout.fixedBytes || (variable ? size > layout.payloadBytes : size < layout.payloadBytes)) {
    throw new RangeError(`${schema.name}: payload of ${size} bytes does not fit (expected ${layout.fixedBytes}..${layout.payloadBytes})`);
  }
  const base = offset * 8;
  const record: Record<string, FieldValue> = target;
  for (const slot of layout.slots) {
    const { field } = slot;
    if (field.type === 'bytes') {
      record[field.name] = buf.subarray(offset + layout.fixedBytes, end);
      continue;
    }
    const wire = readBits(buf, base + slot.bitOffset, slot.bitWidth);
    record[field.name] =
      field.type === 'boolean' ? wire === 1 : field.type === 'quantizedInt' ? dequantize(field, wire) : wire;
  }
  return target;
}

export function unpackMessage(schema: MessageSchema, buf: Uint8Array, offset = 0, end: number = buf.length): Record<string, FieldValue> {
  return unpackInto(schema, buf, {}, offset, end);
}
