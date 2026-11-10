import { appendFileSync } from 'node:fs';
import * as fc from 'fast-check';

/** Default iterations per property (spec_02 requirement 14). */
export const DEFAULT_NUM_RUNS = 1000;

export interface PbtRecord {
  readonly suite: string;
  readonly property: string;
  /** Number of generated cases that were executed. */
  readonly iterations: number;
  readonly passed: boolean;
  readonly seed: number;
}

/**
 * Runs a fast-check property, throws a reproducible failure message (seed + path) on
 * failure, and appends one JSON line per property to $GHOST_PBT_REPORT when set so
 * the MCP `run_pbt_suite` tool can report exact iteration counts.
 * Set GHOST_PBT_SEED to replay a run.
 */
export async function runProperty<Ts extends unknown[]>(
  suite: string,
  property: string,
  prop: fc.IProperty<Ts> | fc.IAsyncProperty<Ts>,
  params: Omit<fc.Parameters<Ts>, 'numRuns'> & { readonly numRuns?: number } = {},
): Promise<void> {
  const envSeed = process.env['GHOST_PBT_SEED'];
  const details = await fc.check(prop, {
    numRuns: DEFAULT_NUM_RUNS,
    ...(envSeed ? { seed: Number(envSeed) } : {}),
    ...params,
  } as fc.Parameters<Ts>);

  const report = process.env['GHOST_PBT_REPORT'];
  if (report) {
    const record: PbtRecord = {
      suite,
      property,
      iterations: details.numRuns,
      passed: !details.failed,
      seed: details.seed,
    };
    appendFileSync(report, `${JSON.stringify(record)}\n`);
  }

  if (details.failed) throw new Error(fc.defaultReportMessage(details));
}
