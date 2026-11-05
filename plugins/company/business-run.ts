import { syncOwnerReplyCards } from "./owner-replies.ts";
import { failedWork } from "./recovery.ts";
import { hubClient } from "../../protocol/client.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { collectSources } from "./sources.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Operations } from "./operations.ts";
import { Businesses } from "./business.ts";
import { Company, type Context } from "./company.ts";
const [configFile, contextFile] = process.argv.slice(2);
const office = new Company(JSON.parse(readFileSync(configFile, "utf8")));
const businesses = new Businesses(dirname(configFile));
const operations = new Operations(dirname(configFile));
try {
  const context: Context = JSON.parse(readFileSync(contextFile, "utf8"));
  const batch = createHash("sha256")
    .update(
      JSON.stringify({
        events: context.events.map((e) => [e.source, e.id]).sort(),
        answers: context.answers.map((a) => a.card).sort((a, b) => a - b),
      }),
    )
    .digest("hex");
  await collectSources(dirname(configFile));
  const tasks = office.tasks(),
    now = new Date();
  const depth = Math.max(0, ...context.events.map((e) => e.hops ?? 0));
  const proactive = operations.plan(batch, businesses.list(), tasks, now, context.answers, depth, context.events);
  const legacy = depth <= 1 ? businesses.plan(batch, tasks, now, 100 - (proactive.events?.length ?? 0)) : {};
  let failures: ReturnType<typeof failedWork> = [];
  const hubFile = join(dirname(configFile), "hub/config.json");
  if (existsSync(hubFile)) {
    const cfg = JSON.parse(readFileSync(hubFile, "utf8"));
    try {
      const client = hubClient(cfg.url, cfg.owner),
        runs: any[] = [];
      try {
        await syncOwnerReplyCards(dirname(configFile), operations.executive(), client);
      } catch {
        /* Card sync is retried on the next tick without blocking task recovery. */
      }
      let before: number | undefined;
      for (let page = 0; page < 5; page++) {
        const state = await client.state(before),
          chunk = state.runs ?? [];
        if (!chunk.length) break;
        runs.push(...chunk);
        before = Math.min(...chunk.map((r: any) => r.id));
        if (chunk.length < 20) break;
      }
      failures = depth <= 1 ? failedWork(office, runs, now) : [];
    } catch {
      /* Hub outages are already retried by the worker. */
    }
  }
  const events = [...(proactive.events ?? []), ...(legacy.events ?? []), ...failures].slice(0, 100);
  const receipt = { ...proactive, ...(events.length ? { events } : {}) };
  process.stdout.write(`经营周期已检查。\n\n\`\`\`agent-autoloop\n${JSON.stringify(receipt)}\n\`\`\`\n`);
} finally {
  operations.close();
  businesses.close();
  office.close();
}
