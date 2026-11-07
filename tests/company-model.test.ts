// Failure modes: concurrent workers overrun a shared limit, repair turns escape counting, the wrapper calls a
// real model after denial, loses the original assignment, or blocks authenticated owner conversations.
import { createServer } from "node:http";
import { Company } from "../plugins/company/company.ts";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import agent from "../plugins/company/agent.ts";
import { ModelBudget } from "../plugins/company/model-budget.ts";
const exec = promisify(execFile);
test("real wrapper enforces a shared cap, preserves receipts, counts owner and repairs, and defers without a model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "company-model-"));
  try {
    const cfg = { name: "test", database: join(dir, "company.db"), maxAssignments: 6, dailyModelRuns: { total: 1 } };
    const config = join(dir, "company.json");
    writeFileSync(config, JSON.stringify(cfg));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "shell"), '#!/bin/sh\nexec /bin/sh -c "$2"\n', { mode: 0o700 });
    writeFileSync(
      join(bin, "codex"),
      '#!/bin/sh\necho called >> "' +
        join(dir, "calls") +
        '"\nprintf \'%s\\n\' \'{"type":"thread.started","thread_id":"fake-session"}\' \'{"type":"item.completed","item":{"type":"agent_message","text":"完成。"}}\' \'{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}\'\n',
      { mode: 0o700 },
    );
    const run = async (n: number, owner = false, turnNumber = 1) => {
      const folder = join(dir, `run-${n}-${turnNumber}`);
      mkdirSync(folder);
      const contextFile = join(folder, "context.json");
      writeFileSync(
        contextFile,
        JSON.stringify({
          events: owner
            ? []
            : [
                {
                  id: n,
                  source: "company-office",
                  type: "company.work.growth",
                  subject: "work",
                  detail: JSON.stringify({ assignment: 7 }),
                },
              ],
          answers: [],
        }),
      );
      writeFileSync(
        join(folder, "entry.json"),
        JSON.stringify({
          run: n,
          attempt: 1,
          turn: turnNumber,
          job: { rule: { name: owner ? "CEO · 业务答复" : "公司部门-growth" } },
        }),
      );
      const command = agent.command({
        prompt: "test",
        session: "test",
        resume: null,
        cwd: dir,
        access: "read",
        folder,
        contextFile,
        command: [config, "model", owner ? "ceo" : "growth", "codex"],
      });
      const r = await exec(command[0], command.slice(1), {
        env: { ...process.env, PATH: bin + ":" + process.env.PATH, SHELL: join(bin, "shell") },
      });
      return { stdout: r.stdout, reading: agent.read(r.stdout, 0, r.stderr) };
    };
    const first = await Promise.all([run(1), run(2)]);
    assert.equal(first.filter((r) => r.stdout.includes('"companyModel"')).length, 1);
    const denied = first.find((r) => r.stdout.includes('"companyDeferred"'))!;
    assert.match(denied.reading.text!, /company.model.deferred/);
    assert.match(denied.reading.text!, /assignment\\":7/);
    assert.equal(readFileSync(join(dir, "calls"), "utf8").trim().split("\n").length, 1);
    await run(3, true);
    await run(3, true, 2);
    const budget = new ModelBudget(dir, cfg);
    try {
      assert.equal(budget.snapshot().total, 3);
      assert.equal(budget.snapshot().roles.ceo, 2);
      assert.equal(budget.snapshot().limited, true);
    } finally {
      budget.close();
    }
    assert.equal(readFileSync(join(dir, "calls"), "utf8").trim().split("\n").length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("baseline reconstructs issued model claims but excludes queued work, fixed programs and heartbeat replays", () => {
  const dir = mkdtempSync(join(tmpdir(), "company-baseline-"));
  try {
    mkdirSync(join(dir, "hub"));
    const db = new DatabaseSync(join(dir, "hub/hub.db"));
    db.exec("CREATE TABLE facts(seq INTEGER PRIMARY KEY,fact TEXT)");
    const at = Date.now();
    const put = (seq: number, agent: string, state: string, issued: number) =>
      db.prepare("INSERT INTO facts VALUES (?,?)").run(
        seq,
        JSON.stringify({
          seq,
          at,
          type: "claimNext",
          changes: [{ table: "runs", key: String(seq), row: { state, issued, agent, attempts: 0 } }],
        }),
      );
    put(1, "company-growth", "claimed", 1);
    put(2, "company-growth", "claimed", 1);
    put(3, "company-office", "claimed", 3);
    put(4, "company-ceo", "queued", 4);
    put(5, "company-ceo", "claimed", 5);
    db.prepare("INSERT INTO facts VALUES (?,?)").run(
      6,
      JSON.stringify({
        seq: 6,
        at,
        type: "rules",
        changes: [
          {
            table: "config",
            key: "rules",
            row: {
              version: 6,
              value: {
                agents: { "company-growth": { use: "company", command: ["config", "model", "growth", "codex"] } },
              },
            },
          },
        ],
      }),
    );
    put(7, "company-growth", "claimed", 7);
    db.close();
    const cfg = { name: "test", database: join(dir, "company.db"), maxAssignments: 6, dailyModelRuns: { total: 20 } };
    let budget = new ModelBudget(dir, cfg);
    assert.equal(budget.snapshot().total, 2);
    budget.close();
    budget = new ModelBudget(dir, cfg);
    assert.equal(budget.snapshot().total, 2);
    budget.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fixed ticks retry one daily notice key and never call a real messaging service", async () => {
  const dir = mkdtempSync(join(tmpdir(), "company-limit-notice-"));
  const cards = new Set<string>(),
    keys: string[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const part of req) text += part;
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/tell") {
      const body = JSON.parse(text);
      keys.push(body.key);
      cards.add(body.key);
      res.end(JSON.stringify({ card: 1, duplicate: keys.length > 1 }));
    } else res.end(JSON.stringify({ runs: [], cards: [] }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const cfg = { name: "test", database: join(dir, "company.db"), maxAssignments: 6, dailyModelRuns: { total: 0 } };
    const config = join(dir, "company.json");
    writeFileSync(config, JSON.stringify(cfg));
    new Company(cfg).close();
    const budget = new ModelBudget(dir, cfg);
    budget.limited();
    budget.close();
    mkdirSync(join(dir, "hub"));
    writeFileSync(
      join(dir, "hub/config.json"),
      JSON.stringify({
        url: `http://127.0.0.1:${(server.address() as any).port}`,
        owner: "fake",
        source: { key: "fake" },
      }),
    );
    for (let n = 1; n <= 2; n++) {
      const context = join(dir, `context-${n}.json`);
      writeFileSync(
        context,
        JSON.stringify({
          events: [{ id: n, source: "schedule", type: "tick", subject: "company", detail: "{}" }],
          answers: [],
        }),
      );
      await exec(process.execPath, [resolve("plugins/company/business-run.ts"), config, context], {
        env: { ...process.env, AGENT_AUTOLOOP_HOME: join(dir, "hub") },
      });
    }
    assert.equal(keys.length, 2);
    assert.equal(cards.size, 1);
    assert.match(keys[0], /^company-model-limit-\d{4}-\d{2}-\d{2}$/);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  }
});
