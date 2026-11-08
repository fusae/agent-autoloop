// Failure modes: credentials escape through errors, unapproved/revised drafts publish, response loss
// causes duplicates, the sixth post bypasses approval, or X jobs lose links and get claimed twice.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import {
  squareRequest,
  squareResult,
  squareBody,
  squarePublish,
  squarePublication,
} from "../plugins/binance-square/publisher.ts";
import { rabbitChannel, rabbitDraft, rabbitText, xReceipt } from "../plugins/company/rabbitrun.ts";
import { rabbitQueue, approvedRabbitRequest } from "../plugins/company/rabbitrun-bridge.ts";
import { publication } from "../plugins/company/publication.ts";
import {
  businessPublishPolicy,
  publicationPreview,
  validatePublishPolicy,
} from "../plugins/company/publication-policy.ts";
import { verifyPublication } from "../plugins/company/verification.ts";
import { initialize, ensureBusinessRules } from "../plugins/company/setup.ts";

const draft = {
  title: "实验记录",
  content: "事实和来源。模拟盘实验，不构成投资建议。",
  images: [] as { mime: string; base64: string }[],
};
const key = "a".repeat(32);
function request(body = draft, id = key) {
  const content = JSON.stringify(body);
  return {
    key: id,
    business: "rabbitrun",
    channel: rabbitChannel,
    action: "publish",
    artifacts: [
      { path: "tasks/post/rabbitrun.json", content, sha256: createHash("sha256").update(content).digest("hex") },
    ],
  };
}
function temporary(fn: (dir: string) => any) {
  const dir = mkdtempSync(join(tmpdir(), "rabbitrun-test-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}
const png = { mime: "image/png", base64: "iVBORw0KGgo=" };

test("Square official request uses one identical text, correct headers, media APIs and validated receipt", async () => {
  const call = squareRequest("offline-test-key", "content/add", squareBody(draft, []));
  assert.equal(call.url, "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add");
  assert.equal(call.options.headers["X-Square-OpenAPI-Key"], "offline-test-key");
  assert.equal(call.options.headers.clienttype, "binanceSkill");
  assert.deepEqual(JSON.parse(call.options.body), { contentType: 1, bodyTextOnly: rabbitText(draft) });
  assert.equal(rabbitText({ ...draft, content: `${draft.title}\n正文` }), `${draft.title}\n正文`);
  assert.throws(() => squareBody({ ...draft, images: [png] }, []));
  assert.throws(() => squareRequest("test", "read", {}));
  assert.throws(() => squareResult({ code: "000000", data: { id: 9007199254740992 } }));
  assert.throws(() => squareResult({ code: "000000", data: { id: "123", shareLink: "https://evil.test/123" } }));
  const calls: any[] = [];
  const fake = async (url: any, options: any) => {
    calls.push({ url: String(url), options });
    if (options.method === "PUT") {
      assert.equal(options.headers["X-Square-OpenAPI-Key"], undefined);
      return new Response("");
    }
    const data = String(url).endsWith("presignedUrl")
      ? { presignedUrl: "https://bucket.s3.amazonaws.com/image", fileTicket: "ticket" }
      : String(url).endsWith("imageStatus")
        ? { status: 1, imageUrl: "https://public.bnbstatic.com/image.png" }
        : { id: "123", shareLink: "https://www.binance.com/zh-CN/square/post/123" };
    return Response.json({ code: "000000", data });
  };
  assert.deepEqual(await squarePublish("offline-test-key", { ...draft, images: [png] }, fake as typeof fetch), {
    remoteId: "123",
    url: "https://www.binance.com/square/post/123",
  });
  assert.equal(calls.length, 4);
  assert.equal(JSON.parse(calls.at(-1).options.body).bodyTextOnly, rabbitText(draft));
  assert.deepEqual(JSON.parse(calls.at(-1).options.body).imageList, ["https://public.bnbstatic.com/image.png"]);
  await assert.rejects(
    () =>
      squarePublish(
        "secret-fixture",
        draft,
        (async () => new Response("secret-fixture", { status: 504 })) as typeof fetch,
      ),
    /币安接口未确认/,
  );
});

test("write intent survives uncertain errors and success replay; daily cap uses Beijing time", () =>
  temporary(async (dir) => {
    let calls = 0;
    const publish = async () => {
      calls++;
      return { remoteId: "123", url: "https://www.binance.com/square/post/123" };
    };
    const now = new Date("2026-11-09T01:00:00Z"),
      req = request();
    assert.equal((await squarePublication(dir, { ...req, action: "lookup" }, publish, now)).state, "absent");
    const first = await squarePublication(dir, req, publish, now);
    assert.equal(first.x.state, "pending");
    assert.deepEqual(await squarePublication(dir, req, publish, now), first);
    assert.equal(calls, 1);
    await assert.rejects(() => squarePublication(dir, request(draft, "b".repeat(32)), publish, now), /每天最多/);
    await assert.rejects(
      () => squarePublication(dir, request({ ...draft, content: "改过的稿" }), publish, now),
      /发生变化/,
    );
    const next = new Date("2026-11-09T16:00:00Z");
    assert.equal(
      (
        await squarePublication(
          dir,
          request(draft, "b".repeat(32)),
          async () => {
            throw Error("secret-fixture");
          },
          next,
        )
      ).state,
      "unknown",
    );
    const replay = await squarePublication(dir, request(draft, "b".repeat(32)), publish, next);
    assert.equal(replay.state, "unknown");
    assert.ok(!JSON.stringify(replay).includes("secret-fixture"));
    assert.equal(calls, 1);
    await assert.rejects(
      () => squarePublication(dir, request(draft, "c".repeat(32)), publish, new Date("2026-11-11")),
      /待核对/,
    );
  }));

function approval(dir: string) {
  mkdirSync(join(dir, "hub"));
  mkdirSync(join(dir, "publications"));
  writeFileSync(join(dir, "publications", key + ".json"), JSON.stringify(request()));
  const db = new DatabaseSync(join(dir, "operations.db"));
  db.exec("CREATE TABLE projects(id TEXT,body TEXT)");
  db.prepare("INSERT INTO projects VALUES (?,?)").run(
    "rabbitrun",
    JSON.stringify({
      plans: [
        {
          publicationKey: key,
          deliveryDecision: "publish",
          publishApproval: { key, state: "approved", card: 1, about: "approved-post" },
        },
      ],
    }),
  );
  db.close();
  const hub = new DatabaseSync(join(dir, "hub/hub.db"));
  hub.exec("CREATE TABLE projections(collection TEXT,data TEXT)");
  hub.prepare("INSERT INTO projections VALUES ('cards',?)").run(
    JSON.stringify({
      id: 1,
      kind: "ask",
      about: "approved-post",
      agent: "company-business",
      grp: "company-business",
      state: "done",
      choice: 0,
    }),
  );
  hub.close();
}
test("X queue requires recorded chairman approval and Binance receipt, claims once and validates account links", () =>
  temporary(async (dir) => {
    approval(dir);
    const state = join(dir, "publisher");
    const req = approvedRabbitRequest(dir, key, "publish");
    const published = await squarePublication(state, req, async () => ({
      remoteId: "123",
      url: "https://www.binance.com/square/post/123",
    }));
    writeFileSync(join(dir, "publications", key + "-result.json"), JSON.stringify(published));
    const queue = rabbitQueue(dir, state, { action: "list" });
    assert.ok(Array.isArray(queue));
    assert.equal(queue.length, 1);
    const claimed = rabbitQueue(dir, state, { action: "claim", key });
    assert.ok(!Array.isArray(claimed));
    assert.equal(claimed.text, rabbitText(draft));
    assert.throws(() => rabbitQueue(dir, state, { action: "claim", key }), /禁止自动重复/);
    assert.throws(() => rabbitQueue(dir, state, { action: "complete", key, url: "https://x.com/other/status/123" }));
    rabbitQueue(dir, state, { action: "fail", key, reason: "verification" });
    assert.throws(() => rabbitQueue(dir, state, { action: "claim", key }));
    rabbitQueue(dir, state, { action: "complete", key, url: "https://x.com/rabbitrun_eth/status/456" });
    const proof = publication(JSON.parse(readFileSync(join(dir, "publications", key + "-result.json"), "utf8")));
    assert.equal(proof.x?.url, "https://x.com/rabbitrun_eth/status/456");
    const empty = rabbitQueue(dir, state, { action: "list" });
    assert.ok(Array.isArray(empty));
    assert.equal(empty.length, 0);
    assert.equal(
      verifyPublication(dir, key, () => {
        throw Error("must not scrape");
      }).state,
      "verified",
    );
    const hub = new DatabaseSync(join(dir, "hub/hub.db"));
    hub.exec("DELETE FROM projections");
    hub.close();
    assert.throws(() => approvedRabbitRequest(dir, key, "publish"), /确认卡/);
  }));

test("per-business guard validates configuration and card includes complete text, both destinations and image count", () =>
  temporary((dir) => {
    approval(dir);
    assert.equal(
      businessPublishPolicy({ publishPolicies: { rabbitrun: { dailyLimit: 1, alwaysConfirm: true } } }, "rabbitrun")
        .alwaysConfirm,
      true,
    );
    assert.equal(businessPublishPolicy({ publishApproval: { confirmFirst: 5 } }, "jizhu").alwaysConfirm, false);
    assert.throws(() =>
      validatePublishPolicy({ publishPolicies: { rabbitrun: { dailyLimit: -1, alwaysConfirm: true } } }),
    );
    const text = publicationPreview(dir, key, "rabbitrun 币圈内容");
    for (const part of [
      draft.title,
      draft.content,
      "图片数：0",
      "X @rabbitrun_eth",
      "币安广场 rabbitrun_eth",
      "每篇均需董事长确认",
    ])
      assert.ok(text.includes(part));
    assert.throws(() => rabbitDraft({ ...request(), business: "jizhu" }));
    assert.throws(() => rabbitDraft({ ...request(), artifacts: [{ ...request().artifacts[0], sha256: "bad" }] }));
    assert.throws(() =>
      xReceipt({
        state: "published",
        attempts: 1,
        at: new Date().toISOString(),
        url: "javascript:bad",
        remoteId: "123",
      }),
    );
  }));

test("trusted prompt preserves crypto disclaimers and survives rule refresh without replacing APP guide", () =>
  temporary((dir) => {
    const home = join(dir, "company");
    initialize(home);
    mkdirSync(join(home, "hub"));
    writeFileSync(join(home, "hub/rules.json"), readFileSync(join(home, "rules.company.json")));
    ensureBusinessRules(home);
    ensureBusinessRules(home);
    const rules = JSON.parse(readFileSync(join(home, "hub/rules.json"), "utf8"));
    for (const role of ["ceo", "growth"]) {
      const prompt = rules.rules.find((r: any) => r.name === `公司部门-${role}`).prompt;
      assert.equal(prompt.split("海外运营规范 v1").length - 1, 1);
      for (const part of [
        "knowledge/crypto-content-guide.md",
        "红线一票否决",
        "每周7篇",
        "永久需要董事长飞书确认",
        "免责声明",
      ])
        assert.ok(prompt.includes(part));
    }
  }));

test("dashboard shows overseas employee, both URLs and pending or failed X without inventing metrics", () => {
  const js = readFileSync(new URL("../plugins/company/dashboard/home.js", import.meta.url), "utf8");
  const esc = (s: any) =>
    String(s ?? "")
      .replaceAll("<", "&lt;")
      .replaceAll('"', "&quot;");
  const context: any = { esc, planNames: {}, Date, Intl };
  runInNewContext(js + "\nthis.render=homePosts;this.staff=homeStaff;", context);
  const proof = {
    key,
    channel: rabbitChannel,
    remoteId: "123",
    url: "https://www.binance.com/square/post/123",
    publishedAt: "2026-11-09T01:00:00Z",
    x: { state: "pending" },
  };
  const data: any = {
    at: proof.publishedAt,
    home: { publications: [proof] },
    businesses: [{ id: "rabbitrun", name: "rabbitrun 币圈内容" }],
  };
  assert.match(context.render(data), /X 待发，需要在 Mac 上执行/);
  proof.x = { state: "published", url: "https://x.com/rabbitrun_eth/status/456" } as any;
  assert.match(context.render(data), /https:\/\/x.com\/rabbitrun_eth\/status\/456/);
  assert.match(
    context.staff(data, [{ p: { business: "rabbitrun" }, s: { name: "海外运营", workStatus: "在岗" } }], {}),
    /海外运营/,
  );
});

test("Mac bridge never claims unattended jobs and retains a confirmed link when SSH fails", async () => {
  const { runMacX, recordMacX } = await import("../plugins/company/rabbitrun-mac.ts");
  await temporary((dir) => {
    const calls: any[] = [];
    const bridge = (input: any) => {
      calls.push(input);
      return [{ key, x: { state: "pending" } }];
    };
    assert.throws(() => runMacX({ state: dir, bridge, interactive: false }), /交互执行/);
    assert.deepEqual(calls, [{ action: "list" }]);
    const input = { action: "complete", key, url: "https://x.com/rabbitrun_eth/status/456" };
    assert.throws(() =>
      recordMacX(input, dir, () => {
        throw Error("offline");
      }),
    );
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "result.json"), "utf8")), input);
    runMacX({ state: dir, bridge, listOnly: true });
    assert.deepEqual(calls[1], input);
  });
});

