// Failure modes: shared accounts exceed the Beijing daily cap, CEO bypasses owner approval,
// stale/replayed answers publish a revision, or pending/failed posts are mistaken for successes.
import { DatabaseSync } from "node:sqlite";
import { interactiveCard } from "../plugins/company/channel.ts";
import assert from "node:assert/strict";
import { initialize, ensureBusinessRules } from "../plugins/company/setup.ts";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Company, type Task, type Context } from "../plugins/company/company.ts";
import { Businesses } from "../plugins/company/business.ts";
import { Operations } from "../plugins/company/operations.ts";

const decision = (more = {}) => ({ briefs: [], directives: [], approvals: [], answers: [], escalations: [], ...more });
function fixture(
  fn: (x: any) => void,
  controls: object = { publishDailyLimit: 1, publishApproval: { confirmFirst: 5 } },
) {
  const dir = mkdtempSync(join(tmpdir(), "company-publish-guards-"));
  const config = {
    name: "公司",
    database: join(dir, "company.db"),
    maxAssignments: 6,
    ceoMode: true,
    contentReview: "ceo",
    inspections: false,
    ...controls,
  };
  writeFileSync(join(dir, "company.json"), JSON.stringify(config));
  writeFileSync(
    join(dir, "publishing.json"),
    JSON.stringify({
      projects: Object.fromEntries(
        ["jizhu", "jinzhao"].map((id) => [id, { channel: "共用账号", command: [process.execPath, "unused.ts"] }]),
      ),
    }),
  );
  const c = new Company(config as any),
    b = new Businesses(dir);
  let o = new Operations(dir),
    seq = 0,
    now = new Date("2026-11-07T15:50:00Z");
  const send = (source: string, type: string, subject: string, data: any) =>
    c.process({ events: [{ id: ++seq, source, type, subject, detail: JSON.stringify(data) }], answers: [] });
  const tick = (answers: Context["answers"] = []) => o.plan(`tick-${++seq}`, b.list(), c.tasks(), now, answers);
  const decide = (more: any) =>
    o.plan(`decision-${++seq}`, b.list(), c.tasks(), now, [], 1, [
      {
        id: seq,
        source: "company-ceo",
        type: "company.ceo.decision",
        subject: "owner",
        detail: JSON.stringify({ summary: "审核", executive: decision(more) }),
      },
    ]);
  const plans = () =>
    o
      .snapshot(b.list(), c.tasks(), now)
      .sort((a, b) => (a.business === "jizhu" ? -1 : 1))
      .flatMap((p) => p.plans);
  const approve = (i: number) => {
    const p = plans()[i];
    return decide({
      deliveries: [
        {
          business: i ? "jinzhao" : "jizhu",
          plan: p.id,
          task: p.task,
          verdict: "publish",
          reason: "通过",
          files: c.task(p.task!)!.reports.at(-1)!.artifacts,
        },
      ],
    });
  };
  const publishes = (r: any) => r.events?.filter((e: any) => JSON.parse(e.detail).kind === "publish-content") ?? [];
  const proof = (key: string, at = now.toISOString()) =>
    writeFileSync(
      join(dir, "publications", key + "-result.json"),
      JSON.stringify({ key, channel: "共用账号", remoteId: key, url: `https://example.com/${key}`, publishedAt: at }),
    );
  try {
    for (const id of ["jizhu", "jinzhao"]) {
      b.save(
        {
          id,
          name: id === "jizhu" ? "记住" : "今朝阅读",
          description: "说明",
          audience: "用户",
          objective: "推广",
          stage: "operating",
        },
        now,
      );
      b.autonomy(id, true, now);
      b.status(id, "active", now);
    }
    o.leadership(true, now);
    const r = decide({
      briefs: ["jizhu", "jinzhao"].map((business) => ({ business, objective: "推广" })),
      directives: ["jizhu", "jinzhao"].map((business) => ({
        business,
        action: {
          key: "post",
          title: "图文",
          kind: "content",
          goal: "制作图文",
          acceptance: ["准确"],
          priority: 1,
          dueDays: 1,
          followUpDays: 3,
          measure: "新增",
        },
      })),
    });
    for (const e of r.events ?? []) {
      if (JSON.parse(e.detail).kind !== "internal-content") continue;
      send("company-inbox", e.type, e.subject, JSON.parse(e.detail));
      const path = `tasks/${e.subject}/xiaohongshu.json`;
      mkdirSync(join(dir, "workspace/tasks", e.subject), { recursive: true });
      writeFileSync(
        join(dir, "workspace", path),
        JSON.stringify({
          title: "审核标题",
          content: "文".repeat(250),
          images: [{ mime: "image/png", base64: "iVBORw0KGgo=" }],
        }),
      );
      send("company-growth", "company.result", e.subject, {
        assignment: 1,
        verdict: "pass",
        summary: "图文交付",
        artifacts: [path],
        evidence: ["产品资料"],
      });
    }
    tick();
    fn({
      dir,
      c,
      b,
      plans,
      approve,
      tick,
      proof,
      publishes,
      now: (value: string) => {
        now = new Date(value);
      },
      restart: () => {
        o.close();
        o = new Operations(dir);
      },
    });
  } finally {
    o.close();
    b.close();
    c.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("owner card previews frozen content; only explicit publish dispatches once and survives restart", () =>
  fixture(({ dir, plans, approve, tick, publishes, restart }: any) => {
    const r = approve(0),
      card = r.ask?.find((a: any) => a.options.includes("发布"));
    assert.ok(card, "CEO publish must ask owner first");
    assert.deepEqual(card.options, ["发布", "退回修改", "暂缓"]);
    assert.match(card.text, /记住/);
    assert.match(card.text, /审核标题/);
    assert.match(card.text, /图片.*1/);
    assert.ok(card.text.includes("文".repeat(250)));
    assert.equal(publishes(r).length, 0);
    const p = plans()[0];
    writeFileSync(join(dir, "workspace", `tasks/${p.deliveryTask}/xiaohongshu.json`), "未经审核的修改");
    restart();
    assert.equal(publishes(tick()).length, 0);
    const clarification = tick([{ card: 10, choice: null, about: card.about, text: "补充意见" }]);
    assert.equal(publishes(clarification).length, 0);
    const renewed = clarification.ask?.find((a: any) => a.options.includes("发布"));
    assert.ok(renewed);
    assert.notEqual(renewed.about, card.about);
    assert.equal(publishes(tick([{ card: 11, choice: 0, about: card.about }])).length, 0);
    const answer = { card: 12, choice: 0, about: renewed.about, text: "按审核稿发布" };
    assert.equal(publishes(tick([answer])).length, 1);
    assert.equal(publishes(tick([answer])).length, 0);
  }));

test("return uses revision workflow; deferred cards and old answers cannot approve a new round", () =>
  fixture(({ approve, tick, plans, publishes, now }: any) => {
    const first = approve(0).ask.find((a: any) => a.options.includes("发布"));
    const returned = tick([{ card: 20, choice: 1, about: first.about, text: "补充截图" }]);
    assert.equal(publishes(returned).length, 0);
    assert.ok(returned.events?.some((e: any) => JSON.parse(e.detail).kind === "internal-content"));
    assert.equal(plans()[0].revision, 1);
    assert.match(plans()[0].result, /补充截图/);
    const second = approve(1).ask.find((a: any) => a.options.includes("发布"));
    assert.equal(publishes(tick([{ card: 21, choice: 2, about: second.about }])).length, 0);
    assert.equal(publishes(tick([{ card: 22, choice: 0, about: second.about }])).length, 0);
    now("2026-11-07T16:01:00Z");
    const next = tick().ask.find((a: any) => a.options.includes("发布"));
    assert.notEqual(next.about, second.about);
    assert.equal(publishes(tick([{ card: 23, choice: 0, about: second.about }])).length, 0);
    assert.equal(publishes(tick([{ card: 24, choice: 0, about: next.about }])).length, 1);
  }));

test("two apps share one reservation and Beijing daily cap; success releases next day without failure", () =>
  fixture(
    ({ approve, tick, plans, proof, publishes, now, restart }: any) => {
      assert.equal(publishes(approve(0)).length, 1);
      assert.equal(publishes(approve(1)).length, 0, "in-flight publication reserves shared capacity");
      const first = plans()[0];
      restart();
      now("2026-11-07T16:01:00Z");
      assert.equal(publishes(tick()).length, 0, "uncertain old-day attempt must reconcile before another post");
      proof(first.publicationKey, "2026-11-07T16:00:30Z");
      assert.equal(publishes(tick()).length, 0, "late result uses platform's Beijing day");
      assert.notEqual(plans()[1].status, "blocked");
      now("2026-11-08T16:00:00Z");
      assert.equal(publishes(tick()).length, 1);
    },
    { publishDailyLimit: 1 },
  ));

test("five confirmed successes disable approval; four successes and any failures do not", () => {
  for (const count of [4, 5])
    fixture(
      ({ dir, approve, proof, publishes }: any) => {
        mkdirSync(join(dir, "publications"), { recursive: true });
        for (let i = 0; i < count; i++) proof(String(i + 1).padStart(32, "0"), "2026-11-06T00:00:00Z");
        writeFileSync(join(dir, "publications", "failed.json"), JSON.stringify({ state: "unknown" }));
        const r = approve(0);
        assert.equal(publishes(r).length, count === 5 ? 1 : 0);
        assert.equal(!!r.ask?.some((a: any) => a.options.includes("发布")), count < 5);
      },
      { publishApproval: { confirmFirst: 5 } },
    );
});

test("publication guard configuration rejects invalid limits", () => {
  for (const extra of [
    { publishDailyLimit: -1 },
    { publishDailyLimit: 0.5 },
    { publishApproval: { confirmFirst: -1 } },
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "company-publish-config-"));
    try {
      assert.throws(
        () => new Company({ name: "公司", database: join(dir, "db"), maxAssignments: 1, ...extra } as any),
        /发布/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// A worker can receive a stale/pre-upgrade job; it must independently reject unapproved publication.
test("fixed publisher rechecks owner approval on pre-existing queued work", () =>
  fixture(({ dir, c, approve, publishes }: any) => {
    const event = publishes(approve(0))[0];
    const receipt = c.process({ events: [{ ...event, id: "dispatch", source: "company-inbox" }], answers: [] });
    const config = JSON.parse(readFileSync(join(dir, "company.json"), "utf8"));
    config.publishApproval = { confirmFirst: 5 };
    writeFileSync(join(dir, "company.json"), JSON.stringify(config));
    const path = join(dir, "context.json");
    writeFileSync(
      path,
      JSON.stringify({ events: receipt.events.map((e: any) => ({ ...e, source: "company-office" })) }),
    );
    const r = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "../plugins/company/publish-run.ts"), join(dir, "company.json"), path],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /负责人.*确认/);
  }, {}));

test("publication rule upgrade is conditional, idempotent and reversible", () => {
  const dir = mkdtempSync(join(tmpdir(), "company-publish-rules-"));
  try {
    rmSync(dir, { recursive: true });
    initialize(dir);
    mkdirSync(join(dir, "hub"));
    writeFileSync(join(dir, "hub/rules.json"), readFileSync(join(dir, "rules.company.json")));
    const configFile = join(dir, "company.json"),
      rulesFile = join(dir, "hub/rules.json");
    const cfg = JSON.parse(readFileSync(configFile, "utf8"));
    cfg.publishApproval = { confirmFirst: 5 };
    cfg.publishDailyLimit = 1;
    writeFileSync(configFile, JSON.stringify(cfg));
    ensureBusinessRules(dir);
    ensureBusinessRules(dir);
    const rules = JSON.parse(readFileSync(rulesFile, "utf8"));
    for (const r of rules.rules.filter((r: any) => r.name.startsWith("公司部门-") || r.name === "CEO · 业务答复"))
      assert.equal(r.prompt.split("负责人发布确认协议 v1").length, 2);
    delete cfg.publishApproval;
    delete cfg.publishDailyLimit;
    writeFileSync(configFile, JSON.stringify(cfg));
    ensureBusinessRules(dir);
    assert.ok(!readFileSync(rulesFile, "utf8").includes("负责人发布确认协议 v1"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function deliveredPreview(dir: string, about: string, at: string, answer?: { at: string; choice: number }) {
  mkdirSync(join(dir, "hub"), { recursive: true });
  const db = new DatabaseSync(join(dir, "hub/hub.db"));
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS projections(collection TEXT,key TEXT,data TEXT); CREATE TABLE IF NOT EXISTS facts(seq INTEGER PRIMARY KEY,fact TEXT);",
    );
    db.prepare("DELETE FROM projections WHERE collection='cards' AND key='901'").run();
    db.prepare("INSERT INTO projections VALUES ('cards','901',?)").run(
      JSON.stringify({
        id: 901,
        agent: "company-business",
        grp: "company-business",
        about,
        state: answer ? "decided" : "open",
        choice: answer?.choice ?? null,
        decided_at: answer?.at ?? null,
      }),
    );
    if (!db.prepare("SELECT 1 FROM facts WHERE seq=1").get())
      db.prepare("INSERT INTO facts VALUES (1,?)").run(
        JSON.stringify({
          at: Date.parse(at),
          changes: [
            {
              table: "deliveries",
              key: "901:company-feishu",
              row: { card_id: 901, channel: "company-feishu", ref: "om_test", version: 1 },
            },
          ],
        }),
      );
  } finally {
    db.close();
  }
}
test("preview stays off below five successes, displays 200 characters, and waits an hour after delivery across restart", () => {
  for (const count of [4, 5])
    fixture(
      ({ dir, approve, proof, publishes, now, tick, restart, plans }: any) => {
        mkdirSync(join(dir, "publications"), { recursive: true });
        for (let i = 0; i < count; i++) proof(String(i + 1).padStart(32, "0"), "2026-11-06T00:00:00Z");
        now("2026-11-08T02:00:00Z");
        const r = approve(0),
          card = r.ask?.find((a: any) => a.title === "发布预告");
        assert.equal(!!card, count === 5);
        assert.equal(publishes(r).length, 0);
        if (!card) return;
        assert.ok(card.text.includes("文".repeat(200)));
        assert.ok(!card.text.includes("文".repeat(201)));
        assert.match(card.text, /审核标题/);
        assert.match(card.text, /记住/);
        assert.match(card.text, /预计发布时间/);
        now("2026-11-08T04:00:00Z");
        assert.equal(publishes(tick()).length, 0, "unsent card cannot publish");
        deliveredPreview(dir, card.about, "2026-11-08T04:00:00Z");
        restart();
        now("2026-11-08T04:59:59Z");
        assert.equal(publishes(tick()).length, 0);
        assert.equal(plans()[0].publishPreview.publishAt, "2026-11-08T05:00:00.000Z");
        now("2026-11-08T05:00:00Z");
        assert.equal(publishes(tick()).length, 1);
        assert.equal(publishes(tick()).length, 0);
      },
      { publishDailyLimit: 1, publishApproval: { confirmFirst: 5, preview: true } },
    );
});
test("a timely cancellation read from hub facts returns the draft to operations even if callback processing is late", () =>
  fixture(
    ({ dir, approve, proof, tick, now, publishes, plans }: any) => {
      mkdirSync(join(dir, "publications"), { recursive: true });
      for (let i = 0; i < 5; i++) proof(String(i + 1).padStart(32, "0"), "2026-11-06T00:00:00Z");
      now("2026-11-08T02:00:00Z");
      const card = approve(0).ask.find((a: any) => a.title === "发布预告");
      deliveredPreview(dir, card.about, "2026-11-08T02:00:00Z", { at: "2026-11-08T02:59:00Z", choice: 0 });
      now("2026-11-08T03:05:00Z");
      const r = tick();
      assert.equal(publishes(r).length, 0);
      assert.equal(plans()[0].revision, 1);
      assert.equal(plans()[0].publicationKey, undefined);
      assert.match(plans()[0].result, /取消发布/);
      assert.ok(r.events.some((e: any) => JSON.parse(e.detail).kind === "internal-content"));
      assert.equal(publishes(tick([{ card: 901, about: card.about, choice: 0 }])).length, 0);
    },
    { publishDailyLimit: 1, publishApproval: { confirmFirst: 5, preview: true } },
  ));
test("a stale publisher cannot bypass newly enabled preview and the card only shows cancellation", () =>
  fixture(({ dir, c, approve, proof, publishes }: any) => {
    mkdirSync(join(dir, "publications"), { recursive: true });
    for (let i = 0; i < 5; i++) proof(String(i + 1).padStart(32, "0"), "2026-11-06T00:00:00Z");
    const event = publishes(approve(0))[0];
    const receipt = c.process({ events: [{ ...event, id: "dispatch", source: "company-inbox" }], answers: [] });
    const cfg = JSON.parse(readFileSync(join(dir, "company.json"), "utf8"));
    cfg.publishApproval = { confirmFirst: 5, preview: true };
    writeFileSync(join(dir, "company.json"), JSON.stringify(cfg));
    writeFileSync(
      join(dir, "context.json"),
      JSON.stringify({ events: receipt.events.map((e: any) => ({ ...e, source: "company-office" })) }),
    );
    const r = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, "../plugins/company/publish-run.ts"),
        join(dir, "company.json"),
        join(dir, "context.json"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /尚未发送发布预告/);
    const card = interactiveCard({
      id: 1,
      kind: "ask",
      state: "open",
      title: "发布预告",
      text: "预告",
      options: ["取消", "保留安排"],
      choice: null,
      answer: null,
      recommend: null,
      version: 1,
    } as any);
    const buttons = card.body.elements.filter((e: any) => e.tag === "button");
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].text.content, "取消");
  }, {}));

test("business permanent approval still asks after five successes without changing other business policy", () =>
  fixture(
    ({ dir, approve, proof, publishes }: any) => {
      mkdirSync(join(dir, "publications"), { recursive: true });
      for (let i = 0; i < 7; i++) proof(String(i + 1).padStart(32, "0"), "2026-11-06T00:00:00Z");
      const permanent = approve(0);
      assert.equal(publishes(permanent).length, 0);
      assert.ok(permanent.ask.some((a: any) => a.title === "发布确认"));
      assert.equal(publishes(approve(1)).length, 1);
    },
    { publishApproval: { confirmFirst: 5 }, publishPolicies: { jizhu: { dailyLimit: 1, alwaysConfirm: true } } },
  ));
