#!/usr/bin/env tsx
import { runCli } from '../src/cli';

process.exitCode = runCli(process.argv.slice(2));
