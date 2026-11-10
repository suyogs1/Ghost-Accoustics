import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as fc from 'fast-check';
import { estimateAirtimeSeconds } from '@ghost-acoustics/core/airtime';
import { crc32 } from '@ghost-acoustics/core/crc32';
import { decodeFrame, encodeFrame } from '@ghost-acoustics/core/frame';
import { CRC_BYTES, MAX_AIRTIME_SECONDS, SINGLE_FRAME_MAX_BYTES } from '@ghost-acoustics/core/constants';
import { runProperty } from '@ghost-acoustics/core/test-utils/pbt';
import type { VenueCue, WhisperMsg } from '../generated/types';
import {
  VENUE_CUE_PAYLOAD_BYTES,
  WHISPER_MSG_PAYLOAD_BYTES,
  WHISPER_MSG_TEXT_MAX_BYTES,
  packVenueCue,
  packWhisperMsg,
  unpackVenueCue,
  unpackWhisperMsg,
} from '../generated/serializers';
import {
  AirtimeCalculator,
  compileSchemas,
  fieldBitWidth,
  packMessage,
  parseMessageSchema,
  quantizationStep,
  unpackMessage,
} from '../src/index';
import type { MessageSchema, MessageValue } from '../src/index';

const SUITE = 'schema-compiler';
const MAX_SINGLE_FRAME_PAYLOAD = 20; // 32 B frame - 8 B header - 4 B CRC

const venueSchema = parseMessageSchema(
  JSON.parse(readFileSync(fileURLToPath(new URL('../schemas/VENUE_CUE.schema.json', import.meta.url)), 'utf8')),
  'VENUE_CUE.schema.json',
);

// ---- arbitraries ----------------------------------------------------------

const venueCueArb: fc.Arbitrary<VenueCue> = fc.record({
  cueId: fc.integer({ min: 0, max: 0xffff }),
  stageState: fc.integer({ min: 0, max: 0xff }),
  accentColor: fc.integer({ min: 0, max: 0xff }),
});

const fieldArb = fc.oneof(
  fc.constantFrom('uint8', 'uint16', 'uint32', 'boolean').map((type) => ({ type })),
  fc
    .record({
      min: fc.integer({ min: -1000, max: 1000 }),
      span: fc.integer({ min: 1, max: 1000 }),
      bits: fc.integer({ min: 1, max: 32 }),
    })
    .map(({ min, span, bits }) => ({ type: 'quantizedInt', min, max: min + span, bits })),
);

/** Random valid schemas, 0..40 fields: some fit the budget, many do not. */
const schemaArb: fc.Arbitrary<MessageSchema> = fc
  .array(fieldArb, { maxLength: 40 })
  .map((fields) =>
    parseMessageSchema(
      { name: 'RANDOM_MSG', opcode: 0x40, fields: fields.map((f, i) => ({ name: `f${i}`, ...f })) },
      'generated',
    ),
  );

function valueArb(schema: MessageSchema): fc.Arbitrary<MessageValue> {
  const entries = schema.fields.map((field): [string, fc.Arbitrary<number | boolean | Uint8Array>] => {
    switch (field.type) {
      case 'boolean':
        return [field.name, fc.boolean()];
      case 'uint8':
        return [field.name, fc.integer({ min: 0, max: 0xff })];
      case 'uint16':
        return [field.name, fc.integer({ min: 0, max: 0xffff })];
      case 'uint32':
        return [field.name, fc.integer({ min: 0, max: 0xffffffff })];
      case 'quantizedInt':
        return [field.name, fc.double({ min: field.min, max: field.max, noNaN: true, noDefaultInfinity: true })];
      case 'bytes':
        return [field.name, fc.uint8Array({ maxLength: field.maxLength })];
    }
  });
  return fc.record(Object.fromEntries(entries)) as fc.Arbitrary<MessageValue>;
}

const schemaWithValueArb = schemaArb.chain((schema) =>
  fc.tuple(fc.constant(schema), valueArb(schema)),
);

const calculator = new AirtimeCalculator();

// ---- Invariant 1: lossless round trip -------------------------------------

test('PBT: VENUE_CUE round-trips losslessly (generated serializers)', async () => {
  const buf = new Uint8Array(VENUE_CUE_PAYLOAD_BYTES + 3); // + 3 to exercise offsets
  const out: VenueCue = { cueId: 0, stageState: 0, accentColor: 0 };
  await runProperty(
    SUITE,
    'VENUE_CUE unpack(pack(x)) === x',
    fc.property(venueCueArb, fc.integer({ min: 0, max: 3 }), (msg, offset) => {
      const written = packVenueCue(msg, buf, offset);
      assert.equal(written, VENUE_CUE_PAYLOAD_BYTES);
      const back = unpackVenueCue(buf, out, offset);
      assert.equal(back.cueId, msg.cueId);
      assert.equal(back.stageState, msg.stageState);
      assert.equal(back.accentColor, msg.accentColor);
    }),
  );
});

