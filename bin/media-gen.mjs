#!/usr/bin/env node
/** Executable entry point for the media-gen CLI. */
import { main } from '../src/cli.mjs';

process.exitCode = await main(process.argv.slice(2));
