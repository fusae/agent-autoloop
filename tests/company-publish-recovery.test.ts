// Failure modes: a delayed platform response blocks until tomorrow, timer retries publish twice,
// exhausted lookups loop forever, stale timers affect a new assignment, login loss is retried,
// business-specific staff failures are lost, or the coordinator calls a scheduled readback a missing department report.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { failedWork, pendingVerifications } from "../plugins/company/recovery.ts";
import { Company } from "../plugins/company/company.ts";
const key = "a".repeat(32);
function fixture(fn: (f: any) => void) {
  const dir = mkdtempSync(join(tmpdir(), "publish-recovery-"));
  const db = new DatabaseSync(join(dir, "company.db"));
  const ops = new DatabaseSync(join(dir, "operations.db"));
  db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY,body TEXT)");
  ops.exec("CREATE TABLE projects(id TEXT PRIMARY KEY,body TEXT)");
  const task = { id: "post", kind: "publish-content", status: "active", stage: 0, assignment: 1, publication: key };
  const saveTask = () => db.prepare("INSERT OR REPLACE INTO tasks VALUES (?,?)").run(task.id, JSON.stringify(task));
  saveTask();
  ops
    .prepare("INSERT INTO projects VALUES (?,?)")
    .run(
      "app",
      JSON.stringify({ business: "app", plans: [{ task: "post", publicationKey: key, deliveryDecision: "publish" }] }),
    );
  mkdirSync(join(dir, "publications"));
  writeFileSync(join(dir, "publications", key + ".json"), JSON.stringify({ key, business: "app", artifacts: [] }));
  writeFileSync(join(dir, "company.json"), JSON.stringify({ database: join(dir, "company.db") }));
  const platform = join(dir, "platform.mjs");
  writeFileSync(
    platform,
    `import fs from 'node:fs';let s='';for await(const c of process.stdin)s+=c;
const r=JSON.parse(s);fs.appendFileSync('calls',r.action+'\\n');
const mode=fs.readFileSync('mode','utf8');
if(mode==='published') console.log(JSON.stringify({state:'published',key:r.key,channel:r.channel,remoteId:'post',url:'https://example.com/post',publishedAt:'2026-11-10T08:30:00Z'}));
else if(mode==='login')console.log(JSON.stringify({state:'unknown',reason:'小红书登录已失效，请重新扫码登录'}));
else if(mode==='error')process.exit(1);
else if(r.action==='publish'){fs.writeFileSync('attempt','yes');process.exit(1);}
else console.log(JSON.stringify({state:fs.existsSync('attempt')?'unknown':'absent'}));`,
  );
  writeFileSync(
    join(dir, "publishing.json"),
    JSON.stringify({ projects: { app: { channel: "测试", command: [process.execPath, platform] } } }),
  );
  const mode = (v: string) => writeFileSync(join(dir, "mode"), v);
  mode("unknown");
  const run = (timers?: any[]) => {
    const context = join(dir, "context.json");
    writeFileSync(
      context,
      JSON.stringify({
        events: timers
          ? []
          : [
              {
                source: "company-office",
                type: "company.work.publish",
                subject: "post",
                detail: JSON.stringify({ assignment: 1, publication: key }),
              },
            ],
        timers,
      }),
    );
    const p = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "../plugins/company/publish-run.ts"), join(dir, "company.json"), context],
      { encoding: "utf8" },
    );
    assert.equal(p.status, 0, p.stderr);
    return JSON.parse(p.stdout.split("```agent-autoloop\n")[1].split("\n```")[0]);
  };
  try {
    fn({ dir, run, mode, task, saveTask, calls: () => readFileSync(join(dir, "calls"), "utf8").trim().split("\n") });
  } finally {
    db.close();
    ops.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
test("unknown publication schedules two bounded readbacks and retains its original key", () =>
  fixture(({ run, mode, calls }: any) => {
    const first = run();
    assert.deepEqual(first.events, []);
    assert.equal(first.later.length, 1);
    assert.ok(Math.abs(Date.parse(first.later[0].at) - Date.now() - 15 * 60000) < 10000);
    assert.deepEqual(calls(), ["lookup", "publish", "lookup"]);
    const second = run(first.later);
    assert.deepEqual(second.events, []);
    assert.ok(Math.abs(Date.parse(second.later[0].at) - Date.now() - 60 * 60000) < 10000);
    mode("published");
    const third = run(second.later);
    assert.equal(JSON.parse(third.events[0].detail).publication.key, key);
    assert.deepEqual(calls(), ["lookup", "publish", "lookup", "lookup", "lookup"]);
    assert.equal(third.later[0].cancel, true);
  }));
test("exhaustion blocks, and absent timer reads never submit a post", () =>
  fixture(({ run, calls }: any) => {
    const one = run(),
      two = run(one.later),
      three = run(two.later);
    assert.equal(JSON.parse(three.events[0].detail).verdict, "blocked");
    assert.equal(three.later[0].cancel, true);
    assert.equal(calls().filter((v: string) => v === "publish").length, 1);
  }));
test("preflight transport failure schedules lookup-only; stale assignment is ignored", () =>
  fixture(({ run, mode, calls, task, saveTask }: any) => {
    mode("error");
    const first = run();
    mode("unknown");
    const second = run(first.later);
    assert.deepEqual(calls(), ["lookup", "lookup"]);
    task.assignment++;
    saveTask();
    const stale = run(second.later);
    assert.deepEqual(stale.events, []);
    assert.deepEqual(stale.later, []);
    assert.equal(calls().length, 2);
  }));
test("login loss returns a blocker immediately without a readback timer", () =>
  fixture(({ run, mode, calls }: any) => {
    mode("login");
    const result = run();
    assert.match(JSON.parse(result.events[0].detail).summary, /扫码/);
    assert.ok(result.later.every((t: any) => t.cancel));
    assert.deepEqual(calls(), ["lookup"]);
  }));

test("scheduled publisher and verifier readbacks survive missing-report reconciliation", () =>
  fixture(({ dir, run, task }: any) => {
    const result = run();
    mkdirSync(join(dir, "hub"));
    const hub = new DatabaseSync(join(dir, "hub/hub.db"));
    hub.exec("CREATE TABLE timers(rule TEXT,key TEXT,about TEXT,event_id INTEGER)");
    const put = (timer: any, event: number | null = null) => {
      hub.exec("DELETE FROM timers");
      hub.prepare("INSERT INTO timers VALUES (?,?,?,?)").run("publish-rule", timer.key, timer.about, event);
    };
    const at = new Date(Date.now() - 180000).toISOString();
    const office = { tasks: () => [task], history: () => [{ at }] } as unknown as Company;
    const worker = {
      id: 1,
      rule: "publish-rule",
      agent: "company-publisher",
      events: [{ subject: task.id }],
      state: "done",
      createdAt: at,
      finishedAt: at,
    };
    const reconcile = (r = worker) => failedWork(office, [r], new Date(), pendingVerifications(dir));
    try {
      put(result.later[0]);
      assert.deepEqual(reconcile(), []);
      assert.equal(reconcile({ ...worker, state: "failed" }).length, 1);
      for (const change of [{ assignment: 2 }, { publication: "b".repeat(32) }, { task: "other" }, { attempt: 3 }]) {
        put({ ...result.later[0], about: JSON.stringify({ ...JSON.parse(result.later[0].about), ...change }) });
        assert.equal(reconcile().length, 1);
      }
      put(result.later[0], 99);
      assert.equal(reconcile().length, 1, "consumed timers cannot hide missing final reports");
      task.stage = 1;
      put({ ...result.later[0], key: `verify-${task.id}-${task.assignment}` });
      assert.deepEqual(reconcile({ ...worker, agent: "company-verifier" }), []);
      hub.exec("DELETE FROM timers");
      assert.equal(reconcile({ ...worker, agent: "company-verifier" }).length, 1);
    } finally {
      hub.close();
    }
  }));

test("business staff terminal failures reconcile without consuming live or unrelated runs", () => {
  const at = new Date(Date.now() - 180000).toISOString();
  const task = { id: "draft", kind: "staff-growth", status: "active", stage: 0, assignment: 1 };
  const office = { tasks: () => [task], history: () => [{ at }] } as unknown as Company;
  const run = {
    id: 10,
    agent: "company-staff-jinzhao-growth",
    events: [{ subject: "draft" }],
    state: "failed",
    createdAt: at,
    finishedAt: at,
  };
  assert.equal(failedWork(office, [run]).length, 1);
  assert.deepEqual(failedWork(office, [{ ...run, state: "claimed" }]), []);
  assert.deepEqual(failedWork(office, [{ ...run, agent: "company-staff-jinzhao-qa" }]), []);
  assert.deepEqual(failedWork(office, [{ ...run, events: [{ subject: "other" }] }]), []);
});
