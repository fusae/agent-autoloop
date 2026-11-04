// Failure modes: generated company rules work in isolation but not through the real worker, the hop cap prevents final
// approval, or the CLI leaks state outside its isolated home. Fake departments are explicit fixtures, never real models.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Company } from "../plugins/company/company.ts";
import { Businesses } from "../plugins/company/business.ts";

const cli = resolve(import.meta.dirname, "../bin/agent-company.ts");
async function until<T>(get: () => T | Promise<T>, timeout = 120_000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await get();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("公司闭环没有在时限内完成");
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
test(
  "company CLI runs real hub → product → engineering → QA → human approval → archive",
  { timeout: 180_000 },
  async () => {
    const scratch = mkdtempSync(join(tmpdir(), "company-e2e-"));
    const directory = join(scratch, "office"),
      port = await freePort();
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("AGENT_AUTOLOOP_")));
    const run = (...args: string[]) => {
      const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", timeout: 10_000 });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      return result.stdout;
    };
    let up: ReturnType<typeof spawn> | undefined;
    let office: Company | undefined;
    let logs = "";
    try {
      run("init", directory, "codex", String(port));
      const fixture = join(scratch, "department.ts");
      writeFileSync(
        fixture,
        `import {readFileSync} from 'node:fs';
const context=JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT,'utf8'));
const brief=JSON.parse(context.events[0].detail);
const event={id:brief.task+':'+brief.assignment+':result',type:'company.result',subject:brief.task,
 detail:JSON.stringify({assignment:brief.assignment,verdict:'pass',summary:'模拟部门交付',artifacts:['tasks/'+brief.task+'/demo.md'],evidence:['模拟检查通过；非真实业务']})};
console.log('模拟部门完成。\\n\\n\`\`\`agent-autoloop\\n'+JSON.stringify({events:[event]})+'\\n\`\`\`');`,
      );
      const rulesFile = join(directory, "hub/rules.json");
      const rules = JSON.parse(readFileSync(rulesFile, "utf8"));
      for (const [id, agent] of Object.entries(rules.agents) as [string, Record<string, unknown>][]) {
        if (id !== "company-office" && id !== "company-business") {
          agent.use = "command";
          agent.command = [process.execPath, fixture];
        }
      }
      writeFileSync(rulesFile, JSON.stringify(rules));
      office = new Company(JSON.parse(readFileSync(join(directory, "company.json"), "utf8")));
      up = spawn(process.execPath, [cli, "up", directory], { env, stdio: ["ignore", "pipe", "pipe"] });
      up.stdout!.on("data", (chunk) => (logs += chunk));
      up.stderr!.on("data", (chunk) => (logs += chunk));
      await until(() =>
        fetch(`http://127.0.0.1:${port}/healthz`)
          .then((r) => r.ok)
          .catch(() => false),
      );
      const request = join(scratch, "request.json");
      writeFileSync(
        request,
        JSON.stringify({ title: "演示闭环", goal: "验证调度和审批", kind: "software", acceptance: ["有模拟检查证据"] }),
      );
      run("submit", directory, "DEMO-1", request);
      run("submit", directory, "DEMO-1", request);
      await until(() => office!.task("DEMO-1")?.status === "awaiting_approval");
      const cfg = JSON.parse(readFileSync(join(directory, "hub/config.json"), "utf8"));
      const card = await until(async () => {
        const state = await (
          await fetch(cfg.url + "/v1/state", { headers: { authorization: `Bearer ${cfg.owner}` } })
        ).json();
        return state.cards.find((c: { kind: string }) => c.kind === "ask");
      });
      assert.equal(office.task("DEMO-1")?.assignment, 3);
      run("answer", directory, String(card.id), "1");
      await until(() => office!.task("DEMO-1")?.status === "completed");
      const history = JSON.parse(run("history", directory, "DEMO-1"));
      assert.equal(history.length, 5);
      assert.deepEqual(
        office.task("DEMO-1")?.reports.map((r) => r.role),
        ["product", "engineering", "qa"],
      );
      assert.match(run("status", directory), /completed/);
      const businesses = new Businesses(directory);
      try {
        businesses.save({
          id: "test-app",
          name: "测试业务",
          description: "用于验证持续经营",
          audience: "测试用户",
          objective: "验证周期派工",
          stage: "operating",
        });
        businesses.status("test-app", "active");
        const response = await fetch(cfg.url + "/v1/events", {
          method: "POST",
          headers: { authorization: `Bearer ${cfg.source.key}`, "content-type": "application/json" },
          body: JSON.stringify({ id: "wake-test", type: "company.business.wake", subject: "test-app", detail: "{}" }),
        });
        assert.equal(response.status, 200);
        await until(
          () => office!.tasks().filter((t) => t.id.startsWith("B-") && t.status === "awaiting_approval").length === 3,
        );
        assert.equal(businesses.list()[0].cycles.length, 3);
        businesses.status("test-app", "paused");
      } finally {
        businesses.close();
      }
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${logs}`, { cause: error });
    } finally {
      if (up && up.exitCode === null) {
        up.kill("SIGTERM");
        await new Promise((r) => up!.once("exit", r));
      }
      office?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
