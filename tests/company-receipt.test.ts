// Failure modes: company wrappers lose resumable sessions, oversized or invalid CEO decisions bypass bounded
// receipt repair, exhausted repairs replay business, or Codex/Claude sessions are routed to the wrong CLI.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("company-receipt");
const { default: agent } = await import("../plugins/company/agent.ts");
const { chatRule, rolePrompt, ensureBusinessRules, initialize, makeRules } =
  await import("../plugins/company/setup.ts");
const { createWorker } = await import("../worker/worker.ts");
const bin = join(home, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "shell"), '#!/bin/sh\nshift\nexec /bin/sh -c "$@"\n', { mode: 0o700 });
process.env.SHELL = join(bin, "shell");
process.env.PATH = bin + ":" + process.env.PATH;
const decision = (count: number) => ({
  briefs: [],
  approvals: [],
  answers: [],
  escalations: [],
  directives: [
    {
      business: "jizhu",
      action: {
        key: "pack",
        title: "打包",
        kind: "content",
        goal: "打包原稿",
        acceptance: Array(count).fill("核对原稿"),
        priority: 1,
        dueDays: 1,
        followUpDays: 1,
        measure: "审核通过",
      },
    },
  ],
});
let run = 100;
for (const engine of ["codex", "claude"])
  for (const failure of ["length", "acceptance", "report", "exhausted"]) {
    test(`${engine}: ${failure} uses the same session and at most two receipt rewrites`, async () => {
      const dir = join(home, String(++run));
      mkdirSync(dir);
      const cfg = join(dir, "company.json");
      writeFileSync(
        cfg,
        JSON.stringify({
          name: "test",
          database: join(dir, "company.db"),
          maxAssignments: 6,
          dailyModelRuns: { total: 20 },
        }),
      );
      const receipt = (bad: boolean) =>
        "已安排打包\n```agent-autoloop\n" +
        JSON.stringify({
          events: [
            {
              id: "decision",
              type: failure === "report" ? "company.result" : "company.ceo.decision",
              subject: "owner",
              detail: JSON.stringify({
                summary: bad && failure === "length" ? "字".repeat(4117) : "打包",
                executive: decision(bad && failure !== "length" ? 5 : 3),
              }),
            },
          ],
        }) +
        "\n```";
      const fake = `#!${process.execPath}\nimport{appendFileSync,readFileSync}from'node:fs';const a=process.argv.slice(2);appendFileSync(${JSON.stringify(join(dir, "calls"))},JSON.stringify(a)+'\\n');const resume=a.includes('resume')||a.includes('--resume');const text=resume&&${failure !== "exhausted"}?${JSON.stringify(receipt(false))}:${JSON.stringify(receipt(true))};for(const e of ${engine === "codex" ? "[{type:'thread.started',thread_id:'original-session'},{type:'item.completed',item:{type:'agent_message',text}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:2}}]" : "[{type:'result',subtype:'success',session_id:'original-session',result:text,usage:{input_tokens:1,output_tokens:2}}]"})console.log(JSON.stringify(e));`;
      writeFileSync(join(bin, engine), fake, { mode: 0o700 });
      const jobs: any[] = [
        {
          run,
          token: "fake",
          attempt: 1,
          session: null,
          askFirst: [],
          rule: { name: "CEO · 业务答复", cwd: dir },
          agent: {
            id: "company-ceo",
            name: "CEO",
            use: "company",
            access: "read",
            command: [cfg, "model", "ceo", engine],
          },
          context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
        },
      ];
      const results: any[] = [];
      const hub: any = {
        work: async (q: any) => ({ job: q.capacity ? (jobs.shift() ?? null) : null, cancel: [] }),
        started: async () => ({}),
        result: async (_r: any, _t: any, b: any) => {
          results.push(b);
          return { rejected: [] };
        },
      };
      let worker = createWorker({ hub, name: "w", wait: 0 });
      const end = Date.now() + 20000;
      let restarted = false;
      while (!results.length && Date.now() < end) {
        await worker.tick();
        if (!restarted && worker.entries().some((e) => e.repairs > 0)) {
          worker = createWorker({ hub, name: "w", wait: 0 });
          restarted = true;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(results.length, 1);
      assert.equal(results[0].outcome, "done", JSON.stringify(results[0]));
      const calls = readFileSync(join(dir, "calls"), "utf8")
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x));
      assert.equal(calls.length, failure === "exhausted" ? 3 : 2);
      for (const args of calls.slice(1)) {
        assert.ok(args.includes("original-session"));
        assert.match(args.join(" "), /不要重做/);
        assert.match(args.join(" "), failure === "length" ? /4000/ : /acceptance.*3/);
      }
      assert.equal(results[0].outcome, "done");
      assert.equal(results[0].usage.input, calls.length);
      if (failure === "exhausted") {
        assert.equal(results[0].events, undefined);
        assert.match(results[0].notice[0].text, /stdout-1/);
      } else assert.equal(JSON.parse(results[0].events[0].detail).executive.directives[0].action.acceptance.length, 3);
      assert.equal(
        (agent as any).link(results[0].session),
        engine === "codex" ? "codex://threads/original-session" : "claude://resume?session=original-session",
      );
    });
  }
