// Failure modes: invalid copy reaches CEO, copied image labels hide changed pixels/text,
// Mandatory product copy or comparison images block unrelated AI stories; contact solicitation bypasses rejection;
// nonexistent stories pass, return loops consume models, or a business override changes other employees.
// Platform guards reject missing/excess tags, offsite contact, unrelated titles and coercion without rejecting normal copy.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  checkJinzhaoDraft,
  checkJinzhaoDelivery,
  attachJinzhaoInputs,
  writingInputs,
} from "../plugins/company/jinzhao-writing.ts";
import { Company, type CompanyConfig } from "../plugins/company/company.ts";
import { initialize, ensureBusinessRules } from "../plugins/company/setup.ts";
import { freezePublication } from "../plugins/company/publication.ts";

const png = Buffer.from("89504e470d0a1a0a0001", "hex");
const digest = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const refs = {
  stories: "### S1 起因\n真实故事\n### S2 做App",
  compare: "## 原文\n\nOriginal.\n\n## App 改写版 A2\n\nI read a book.\n\n## 接口与溯源\n资料",
  images: [{ sha256: digest(png), level: "A2" as const }],
};
const valid = () => ({
  title: "我用AI做了个阅读App",
  content: "写".repeat(310) + "阅读App目前只有安卓版，感兴趣的读者评论区聊。#英语阅读 #英文原著 #生词",
  images: [
    { mime: "image/png", base64: png.toString("base64") },
    { mime: "image/png", base64: png.toString("base64") },
  ],
  stories: ["S1"],
  comparison: { image: 1, level: "A2", rewrite: "I read a book." },
});
test("complete draft passes; exact inclusive body/title limits", () => {
  assert.deepEqual(checkJinzhaoDraft(valid(), refs), []);
  for (const n of [300, 600]) {
    const d = valid();
    d.title = "阅读" + "字".repeat(18);
    d.content = d.content.slice(310).replace(/\s/g, "").padStart(n, "写");
    assert.deepEqual(checkJinzhaoDraft(d, refs), []);
  }
});

