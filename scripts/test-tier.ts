// The tiers partition npm test; extended nightly fault injection stays opt-in.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const tier = process.argv[2];
if (tier !== "fast" && tier !== "slow") throw Error("用法：test-tier.ts fast|slow");
const slow =
  /^(?:simulation|benchmark|crash-smoke|install|uninstall|loop|worker|acp|browser-handoff|example-plugins|recipes)\.test\.ts$|(?:^|-)e2e\.test\.ts$/;
const files = readdirSync(join(import.meta.dirname, "../tests"))
  .filter((name) => name.endsWith(".test.ts") && slow.test(name) === (tier === "slow"))
  .sort()
  .map((name) => join(import.meta.dirname, "../tests", name));
const start = performance.now();
const result = spawnSync(
  process.execPath,
  ["--disable-warning=ExperimentalWarning", "--test", "--test-concurrency=4", ...files],
  { stdio: "inherit" },
);
console.log(`test:${tier}：${files.length} 个文件，${((performance.now() - start) / 1000).toFixed(2)} 秒`);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
