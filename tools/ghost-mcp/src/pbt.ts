import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type PbtSuiteName = 'all' | 'core' | 'schema-compiler';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PACKAGES = ['core', 'schema-compiler'] as const;
const TIMEOUT_MS = 5 * 60_000;
const TAIL_CHARS = 4000;

export interface PbtTestResult {
  readonly name: string;
  readonly passed: boolean;
}

export interface PbtPropertyResult {
  readonly property: string;
  readonly iterations: number;
  readonly passed: boolean;
  /** Replay with GHOST_PBT_SEED=<seed>. */
  readonly seed: number;
}

export interface PbtPackageResult {
  readonly package: string;
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly tests: readonly PbtTestResult[];
  readonly properties: readonly PbtPropertyResult[];
  readonly iterations: number;
  /** Last part of the runner output, only included on failure. */
  readonly outputTail?: string;
}

export interface PbtRunResult {
  readonly passed: boolean;
  readonly totalIterations: number;
  readonly packages: readonly PbtPackageResult[];
}

function parseTap(output: string): PbtTestResult[] {
  const tests: PbtTestResult[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^(not )?ok \d+ - (.+?)(?:\s+#\s+(?:SKIP|TODO).*)?$/.exec(line);
    if (m) tests.push({ name: m[2]!, passed: m[1] === undefined });
  }
  return tests;
}

function parseReport(path: string): PbtPropertyResult[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const r = JSON.parse(line) as { property: string; iterations: number; passed: boolean; seed: number };
      return { property: r.property, iterations: r.iterations, passed: r.passed, seed: r.seed };
    });
}

async function runPackage(name: string): Promise<PbtPackageResult> {
  const cwd = join(REPO_ROOT, 'packages', name);
  const testDir = join(cwd, 'test');
  const files = existsSync(testDir)
    ? readdirSync(testDir).filter((f) => f.endsWith('.test.ts')).sort().map((f) => join('test', f))
    : [];
  if (files.length === 0) {
    return { package: name, passed: false, exitCode: null, durationMs: 0, tests: [], properties: [], iterations: 0, outputTail: 'no test files found' };
  }

  const workDir = mkdtempSync(join(tmpdir(), 'ghost-pbt-'));
  const reportPath = join(workDir, 'report.jsonl');
  const started = Date.now();

  try {
    const { exitCode, output } = await new Promise<{ exitCode: number | null; output: string }>((resolvePromise, reject) => {
      // Run node directly (no shell): same as `tsx --test`, with TAP output for parsing.
      const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', ...files], {
        cwd,
        env: { ...process.env, GHOST_PBT_REPORT: reportPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let buffer = '';
      child.stdout.on('data', (d: Buffer) => (buffer += d.toString()));
      child.stderr.on('data', (d: Buffer) => (buffer += d.toString()));
      const timer = setTimeout(() => {
        child.kill();
        buffer += `\nTimed out after ${TIMEOUT_MS} ms`;
      }, TIMEOUT_MS);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolvePromise({ exitCode: code, output: buffer });
      });
    });

    const tests = parseTap(output);
    const properties = parseReport(reportPath);
    const passed = exitCode === 0 && tests.length > 0 && tests.every((t) => t.passed) && properties.every((p) => p.passed);
    return {
      package: name,
      passed,
      exitCode,
      durationMs: Date.now() - started,
      tests,
      properties,
      iterations: properties.reduce((n, p) => n + p.iterations, 0),
      ...(passed ? {} : { outputTail: output.slice(-TAIL_CHARS) }),
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export async function runPbtSuite(suite: PbtSuiteName = 'all'): Promise<PbtRunResult> {
  const selected = suite === 'all' ? PACKAGES : PACKAGES.filter((p) => p === suite);
  const packages: PbtPackageResult[] = [];
  for (const name of selected) packages.push(await runPackage(name));
  return {
    passed: packages.every((p) => p.passed),
    totalIterations: packages.reduce((n, p) => n + p.iterations, 0),
    packages,
  };
}