test("rabbitrun setup registers a separate employee and guide without scheduling or altering APP confirmation", async () => {
  const { setupRabbitrun } = await import("../plugins/company/rabbitrun-setup.ts");
  const { Businesses } = await import("../plugins/company/business.ts");
  const { Operations } = await import("../plugins/company/operations.ts");
  await temporary((dir) => {
    const home = join(dir, "company");
    initialize(home);
    mkdirSync(join(home, "hub"));
    writeFileSync(join(home, "hub/rules.json"), readFileSync(join(home, "rules.company.json")));
    const cfg = JSON.parse(readFileSync(join(home, "company.json"), "utf8"));
    cfg.publishApproval = { confirmFirst: 5, preview: true };
    writeFileSync(join(home, "company.json"), JSON.stringify(cfg));
    writeFileSync(join(home, "workspace/knowledge/content-guide.md"), "既有APP指南");
    setupRabbitrun(home, new Date("2026-11-09T00:00:00Z"));
    setupRabbitrun(home, new Date("2026-11-09T00:00:00Z"));
    const config = JSON.parse(readFileSync(join(home, "company.json"), "utf8"));
    assert.deepEqual(config.publishApproval, cfg.publishApproval);
    assert.equal(config.dailyModelRuns.total, 80);
    assert.equal(config.dailyModelRuns.employee, 20);
    assert.equal(readFileSync(join(home, "workspace/knowledge/content-guide.md"), "utf8"), "既有APP指南");
    const guide = readFileSync(join(home, "workspace/knowledge/crypto-content-guide.md"), "utf8");
    assert.equal(
      createHash("sha256").update(guide.split("### 首篇原文")[0]).digest("hex"),
      "50193b87ed7d30176a49631882966550ae7980cb966253dbd2d8b24a48cdaed9",
    );
    const b = new Businesses(home),
      o = new Operations(home);
    try {
      const projects = o.snapshot(b.list(), [], new Date("2026-11-09T00:00:00Z"));
      assert.equal(projects.length, 1);
      assert.equal(projects[0].staff.filter((s) => s.enabled).length, 1);
      const staff = projects[0].staff.find((s) => s.role === "growth")!;
      assert.equal(staff.name, "海外运营");
      assert.equal(staff.weeklyGoal?.metrics[0].target, 7);
      assert.equal(staff.lastTask, null);
      assert.equal(o.executive().runs.length, 0);
    } finally {
      o.close();
      b.close();
    }
  });
});