test("topic tags require three to five distinct inline topics", () => {
  for (const n of [0, 1, 2, 3, 4, 5, 6]) {
    const d = valid();
    d.content = d.content.replace(/#[\p{L}\p{N}_]+/gu, "") + Array.from({ length: n }, (_, i) => `#话题${i}`).join(" ");
    assert.equal(
      checkJinzhaoDraft(d, refs).some((e) => e.includes("话题标签")),
      n < 3 || n > 5,
    );
  }
  const d = valid();
  d.content = d.content.replace("#生词", "#英语阅读");
  assert.match(checkJinzhaoDraft(d, refs).join(), /话题标签/);
});

test("offsite URLs and contact wording fail while comment invitation remains valid", () => {
  assert.deepEqual(checkJinzhaoDraft(valid(), refs), []);
  for (const contact of [
    "https://example.org",
    "http://example.org",
    "www.example.org",
    "example.dev",
    "ftp://example.org",
    "二维码",
    "微信号",
    "加微信",
    "加V",
    "加 v",
    "加Ｖ",
    "VX",
    "WeChat",
    "QQ",
    "邮箱",
  ]) {
    const d = valid();
    d.content += contact;
    assert.match(checkJinzhaoDraft(d, refs).join(), /外链|站外联系方式/, contact);
  }
});

test("title needs one meaningful overlap in prose; function words and hashtags do not count", () => {
  const d = valid();
  d.title = "我用生词本读英文原著";
  d.content = "写".repeat(310) + "目前只有安卓版，感兴趣的读者评论区聊。#英语阅读 #英文原著 #生词本";
  assert.match(checkJinzhaoDraft(d, refs).join(), /标题核心关键词/);
  d.content += "我今天用了食谱做晚餐。";
  assert.match(checkJinzhaoDraft(d, refs).join(), /标题核心关键词/);
  d.content += "读英文原著遇到困难时，先做一张生词本。";
  assert.deepEqual(checkJinzhaoDraft(d, refs), []);
  d.title = "我的READING记录";
  d.content += "这次reading练习很短。";
  assert.deepEqual(checkJinzhaoDraft(d, refs), []);
});

test("coercive engagement is blocked in title and body; voluntary discussion passes", () => {
  for (const phrase of [
    "不点赞就倒霉",
    "不关注就不给答案",
    "不关注我就看不到",
    "不点赞的人就别想学",
    "不点赞/不关注就亏了",
    "不 点赞 就不给你",
  ]) {
    for (const field of ["title", "content"] as const) {
      const d = valid();
      d[field] += phrase;
      assert.match(checkJinzhaoDraft(d, refs).join(), /胁迫互动/, phrase);
    }
  }
  const d = valid();
  d.content += "不点赞也没关系，你读书时遇到过哪些生词？";
  assert.deepEqual(checkJinzhaoDraft(d, refs), []);
});
for (const [name, change, expected] of [
  ["long title", (d: any) => (d.title = "字".repeat(21)), /20字/],
  ["question", (d: any) => (d.title = "你也想读原版吗"), /纯问句/],
  ["question mark", (d: any) => (d.title = "读原版？"), /纯问句/],
  ["short body", (d: any) => (d.content = "短文"), /300–600/],
  ["long body", (d: any) => (d.content += "字".repeat(600)), /300–600/],
  ["repeated fact", (d: any) => (d.content += "三页，三页，三页。"), /三页.*3次/],
  ["repeated numeric fact", (d: any) => (d.content += "30%，30%，30%。"), /30%.*3次/],
  ["too few images", (d: any) => d.images.pop(), /至少2张/],
  [
    "fake image",
    (d: any) => (d.images[1].base64 = Buffer.from("not an image").toString("base64")),
    /图片必须|对比图必须/,
  ],
  ["changed rewrite", (d: any) => (d.comparison.rewrite = "I read books."), /逐字一致/],
  ["url", (d: any) => (d.content += "https://example.org"), /外链/],
  ["bare url", (d: any) => (d.content += "example.org"), /外链/],
  ["profile", (d: any) => (d.content += "主页简介"), /主页简介/],
  ["version", (d: any) => (d.content += "v1.2.3"), /版本号/],
  ["internal", (d: any) => (d.content += "未实测，不承诺"), /内部用语/],
  ["unknown story", (d: any) => (d.stories = ["S99"]), /故事卡不存在/],
  ["missing story", (d: any) => (d.stories = []), /故事卡编号/],
] as const)
  test(name, () => {
    const d = valid();
    change(d);
    assert.match(checkJinzhaoDraft(d, refs).join("；"), expected);
  });
for (const phrase of [
  "让我想明白",
  "想通了",
  "不是工具，而是改变",
  "换的是书，想的是人",
  "在意的是",
  "给阅读留个位置",
  "比起努力更想睡觉",
])
  test(`blacklist ${phrase}`, () => {
    const d = valid();
    d.content += phrase;
    assert.match(checkJinzhaoDraft(d, refs).join("；"), /AI腔/);
  });

function fixture(fn: (dir: string, config: CompanyConfig, company: Company) => void) {
  const dir = mkdtempSync(join(tmpdir(), "jinzhao-writing-"));
  const config: CompanyConfig = {
    name: "test",
    database: join(dir, "company.db"),
    maxAssignments: 6,
    ceoMode: true,
    contentReview: "ceo",
    jinzhaoWriting: true,
    staffModels: { jinzhao: { growth: { engine: "claude", model: "sonnet" } } },
  };
  mkdirSync(join(dir, "workspace/tasks/write"), { recursive: true });
  mkdirSync(join(dir, "workspace/knowledge/assets/jinzhao-compare"), { recursive: true });
  writeFileSync(join(dir, "company.json"), JSON.stringify(config));
  writeFileSync(
    join(dir, "jinzhao-writing-assets.json"),
    JSON.stringify({ compareSha256: digest(refs.compare), images: refs.images }),
  );
  writeFileSync(join(dir, "workspace/knowledge/assets/jinzhao-compare/compare.md"), refs.compare);
  for (const name of writingInputs)
    writeFileSync(
      join(dir, "workspace/knowledge", name),
      name === "recent-posts.md"
        ? "# 最近发布正文\n"
        : name.includes("compare.md")
          ? refs.compare
          : name.includes("stories")
            ? refs.stories
            : "参考资料",
    );
  const db = new DatabaseSync(join(dir, "operations.db"));
  db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY,body TEXT NOT NULL)");
  db.prepare("INSERT INTO projects VALUES (?,?)").run(
    "jinzhao",
    JSON.stringify({
      business: "jinzhao",
      activity: [],
      plans: [{ id: "plan", task: "write", kind: "content", operation: "write" }],
    }),
  );
  db.close();
  const c = new Company(config);
  try {
    fn(dir, config, c);
  } finally {
    c.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("program return goes straight to writer once, replay is idempotent, passing draft reaches CEO then freezes", () =>
  fixture((dir, config, c) => {
    const send = (id: number, source: string, type: string, data: object) =>
      c.process({ events: [{ id, source, type, subject: "write", detail: JSON.stringify(data) }], answers: [] });
    const started = send(1, "company-inbox", "company.task.create", {
      title: "稿件",
      kind: "internal-content",
      goal: "写稿",
      acceptance: ["完整图文"],
    });
    assert.equal(started.events?.[0].type, "company.work.growth.jinzhao");
    const path = "tasks/write/xiaohongshu.json";
    writeFileSync(join(dir, "workspace", path), JSON.stringify({ ...valid(), title: "纯问句？" }));
    const report = { assignment: 1, verdict: "pass", summary: "稿件完成", artifacts: [path], evidence: ["已自查"] };
    const returned = send(2, "company-growth", "company.result", report);
    assert.equal(c.task("write")?.status, "active");
    assert.equal(returned.events?.[0].type, "company.work.growth.jinzhao");
    assert.match(returned.events![0].detail, /纯问句/);
    send(2, "company-growth", "company.result", report);
    assert.equal(c.task("write")?.assignment, 2);
    writeFileSync(join(dir, "workspace", path), JSON.stringify(valid()));
    send(3, "company-growth", "company.result", { ...report, assignment: 2 });
    assert.equal(c.task("write")?.status, "completed");
    assert.equal(c.task("write")?.reports.length, 2);
    assert.match(freezePublication(dir, "jinzhao", "plan", c.task("write")!), /^[a-f0-9]{32}$/);
    writeFileSync(join(dir, "workspace", path), JSON.stringify({ ...valid(), stories: ["S99"] }));
    assert.throws(() => freezePublication(dir, "jinzhao", "plan", c.task("write")!), /程序检查未通过/);
  }));

test("second failure stops automatic returns and keeps concrete reasons", () =>
  fixture((dir, config, c) => {
    const send = (id: number, source: string, type: string, data: object) =>
      c.process({ events: [{ id, source, type, subject: "write", detail: JSON.stringify(data) }], answers: [] });
    send(1, "company-inbox", "company.task.create", {
      title: "稿件",
      kind: "staff-growth",
      goal: "写稿",
      acceptance: ["完整图文"],
    });
    const path = "tasks/write/xiaohongshu.json";
    writeFileSync(join(dir, "workspace", path), JSON.stringify({ ...valid(), title: "纯问句？" }));
    for (const n of [1, 2])
      send(n + 1, "company-growth", "company.result", {
        assignment: n,
        verdict: "pass",
        summary: "完成",
        artifacts: [path],
        evidence: ["自查"],
      });
    assert.equal(c.task("write")?.status, "blocked");
    assert.equal(c.task("write")?.assignment, 2);
    assert.match(c.task("write")!.reason, /纯问句/);
  }));

test("fixed inputs are in context; forged reference and outside artifact fail closed", () =>
  fixture((dir) => {
    const contextFile = join(dir, "context.json");
    writeFileSync(contextFile, '{"events":[]}');
    const context = attachJinzhaoInputs({ cwd: join(dir, "workspace"), contextFile } as any);
    assert.deepEqual(Object.keys(context.jinzhaoWriting), writingInputs);
    assert.equal(context.jinzhaoWriting["xhs-platform-rules.md"], "参考资料");
    const file = "tasks/write/xiaohongshu.json";
    writeFileSync(join(dir, "workspace", file), JSON.stringify(valid()));
    assert.deepEqual(checkJinzhaoDelivery(dir, [file]), []);
    writeFileSync(join(dir, "workspace/knowledge/assets/jinzhao-compare/compare.md"), "forged");
    assert.match(checkJinzhaoDelivery(dir, [file]).join(), /已核对版本/);
    writeFileSync(join(dir, "xiaohongshu.json"), JSON.stringify(valid()));
    assert.match(checkJinzhaoDelivery(dir, [join(dir, "xiaohongshu.json")]).join(), /工作区内/);
  }));

test("business model rule keeps default employees, shared lane and result source, and upgrades idempotently", () => {
  const root = mkdtempSync(join(tmpdir(), "jinzhao-routing-"));
  const dir = join(root, "company");
  try {
    const rules = initialize(dir);
    mkdirSync(join(dir, "hub"));
    writeFileSync(join(dir, "hub/rules.json"), JSON.stringify(rules));
    const config = JSON.parse(readFileSync(join(dir, "company.json"), "utf8"));
    Object.assign(config, {
      dailyModelRuns: { total: 20 },
      jinzhaoWriting: true,
      staffModels: { jinzhao: { growth: { engine: "claude", model: "sonnet" } } },
    });
    writeFileSync(join(dir, "company.json"), JSON.stringify(config));
    ensureBusinessRules(dir);
    const next = JSON.parse(readFileSync(join(dir, "hub/rules.json"), "utf8"));
    assert.equal(next.agents["company-growth"].command[3], "codex");
    assert.equal(next.agents["company-staff-jinzhao-growth"].command[3], "claude");
    assert.equal(next.agents["company-staff-jinzhao-growth"].model, "sonnet");
    const rule = next.rules.find((r: any) => r.to === "company-staff-jinzhao-growth");
    const base = next.rules.find((r: any) => r.name === "公司部门-growth");
    assert.equal(rule.group, base.group);
    assert.deepEqual(rule.emits, base.emits);
    assert.match(rule.prompt, /今朝一次交付规范/);
    assert.match(rule.prompt, /写稿前必读knowledge\/xhs-platform-rules.md/);
    ensureBusinessRules(dir);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "hub/rules.json"), "utf8")), next);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AI stories pass without product acquisition wording or comparison images", () => {
  const draft: any = valid();
  draft.content = draft.content.replace("目前只有安卓版，感兴趣的读者评论区聊", "帮我解决了实际麻烦");
  delete draft.comparison;
  assert.deepEqual(checkJinzhaoDraft(draft, { stories: refs.stories, compare: "", images: [] }), []);
});