test("acceptance limits reach new and upgraded CEO prompts idempotently", () => {
  for (const prompt of [chatRule(home).prompt, rolePrompt("ceo")]) assert.match(prompt, /acceptance.*1–3.*100/);
  const dir = join(home, "upgrade");
  initialize(dir);
  mkdirSync(join(dir, "hub"), { recursive: true });
  const path = join(dir, "hub/rules.json");
  writeFileSync(path, JSON.stringify(makeRules(dir, "local", "codex")));
  const rules = JSON.parse(readFileSync(path, "utf8"));
  for (const r of rules.rules)
    r.prompt = r.prompt
      ?.split("\n")
      .filter((line: string) => !line.includes("行动验收标准协议 v1"))
      .join("\n");
  writeFileSync(path, JSON.stringify(rules));
  const book = join(dir, "workspace/handbook/ceo.md");
  writeFileSync(
    book,
    readFileSync(book, "utf8")
      .split("\n")
      .filter((line) => !line.includes("行动验收标准协议 v1"))
      .join("\n"),
  );
  ensureBusinessRules(dir);
  assert.match(readFileSync(book, "utf8"), /acceptance.*1–3.*100/);
  const once = readFileSync(path, "utf8");
  ensureBusinessRules(dir);
  assert.equal(readFileSync(path, "utf8"), once);
  for (const r of JSON.parse(once).rules.filter((r: any) => r.to === "company-ceo"))
    assert.match(r.prompt, /acceptance.*1–3.*100/);
});

test("fixed company coordinators do not acquire a model session or resume on failure", async () => {
  const jobs: any[] = [
    {
      run: ++run,
      token: "fake",
      attempt: 1,
      session: null,
      askFirst: [],
      rule: { name: "固定调度", cwd: home },
      agent: {
        id: "company-business",
        name: "调度",
        use: "company",
        access: "read",
        command: [join(home, "missing.json"), "business"],
      },
      context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
    },
  ];
  const results: any[] = [],
    starts: any[] = [];
  const hub: any = {
    work: async (q: any) => ({ job: q.capacity ? (jobs.shift() ?? null) : null, cancel: [] }),
    started: async (_r: any, _t: any, body: any) => {
      starts.push(body);
      return {};
    },
    result: async (_r: any, _t: any, body: any) => {
      results.push(body);
      return { rejected: [] };
    },
  };
  const w = createWorker({ hub, name: "fixed", wait: 0 });
  const end = Date.now() + 20000;
  while (!results.length && Date.now() < end) {
    await w.tick();
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, "failed");
  assert.equal(results[0].session, undefined);
  assert.deepEqual(starts, []);
});
