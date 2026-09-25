#!/usr/bin/env node
// Entry point for the `aigrader` command. Runs the built CLI (dist/).
import { main } from '../dist/cli.js';

const code = await main(process.argv.slice(2));
process.exit(code);
