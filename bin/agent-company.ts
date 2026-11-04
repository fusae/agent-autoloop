#!/usr/bin/env node
import { companyCLI } from "../cli/company.ts";
try {
  await companyCLI(process.argv.slice(2));
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
