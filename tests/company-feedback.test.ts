// Failure modes: program verification invokes QA or republishes; unknown results loop forever;
// daily collectors duplicate reads, ignore access blocks, invent zeros, fetch manual details, or mix ownership.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readXhs, type Observation } from "../plugins/xiaohongshu/reader.ts";
import { verifyPublication } from "../plugins/company/verification.ts";
import { collectFeedback, compareDays } from "../plugins/company/feedback.ts";
import { Company } from "../plugins/company/company.ts";
import { Operations } from "../plugins/company/operations.ts";
import { Businesses } from "../plugins/company/business.ts";
import { makeRules, ensureBusinessRules } from "../plugins/company/setup.ts";
import { parseRules } from "../protocol/rules.ts";
import { resultFrom, readMessage } from "../worker/contract.ts";
const key = "a".repeat(32),
  id = "b".repeat(24),
  account = "c".repeat(24);
const proof = {
  key,
  channel: "test",
  remoteId: id,
  url: `https://www.xiaohongshu.com/explore/${id}`,
  publishedAt: "2026-11-07T10:05:17.000Z",
};
const observation: Observation = {
  state: "ready",
  account,
  followers: 86,
  others: [],
  notes: [
    {
      id,
      author: account,
      title: "标题",
      content: "正文",
      images: 1,
      publishedAt: proof.publishedAt,
      likes: 2,
      collects: 3,
      comments: 4,
    },
  ],
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "company-feedback-"));
  mkdirSync(join(dir, "publications"));
  mkdirSync(join(dir, "workspace/knowledge"), { recursive: true });
  const content = JSON.stringify({ title: "标题", content: "正文", images: [{}] });
  writeFileSync(
    join(dir, "publications", key + ".json"),
    JSON.stringify({
      key,
      business: "jizhu",
      artifacts: [{ path: "xiaohongshu.json", content, sha256: createHash("sha256").update(content).digest("hex") }],
    }),
  );
  writeFileSync(join(dir, "publications", key + "-result.json"), JSON.stringify(proof));
  const reader = join(dir, "reader.mjs");
  writeFileSync(
    reader,
    `let s=''; for await(const c of process.stdin)s+=c;const r=JSON.parse(s);if(r.action!=='read'||r.notes[0]!=='${id}')process.exit(2);console.log(JSON.stringify(${JSON.stringify(observation)}));`,
  );
  writeFileSync(
    join(dir, "feedback.json"),
    JSON.stringify({ enabled: true, accountId: account, command: [process.execPath, reader] }),
  );
  return { dir, reader, clean: () => rmSync(dir, { recursive: true, force: true }) };
}
test("narrow reader rejects writes and arbitrary targets, stops on access failure, never paginates comments", async () => {
  const f = fixture(),
    calls: string[] = [];
  const config = { endpoint: "http://127.0.0.1:18060", token: "fake", accountId: account };
  const call = async (path: string, body?: any) => {
    calls.push(path);
    if (path.endsWith("status")) return { is_logged_in: true, user_id: account };
    if (path.endsWith("me"))
      return {
        data: { userBasicInfo: {}, interactions: [{ type: "fans", count: "86" }], feeds: [{ id, xsecToken: "fake" }] },
      };
    assert.deepEqual(body, { feed_id: id, xsec_token: "fake", load_all_comments: false });
    return {
      data: {
        note: {
          noteId: id,
          user: { userId: account },
          title: "标题",
          desc: "正文",
          time: Date.parse(proof.publishedAt),
          imageList: [{}],
          interactInfo: { likedCount: "2", collectedCount: "3", commentCount: "4" },
        },
      },
    };
  };
  try {
    for (const request of [
      { action: "publish", notes: [] },
      { action: "read", notes: [], url: "https://elsewhere" },
      { action: "read", notes: ["../secret"] },
    ])
      await assert.rejects(readXhs(config, join(f.dir, "remote"), request, call));
    assert.equal(calls.length, 0);
    assert.deepEqual(await readXhs(config, join(f.dir, "remote"), { action: "read", notes: [id] }, call), observation);
    calls.length = 0;
    const denied = await readXhs(config, join(f.dir, "remote"), { action: "read", notes: [id] }, async (path) => {
      calls.push(path);
      throw Error("captcha");
    });
    assert.equal(denied.state, "blocked");
    const timeout = await readXhs(config, join(f.dir, "remote"), { action: "read", notes: [id] }, async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    assert.equal(timeout.state, "unknown");
    assert.equal(calls.length, 1);
    const wrong = await readXhs(
      { ...config, accountId: "wrong" },
      join(f.dir, "remote"),
      { action: "read", notes: [id] },
      call,
    );
    assert.equal(wrong.state, "blocked");
  } finally {
    f.clean();
  }
});
test("verification compares actual content and program retry retains the publication, bypassing model budget", () => {
  const f = fixture();
  const config = { name: "test", database: join(f.dir, "company.db"), maxAssignments: 10, ceoMode: true };
  let c = new Company(config),
    sequence = 0;
  const send = (source: string, type: string, data: any) =>
    c.process({
      events: [{ id: ++sequence, source, type, subject: "P-test", detail: JSON.stringify(data) }],
      answers: [],
    });
  try {
    send("company-inbox", "company.task.create", {
      kind: "publish-content",
      title: "标题",
      goal: "发布",
      acceptance: ["核验"],
      publication: key,
    });
    const report = {
      assignment: 1,
      verdict: "pass",
      summary: "published",
      artifacts: ["publication.json"],
      evidence: ["platform"],
      publication: proof,
    };
    const old = send("company-growth", "company.result", report);
    assert.ok(old.events?.some((e) => e.type === "company.work.qa"));
    send("company-qa", "company.result", { ...report, assignment: 2, verdict: "blocked" });
    c.close();
    const program = { ...config, publishVerification: "program" as const, dailyModelRuns: { total: 0, qa: 0 } };
    writeFileSync(join(f.dir, "company.json"), JSON.stringify(program));
    c = new Company(program);
    const resumed = send("company-inbox", "company.task.retry", {});
    const event = resumed.events!.find((e) => e.type === "company.work.verify")!;
    assert.ok(event);
    assert.equal(c.task("P-test")!.stage, 1);
    assert.equal(c.task("P-test")!.status, "active");
    assert.equal(verifyPublication(f.dir, key).state, "verified");
    for (const altered of [{ title: "changed" }, { author: "wrong" }, { content: "changed" }, { images: 2 }])
      assert.equal(
        verifyPublication(f.dir, key, () => ({ ...observation, notes: [{ ...observation.notes[0], ...altered }] }))
          .state,
        "unknown",
      );
    writeFileSync(
      join(f.dir, "context.json"),
      JSON.stringify({ events: [{ ...event, source: "company-office" }], timers: [] }),
    );
    const run = () => {
      const p = spawnSync(
        process.execPath,
        ["plugins/company/verify-run.ts", join(f.dir, "company.json"), join(f.dir, "context.json")],
        { encoding: "utf8" },
      );
      assert.equal(p.status, 0, p.stderr);
      const parsed = resultFrom(readMessage(p.stdout), {});
      assert.equal(parsed.problem, undefined);
      return parsed.result;
    };
    const passed = run();
    assert.equal(passed.events?.length, 1);
    assert.equal(passed.later?.length, 0);
    send("company-verifier", "company.result", JSON.parse(passed.events![0].detail!));
    assert.equal(c.task("P-test")!.status, "completed");
    assert.equal(run().events?.length, 0);
  } finally {
    c.close();
    f.clean();
  }
});
test("unknown verification schedules two finite rechecks; access block returns to CEO immediately", () => {
  const f = fixture(),
    config = {
      name: "test",
      database: join(f.dir, "company.db"),
      maxAssignments: 8,
      publishVerification: "program" as const,
      ceoMode: true,
    };
  const c = new Company(config);
  let seq = 0;
  const send = (source: string, type: string, data: any) =>
    c.process({ events: [{ id: ++seq, source, type, subject: "P-test", detail: JSON.stringify(data) }], answers: [] });
  try {
    writeFileSync(join(f.dir, "company.json"), JSON.stringify(config));
    send("company-inbox", "company.task.create", {
      kind: "publish-content",
      title: "标题",
      goal: "发布",
      acceptance: ["核验"],
      publication: key,
    });
    const receipt = send("company-growth", "company.result", {
      assignment: 1,
      verdict: "pass",
      summary: "published",
      artifacts: ["publication.json"],
      evidence: ["platform"],
      publication: proof,
    });
    const event = receipt.events!.find((e) => e.type === "company.work.verify")!;
    let context: any = { events: [{ ...event, source: "company-office" }], timers: [] };
    writeFileSync(f.reader, 'console.log(JSON.stringify({state:"unknown",reason:"审核中"}))');
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(f.dir, "context.json"), JSON.stringify(context));
      const p = spawnSync(
        process.execPath,
        ["plugins/company/verify-run.ts", join(f.dir, "company.json"), join(f.dir, "context.json")],
        { encoding: "utf8" },
      );
      assert.equal(p.status, 0, p.stderr);
      const r = resultFrom(readMessage(p.stdout), {}).result;
      if (i < 2) {
        assert.equal(r.events?.length, 0);
        assert.equal(r.later?.length, 1);
        context = { events: [], timers: r.later };
      } else {
        assert.equal(r.later?.length, 0);
        assert.equal(JSON.parse(r.events![0].detail!).verdict, "blocked");
      }
    }
    writeFileSync(f.reader, 'console.log(JSON.stringify({state:"blocked",reason:"请扫码"}))');
    writeFileSync(join(f.dir, "context.json"), JSON.stringify({ events: [{ ...event, source: "company-office" }] }));
    const p = spawnSync(
      process.execPath,
      ["plugins/company/verify-run.ts", join(f.dir, "company.json"), join(f.dir, "context.json")],
      { encoding: "utf8" },
    );
    const r = resultFrom(readMessage(p.stdout), {}).result;
    assert.equal(r.later?.length, 0);
    assert.equal(JSON.parse(r.events![0].detail!).verdict, "blocked");
  } finally {
    c.close();
    f.clean();
  }
});
test("daily data survives restart, pauses on access restrictions and never converts missing data to zero", async () => {
  const f = fixture();
  let calls = 0,
    notices = 0;
  const read = () => {
    calls++;
    return observation;
  };
  try {
    const leader = { manualMetrics: [] } as any;
    await collectFeedback(f.dir, leader, new Date("2026-11-08T01:00:00Z"), read);
    assert.equal(calls, 0);
    await collectFeedback(f.dir, leader, new Date("2026-11-08T01:35:00Z"), read);
    assert.equal(calls, 1);
    await collectFeedback(f.dir, leader, new Date("2026-11-08T02:35:00Z"), read);
    assert.equal(calls, 1);
    const blocked = () => {
      calls++;
      return { state: "blocked" as const, reason: "请扫码" };
    };
    await collectFeedback(f.dir, leader, new Date("2026-11-09T01:35:00Z"), blocked, async () => {
      notices++;
    });
    await collectFeedback(f.dir, leader, new Date("2026-11-10T01:35:00Z"), read, async () => {
      notices++;
    });
    assert.equal(calls, 2);
    assert.equal(notices, 1);
    const data = JSON.parse(readFileSync(join(f.dir, "workspace/knowledge/feedback.json"), "utf8"));
    assert.equal(data.followers[0].count, 86);
    assert.equal(data.posts[0].samples[0].likes, 2);
    assert.equal(data.posts[0].reads.length, 0);
    const values = Object.fromEntries(
      [4, 5, 6, 8, 9, 10].map((d) => [`2026-11-${String(d).padStart(2, "0")}`, d < 7 ? 0 : 2]),
    );
    const complete = compareDays(proof.publishedAt, values, new Date("2026-11-11T01:00:00Z"));
    assert.equal(complete.baseline, 0);
    assert.equal(complete.result, 6);
    assert.equal(complete.percent, null);
    assert.equal(compareDays(proof.publishedAt, values, new Date("2026-11-10T01:00:00Z")).result, null);
  } finally {
    f.clean();
  }
});
test("manual reads require authentic owner event and preserve source, time and idempotency", () => {
  const f = fixture();
  mkdirSync(join(f.dir, "hub"));
  const h = new DatabaseSync(join(f.dir, "hub/hub.db"));
  h.exec("CREATE TABLE events(id INTEGER PRIMARY KEY,source TEXT,type TEXT,detail TEXT,received_at TEXT)");
  const o = new Operations(f.dir),
    b = new Businesses(f.dir);
  o.leadership(true, new Date());
  let seq = 0;
  const decide = (reads: number, event = 7) =>
    o.plan(`m-${++seq}`, b.list(), [], new Date(), [], 1, [
      {
        id: seq,
        source: "company-ceo",
        type: "company.ceo.decision",
        subject: "owner",
        detail: JSON.stringify({
          summary: "记录阅读量",
          executive: {
            briefs: [],
            directives: [],
            approvals: [],
            answers: [],
            escalations: [],
            manualMetrics: [{ publication: key, event, reads }],
          },
        }),
      },
    ]);
  try {
    h.prepare("INSERT INTO events VALUES(7,'company-inbox','company.owner.question',?,?)").run(
      JSON.stringify({ question: "记住首篇阅读120", message: "owner-message" }),
      "2026-11-08T01:00:00Z",
    );
    decide(120);
    decide(120);
    assert.equal(o.executive().manualMetrics?.length, 1);
    assert.equal(o.executive().manualMetrics![0].source, "董事长");
    assert.equal(o.executive().manualMetrics![0].at, "2026-11-08T01:00:00Z");
    decide(999);
    assert.equal(o.executive().manualMetrics![0].reads, 120);
    h.prepare("INSERT INTO events VALUES(8,'company-growth','company.owner.question',?,?)").run(
      JSON.stringify({ question: "120", message: "fake" }),
      "2026-11-08T01:00:00Z",
    );
    decide(999, 8);
    assert.equal(o.executive().manualMetrics?.length, 1);
  } finally {
    h.close();
    o.close();
    b.close();
    f.clean();
  }
});
test("program rule upgrades are idempotent and keep the fixed verifier on the control worker", () => {
  const f = fixture();
  mkdirSync(join(f.dir, "hub"));
  try {
    const config = {
      name: "test",
      database: join(f.dir, "company.db"),
      maxAssignments: 8,
      publishVerification: "program",
      ceoMode: true,
    };
    writeFileSync(join(f.dir, "company.json"), JSON.stringify(config));
    writeFileSync(join(f.dir, "hub/rules.json"), JSON.stringify(makeRules(f.dir, "local", "codex")));
    ensureBusinessRules(f.dir);
    const first = readFileSync(join(f.dir, "hub/rules.json"), "utf8");
    ensureBusinessRules(f.dir);
    assert.equal(readFileSync(join(f.dir, "hub/rules.json"), "utf8"), first);
    parseRules(first, Date.now(), "Asia/Shanghai");
    const rules = JSON.parse(first);
    assert.equal(rules.rules.filter((r: any) => r.name === "发布程序核验").length, 1);
    assert.ok(rules.rules.find((r: any) => r.name === "公司部门-ceo").prompt.includes("效果回流协议 v1"));
    assert.ok(!rules.rules.find((r: any) => r.name === "公司部门-ceo").prompt.includes("只有平台发布确认且 QA 通过"));
  } finally {
    f.clean();
  }
});
test("product summaries use Beijing days, millisecond registration timestamps, and filtered download requests", () => {
  const f = fixture();
  try {
    const code = String.raw`import runpy,sqlite3,pathlib,datetime,json,gzip
m=runpy.run_path('scripts/company-product-metrics.py'); p=pathlib.Path(__import__('sys').argv[1]); db=sqlite3.connect(p/'product.db'); db.executescript('CREATE TABLE devices(created_at TEXT);CREATE TABLE users(created INTEGER)'); db.execute('INSERT INTO devices VALUES(?)',('2026-11-06T16:01:00Z',)); db.execute('INSERT INTO users VALUES(?)',(int(datetime.datetime.fromisoformat('2026-11-07T15:59:00+00:00').timestamp()*1000),));db.commit();db.close()
now=datetime.datetime.fromisoformat('2026-11-08T02:00:00+00:00'); devices=m['daily_counts'](p/'product.db','devices',"date(created_at,'+8 hours')",now); users=m['daily_counts'](p/'product.db','users',"date(created/1000.0,'unixepoch','+8 hours')",now)
lines=['127.0.0.1 - - [06/Nov/2026:00:00:00 +0000] "GET / HTTP/1.1" 200 10 "-" "Mozilla"','127.0.0.1 - - [06/Nov/2026:16:01:00 +0000] "GET /downloads/JiZhu.apk HTTP/1.1" 206 10 "-" "Mozilla"','127.0.0.1 - - [07/Nov/2026:10:00:00 +0000] "GET /downloads/JiZhu.apk HTTP/1.1" 200 10 "-" "Googlebot"','127.0.0.1 - - [07/Nov/2026:11:00:00 +0000] "GET /downloads/JiZhu.apk HTTP/1.1" 404 10 "-" "Mozilla"','127.0.0.1 - - [08/Nov/2026:01:00:00 +0000] "GET / HTTP/1.1" 200 10 "-" "Mozilla"']; (p/'access.log').write_text('\n'.join(lines).replace('\\n','\n'))
with gzip.open(p/'access.log.1.gz','wt') as out:out.write('127.0.0.1 - - [05/Nov/2026:00:00:00 +0000] "GET / HTTP/1.1" 200 10 "-" "Mozilla"\n')
print(json.dumps({'devices':devices,'users':users,'downloads':m['download_counts'](p,now)}))`;
    const r = spawnSync("python3", ["-c", code, f.dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.deepEqual(data.devices.rows.at(-1), ["2026-11-07", 1]);
    assert.deepEqual(data.users.rows.at(-1), ["2026-11-07", 1]);
    assert.deepEqual(
      data.downloads.daily.rows.find((r: any) => r[0] === "2026-11-07"),
      ["2026-11-07", 1],
    );
  } finally {
    f.clean();
  }
});

test("browser HTTP 500 is unknown and HTTP 401 stops collection without further requests", async () => {
  const f = fixture();
  let status = 500,
    calls = 0;
  const server = createServer((_req, res) => {
    calls++;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: false }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  const config = { endpoint: `http://127.0.0.1:${address.port}`, token: "fake", accountId: account };
  try {
    assert.equal((await readXhs(config, join(f.dir, "remote"), { action: "read", notes: [id] })).state, "unknown");
    assert.equal(calls, 1);
    status = 401;
    assert.equal((await readXhs(config, join(f.dir, "remote"), { action: "read", notes: [id] })).state, "blocked");
    assert.equal(calls, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.clean();
  }
});

test("manual posts stay separate, deduplicate Beijing days and disappear when a system receipt arrives", async () => {
  const f = fixture();
  const manualId = "d".repeat(24);
  const legacy = { ...observation };
  delete legacy.others;
  const daily = (day: string, likes: number | null) => ({
    day,
    at: `${day}T02:00:00.000Z`,
    observation: {
      ...observation,
      others: [
        { id, title: "系统发布", likes: 9 },
        { id: manualId, title: "自己写的", likes },
        { id: manualId, title: "自己写的", likes },
      ],
    },
  });
  try {
    writeFileSync(
      join(f.dir, "feedback-state.json"),
      JSON.stringify({
        days: [
          { day: "2026-11-07", at: "2026-11-07T02:00:00.000Z", observation: legacy },
          daily("2026-11-08", null),
          daily("2026-11-08", 99),
          daily("2026-11-09", 3),
          daily("2026-11-10", 5),
        ],
        products: {},
        resume: "",
      }),
    );
    const collect = () =>
      collectFeedback(f.dir, { manualMetrics: [] } as any, new Date("2026-11-10T03:00:00Z"), () => {
        throw Error("must reuse daily data");
      });
    await collect();
    await collect();
    const data = JSON.parse(readFileSync(join(f.dir, "workspace/knowledge/feedback.json"), "utf8"));
    assert.equal(data.posts.length, 1);
    assert.deepEqual(data.manual, [
      {
        id: manualId,
        title: "自己写的",
        url: `https://www.xiaohongshu.com/explore/${manualId}`,
        firstSeen: "2026-11-08T02:00:00.000Z",
        samples: [
          { at: "2026-11-08T02:00:00.000Z", likes: null },
          { at: "2026-11-09T02:00:00.000Z", likes: 3 },
          { at: "2026-11-10T02:00:00.000Z", likes: 5 },
        ],
      },
    ]);
    const md = readFileSync(join(f.dir, "workspace/knowledge/feedback.md"), "utf8");
    assert.match(md, /董事长自己发的帖子/);
    assert.match(md, /赞待完整数据/);
    assert.match(md, /赞5；变化2/);
    writeFileSync(
      join(f.dir, "publications", "e".repeat(32) + "-result.json"),
      JSON.stringify({
        ...proof,
        key: "e".repeat(32),
        remoteId: manualId,
        url: `https://www.xiaohongshu.com/explore/${manualId}`,
      }),
    );
    await collect();
    assert.deepEqual(JSON.parse(readFileSync(join(f.dir, "workspace/knowledge/feedback.json"), "utf8")).manual, []);
  } finally {
    f.clean();
  }
});

test("reader extracts other list cards without detail reads and keeps unknown likes null", async () => {
  const f = fixture();
  const likes = ["12", 0, "0", "1万", undefined, -1, 1.5, "", "2.0", Number.MAX_SAFE_INTEGER + 1];
  const ids = likes.map((_, i) => i.toString(16).padStart(24, "0"));
  const paths: string[] = [];
  try {
    const result = await readXhs(
      { endpoint: "http://127.0.0.1:18060", token: "fake", accountId: account },
      join(f.dir, "remote"),
      { action: "read", notes: [] },
      async (path) => {
        paths.push(path);
        if (path.endsWith("status")) return { is_logged_in: true, user_id: account };
        assert.equal(path, "/api/v1/user/me");
        return {
          data: {
            userBasicInfo: {},
            interactions: [{ type: "fans", count: "86" }],
            feeds: [
              ...likes.map((value, i) => ({
                id: ids[i],
                noteCard: { displayTitle: `标题${i}`, interactInfo: { likedCount: value } },
              })),
              { id: "bad-id", noteCard: { displayTitle: "忽略无效编号" } },
            ],
          },
        };
      },
    );
    assert.equal(result.state, "ready");
    if (result.state !== "ready") return;
    assert.deepEqual(
      result.others,
      ids.map((id, i) => ({ id, title: `标题${i}`, likes: [12, 0, 0][i] ?? null })),
    );
    assert.deepEqual(result.notes, []);
    assert.deepEqual(paths, ["/api/v1/login/status", "/api/v1/user/me"]);
  } finally {
    f.clean();
  }
});