test('PBT: generated serializers are byte-identical to the runtime bit-packer', async () => {
  await runProperty(
    SUITE,
    'generated pack === generic packMessage',
    fc.property(venueCueArb, (msg) => {
      const generated = new Uint8Array(VENUE_CUE_PAYLOAD_BYTES);
      packVenueCue(msg, generated);
      assert.deepEqual(generated, packMessage(venueSchema, msg as unknown as MessageValue));
    }),
  );
});

test('PBT: arbitrary schemas round-trip; quantizedInt error <= half a step', async () => {
  await runProperty(
    SUITE,
    'generic unpack(pack(v)) === quantize(v)',
    fc.property(schemaWithValueArb, ([schema, value]) => {
      const bytes = packMessage(schema, value);
      const back = unpackMessage(schema, bytes);
      for (const field of schema.fields) {
        const sent = value[field.name]!;
        const got = back[field.name]!;
        if (field.type === 'quantizedInt') {
          const tolerance = quantizationStep(field) / 2 + 1e-9 * (field.max - field.min);
          assert.ok(Math.abs((got as number) - (sent as number)) <= tolerance, `${field.name}: ${sent} -> ${got}`);
        } else {
          assert.equal(got, sent, field.name);
        }
      }
    }),
  );
});

// ---- Invariant 2: bit-budget enforcement ----------------------------------

test('PBT: accepted schemas never exceed 20 B payload / 32 B frame / 4.0 s; others are rejected', async () => {
  await runProperty(
    SUITE,
    'bit budget',
    fc.property(schemaWithValueArb, ([schema, value]) => {
      const { messages, errors } = compileSchemas([{ source: 'pbt', schema }], calculator);
      const report = messages[0]!.report;
      const bits = schema.fields.reduce((n, f) => n + fieldBitWidth(f), 0);
      assert.equal(report.payloadBits, bits);
      assert.equal(report.payloadBytes, Math.ceil(bits / 8));

      const payload = packMessage(schema, value);
      assert.equal(payload.length, report.payloadBytes, 'reported size must equal serialized size');

      if (report.payloadBytes <= MAX_SINGLE_FRAME_PAYLOAD) {
        assert.deepEqual(errors, []);
        const frame = encodeFrame({ src: 1, dst: 0, seq: 0, flags: 0, opcode: schema.opcode, payload });
        assert.ok(payload.length <= MAX_SINGLE_FRAME_PAYLOAD);
        assert.ok(frame.length <= SINGLE_FRAME_MAX_BYTES);
        assert.equal(frame.length, report.frameBytes);
        assert.ok(report.airtimeSeconds <= MAX_AIRTIME_SECONDS);
      } else {
        assert.ok(errors.length > 0, 'over-budget schema must fail compilation');
        if (payload.length <= 52) {
          assert.throws(() => encodeFrame({ src: 1, dst: 0, seq: 0, flags: 0, opcode: schema.opcode, payload }), /BudgetExceeded/);
        } else {
          assert.throws(() => encodeFrame({ src: 1, dst: 0, seq: 0, flags: 0, opcode: schema.opcode, payload }), /PayloadTooLarge/);
        }
      }
    }),
  );
});

// ---- Invariant 3: Hamming-1 corruption ------------------------------------

const wireFrameArb = fc
  .record({
    src: fc.integer({ min: 1, max: 255 }),
    dst: fc.integer({ min: 0, max: 255 }),
    seq: fc.integer({ min: 0, max: 255 }),
    flags: fc.integer({ min: 0, max: 0x0f }),
    cue: venueCueArb,
  })
  .map(({ cue, ...header }) => {
    const payload = new Uint8Array(VENUE_CUE_PAYLOAD_BYTES);
    packVenueCue(cue, payload);
    return encodeFrame({ ...header, opcode: 0x10, payload });
  });

