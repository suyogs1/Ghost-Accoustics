#!/usr/bin/env tsx
/**
 * Command-line entry for the same property-test runner the `run_pbt_suite` MCP tool uses,
 * so hooks and CI can call it without speaking MCP.
 *
 *   tsx src/cli.ts [all|core|schema-compiler]
 *
 * Prints a short summary and exits 0 only when every property passed.
 */
import { runPbtSuite } from './pbt';
import type { PbtSuiteName } from './pbt';

const arg = process.argv[2] ?? 'all';
if (arg !== 'all' && arg !== 'core' && arg !== 'schema-compiler') {
  console.error(`unknown suite "${arg}"; use all, core or schema-compiler`);
  process.exit(2);
}

const result = await runPbtSuite(arg as PbtSuiteName);
for (const pkg of result.packages) {
  const failedTests = pkg.tests.filter((t) => !t.passed).length;
  console.log(
    `${pkg.passed ? 'PASS' : 'FAIL'} ${pkg.package}: ${pkg.tests.length} tests, ${pkg.iterations} generated cases, ${(pkg.durationMs / 1000).toFixed(1)} s` +
      (failedTests > 0 ? `, ${failedTests} failing` : ''),
  );
  if (!pkg.passed && pkg.outputTail) console.error(pkg.outputTail);
}
console.log(`${result.passed ? 'PASS' : 'FAIL'} total: ${result.totalIterations} generated cases`);
process.exitCode = result.passed ? 0 : 1;
