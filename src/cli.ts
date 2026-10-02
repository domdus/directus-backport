#!/usr/bin/env node
import { createProgram } from "./program.js";

createProgram()
	.parseAsync(process.argv)
	.catch((err) => {
		process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
		process.exit(1);
	});
