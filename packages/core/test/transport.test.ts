import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fc from 'fast-check';
import { AcousticSocket, LoopbackBus, LoopbackChannel } from '../src/index';
import { runProperty } from '../test-utils/pbt';

const SUITE = 'core';
const LOSS_RATE = 0.2;
const OPCODE = 0x11;

/** Deterministic PRNG (mulberry32) so a failing seed replays exactly. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fast clocks: a 1000x bitrate and short guards keep each ARQ round in single-digit ms.
const FAST = { bitrateBps: 64_000, drainMs: 3, ackTurnaroundPadMs: 3, ackMarginMs: 10, maxRetries: 40 } as const;

interface Outcome {
  readonly received: number[];
  readonly delivered: boolean[];
  readonly lost: number;
  readonly attempts: number;
}

async function runLossyTransfer(seed: number, count: number, lossRate: number): Promise<Outcome> {
  const rand = prng(seed);
  const bus = new LoopbackBus();
  // The built-in loopback loss model drops a fraction of everything an endpoint would receive (data and ACKs).
  const aChannel = new LoopbackChannel({ bus, lossRate, random: rand });
  const bChannel = new LoopbackChannel({ bus, lossRate, random: rand });
  const a = new AcousticSocket({ peerId: 'alice', mode: 'loopback', channel: aChannel, ...FAST });
  const b = new AcousticSocket({ peerId: 'bob', mode: 'loopback', channel: bChannel, ...FAST });
  const received: number[] = [];
  b.on('packet', (frame) => {
    received.push(frame.payload[0]!);
  });
  await Promise.all([a.start(), b.start()]);

  const delivered: boolean[] = [];
  let attempts = 0;
  try {
    for (let i = 0; i < count; i++) {
      const result = await a.send('bob', OPCODE, Uint8Array.of(i));
      delivered.push(result.delivered);
      attempts += result.attempts;
    }
  } finally {
    await Promise.all([a.stop(), b.stop()]);
  }
  return { received, delivered, lost: aChannel.lossDrops + bChannel.lossDrops, attempts };
}

// ---- Invariant 4: Stop-and-Wait ARQ over a lossy loopback -------------------

test('PBT: ARQ delivers every frame exactly once, in order, at 20% packet loss', async () => {
  await runProperty(
    SUITE,
    'Stop-and-Wait ARQ at 20% loss',
    fc.asyncProperty(fc.integer({ min: 0, max: 0xffffffff }), fc.integer({ min: 1, max: 12 }), async (seed, count) => {
      const outcome = await runLossyTransfer(seed, count, LOSS_RATE);
      const expected = Array.from({ length: count }, (_, i) => i);
      assert.deepEqual(outcome.delivered, expected.map(() => true), 'every send must be ACKed');
      assert.deepEqual(outcome.received, expected, 'app layer must see each frame once, in order');
    }),
    { numRuns: 40 },
  );
});

test('ARQ: the loss model is real (frames are dropped and retransmitted)', async () => {
  const outcome = await runLossyTransfer(12345, 30, LOSS_RATE);
  assert.ok(outcome.lost > 0, 'expected some dropped packets');
  assert.ok(outcome.attempts > 30, 'expected retransmissions');
  assert.deepEqual(outcome.received, Array.from({ length: 30 }, (_, i) => i));
});

test('ARQ: reports delivered=false (no duplicates) when the peer is unreachable', async () => {
  const bus = new LoopbackBus();
  const a = new AcousticSocket({ peerId: 'alice', mode: 'loopback', loopback: { bus }, ...FAST, maxRetries: 2 });
  await a.start();
  const result = await a.send('nobody', OPCODE, Uint8Array.of(1));
  await a.stop();
  assert.equal(result.delivered, false);
  assert.equal(result.attempts, 3);
});
