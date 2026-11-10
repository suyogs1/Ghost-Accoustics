#!/usr/bin/env tsx
/**
 * ghost-mcp: local MCP server (stdio) for GhostAcoustics.
 * stdout carries the protocol; all logging goes to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { checkAirtimeBudget } from './airtime';
import { inspectPacketCapture } from './inspect';
import { simulateChannelNoise } from './noise';
import { runPbtSuite } from './pbt';

type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(result: object): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result as Record<string, unknown>,
  };
}

function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: message }], isError: true };
}

const server = new McpServer({ name: 'ghost-mcp', version: '0.0.0' });

server.registerTool(
  'check_airtime_budget',
  {
    title: 'Check airtime budget',
    description:
      'Compute the exact frame size (8 B header + payload + 4 B CRC-32) and estimated airtime for a payload, ' +
      'and report whether it exceeds the single-frame budget (32 bytes or 4.0 s).',
    inputSchema: {
      payloadBytes: z.number().int().min(0).max(1_000_000).describe('Payload size in bytes'),
      baudRate: z.number().positive().optional().describe('Modulation rate in bits per second (default 64)'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ payloadBytes, baudRate }) => {
    try {
      return ok(checkAirtimeBudget(payloadBytes, baudRate));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'simulate_channel_noise',
  {
    title: 'Simulate channel noise',
    description:
      'Flip each bit of a wire frame with the given bit error rate, then run the real decoder ' +
      '(sync, length, CRC-32). Returns whether the frame would be delivered and how many bits were corrupted.',
    inputSchema: {
      frameHex: z.string().min(1).max(512).describe('Wire frame as hex, up to 64 bytes'),
      berPercentage: z.number().min(0).max(100).describe('Per-bit error probability in percent (0-100)'),
      seed: z.number().int().optional().describe('Optional seed for a reproducible run'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ frameHex, berPercentage, seed }) => {
    try {
      return ok(simulateChannelNoise(frameHex, berPercentage, seed));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'inspect_packet_capture',
  {
    title: 'Inspect packet capture',
    description:
      'Parse a raw frame capture: 8-byte header, opcode, payload and CRC-32, with validity flags for sync, length and CRC.',
    inputSchema: {
      rawHex: z.string().min(1).max(8192).describe('Raw captured bytes as hex'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ rawHex }) => {
    try {
      return ok(inspectPacketCapture(rawHex));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'run_pbt_suite',
  {
    title: 'Run property-based tests',
    description:
      'Run the workspace fast-check property tests (packages/core and packages/schema-compiler) and return ' +
      'pass/fail per test, per property iteration counts and seeds. The full run takes about 30 seconds.',
    inputSchema: {
      suite: z.enum(['all', 'core', 'schema-compiler']).optional().describe('Which package to run (default all)'),
    },
  },
  async ({ suite }) => {
    try {
      return ok(await runPbtSuite(suite));
    } catch (err) {
      return fail(err);
    }
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  console.error('ghost-mcp ready on stdio');
}

main().catch((err: unknown) => {
  console.error('ghost-mcp failed to start:', err);
  process.exit(1);
});