test('PBT: every single-bit flip of a 16-byte VENUE_CUE frame is rejected (CRC-32)', async () => {
  await runProperty(
    SUITE,
    'Hamming-1 corruption always detected',
    fc.property(wireFrameArb, (frame) => {
      assert.equal(frame.length, 16);
      assert.ok(decodeFrame(frame).ok, 'pristine frame must decode');
      const crcOffset = frame.length - CRC_BYTES;
      const stored = new DataView(frame.buffer).getUint32(crcOffset);
      assert.equal(crc32(frame, 0, crcOffset), stored);

      for (let bit = 0; bit < frame.length * 8; bit++) {
        const corrupted = frame.slice();
        corrupted[bit >> 3]! ^= 0x80 >> (bit & 7);

        // CRC-32 itself must disagree for every position (including the trailer).
        const view = new DataView(corrupted.buffer);
        assert.notEqual(crc32(corrupted, 0, crcOffset), view.getUint32(crcOffset), `CRC missed bit ${bit}`);

        // And the decoder must reject, naming the first failing check.
        const result = decodeFrame(corrupted);
        assert.equal(result.ok, false, `bit ${bit} accepted`);
        if (!result.ok) {
          const byte = bit >> 3;
          const expected = byte < 2 ? 'BadSync' : byte === 7 ? 'BadLength' : 'BadCrc';
          assert.equal(result.error, expected, `bit ${bit}`);
        }
      }
    }),
  );
});

// ---- WHISPER_MSG: variable-length trailing bytes ---------------------------

const whisperSchema = parseMessageSchema(
  JSON.parse(readFileSync(fileURLToPath(new URL('../schemas/WHISPER_MSG.schema.json', import.meta.url)), 'utf8')),
  'WHISPER_MSG.schema.json',
);

const whisperArb: fc.Arbitrary<WhisperMsg> = fc.record({
  senderId: fc.integer({ min: 1, max: 255 }),
  msgId: fc.integer({ min: 0, max: 255 }),
  text: fc.uint8Array({ minLength: 0, maxLength: WHISPER_MSG_TEXT_MAX_BYTES }),
});

test('PBT: WHISPER_MSG round-trips for every text length and matches the runtime packer', async () => {
  await runProperty(
    SUITE,
    'WHISPER_MSG unpack(pack(x)) === x',
    fc.property(whisperArb, fc.integer({ min: 0, max: 3 }), (msg, offset) => {
      const buf = new Uint8Array(offset + WHISPER_MSG_PAYLOAD_BYTES + 5);
      const written = packWhisperMsg(msg, buf, offset);
      assert.equal(written, 2 + msg.text.length, 'text length must cost exactly one byte per byte');

      const back = unpackWhisperMsg(buf, { senderId: 0, msgId: 0, text: new Uint8Array(0) }, offset, offset + written);
      assert.equal(back.senderId, msg.senderId);
      assert.equal(back.msgId, msg.msgId);
      assert.deepEqual([...back.text], [...msg.text]);

      const generic = packMessage(whisperSchema, msg as unknown as MessageValue);
      assert.deepEqual(buf.subarray(offset, offset + written), generic);
      const viaGeneric = unpackMessage(whisperSchema, generic);
      assert.deepEqual([...(viaGeneric['text'] as Uint8Array)], [...msg.text]);
    }),
  );
});

test('PBT: WHISPER_MSG stays within 16 B payload / 28 B frame / 3.5 s; longer text is refused', async () => {
  await runProperty(
    SUITE,
    'WHISPER_MSG budget',
    fc.property(whisperArb, (msg) => {
      const payload = new Uint8Array(WHISPER_MSG_PAYLOAD_BYTES);
      const written = packWhisperMsg(msg, payload);
      assert.ok(written <= 16);
      const frame = encodeFrame({ src: msg.senderId, dst: 2, seq: msg.msgId, flags: 0, opcode: 0x20, payload: payload.subarray(0, written) });
      assert.ok(frame.length <= 28);
      assert.ok(estimateAirtimeSeconds(frame.length) <= 3.5);
      assert.ok(decodeFrame(frame).ok);
    }),
  );
  const tooLong: WhisperMsg = { senderId: 1, msgId: 0, text: new Uint8Array(WHISPER_MSG_TEXT_MAX_BYTES + 1) };
  assert.throws(() => packWhisperMsg(tooLong, new Uint8Array(32)), /exceeds the maximum/);
});

test('schema: a bytes field must be last and byte-aligned', () => {
  const misaligned = {
    name: 'BAD_ALIGN',
    opcode: 0x30,
    fields: [
      { name: 'flag', type: 'boolean' },
      { name: 'text', type: 'bytes', maxLength: 4 },
    ],
  };
  assert.throws(() => parseMessageSchema(misaligned, 'x'), /byte boundary/);
  const notLast = {
    name: 'BAD_ORDER',
    opcode: 0x31,
    fields: [
      { name: 'text', type: 'bytes', maxLength: 4 },
      { name: 'tail', type: 'uint8' },
    ],
  };
  assert.throws(() => parseMessageSchema(notLast, 'x'), /must be the last field/);
});