for (const phrase of ["私我", "私信", "私聊", "加我", "加V", "加v", "微信"])
  test(`contact solicitation is rejected in title and body: ${phrase}`, () => {
    for (const field of ["title", "content"] as const) {
      const draft = valid();
      draft[field] += phrase;
      assert.match(checkJinzhaoDraft(draft, refs).join(), /不得出现导流用语/, `${field}: ${phrase}`);
    }
  });

// Full-body comparison is mandatory both on delivery and on the later freeze boundary.
test("real duplicate fails delivery and freeze even with a different title and claimed new angle", () =>
  fixture((dir) => {
    const copies = JSON.parse(readFileSync(new URL("./fixtures/content-dedup.json", import.meta.url), "utf8"));
    const file = "tasks/write/xiaohongshu.json";
    writeFileSync(
      join(dir, "workspace", file),
      JSON.stringify({ ...valid(), ...copies.withdrawn, angle: "版权全新角度" }),
    );
    writeFileSync(
      join(dir, "workspace/knowledge/recent-posts.md"),
      "# 最近发布正文\n\n<!-- post " +
        JSON.stringify({
          id: "manual",
          title: copies.manual.title,
          publishedAt: "2026-11-11T11:24:33Z",
          origin: "董事长手动",
        }) +
        " -->\n" +
        copies.manual.content
          .split("\n")
          .map((s: string) => "> " + s)
          .join("\n"),
    );
    assert.match(checkJinzhaoDelivery(dir, [file]).join(), /与《做了个英语阅读的app》（2026-11-11）重复/);
    assert.throws(
      () => freezePublication(dir, "jinzhao", "plan", { reports: [{ artifacts: [file] }] } as any),
      /重合点/,
    );
    rmSync(join(dir, "workspace/knowledge/recent-posts.md"));
    assert.match(checkJinzhaoDelivery(dir, [file]).join(), /recent-posts/);
  }));
