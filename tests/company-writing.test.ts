// Failure modes: old wording survives an upgrade, repeated upgrades duplicate contracts, or publication
// cards truncate text, upload different images, lose previews on update, or fail delivery with an upload.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureBusinessRules, initialize } from "../plugins/company/setup.ts";
import { CompanyFeishu } from "../plugins/company/channel.ts";
import { publicationPreview } from "../plugins/company/publication-policy.ts";

test("v1 contracts are replaced in rules and handbooks without changing custom instructions", () => {
  const root = mkdtempSync(join(tmpdir(), "writing-rules-")),
    dir = join(root, "company");
  try {
    const rules = initialize(dir);
    const old =
      "精简推广流程 v1：旧要求；未实际保存进小红书草稿箱就说明是待导入的文件草稿；发布后的记录和效果跟进也由运营负责，不再转产品协调或 QA 核对。";
    for (const rule of rules.rules)
      if (rule.to === "company-growth" || rule.to === "company-ceo")
        rule.prompt =
          "自定义要求保留\n" +
          rule.prompt.replace(/精简推广流程 v2：[\s\S]*?原计划退回运营，不代改稿、不直接放行。/, old);
    mkdirSync(join(dir, "hub"));
    writeFileSync(join(dir, "hub/rules.json"), JSON.stringify(rules));
    writeFileSync(
      join(dir, "company.json"),
      JSON.stringify({
        ceoMode: true,
        contentReview: "ceo",
        dailyPlanning: true,
        publishApproval: { confirmFirst: 5 },
      }),
    );
    for (const role of ["growth", "ceo"])
      writeFileSync(join(dir, `workspace/handbook/${role}.md`), "自定义要求保留\n" + old);
    ensureBusinessRules(dir);
    const paths = ["hub/rules.json", "workspace/handbook/growth.md", "workspace/handbook/ceo.md"];
    const before = paths.map((p) => readFileSync(join(dir, p), "utf8"));
    const prompts = JSON.parse(before[0])
      .rules.filter((r: any) => ["company-growth", "company-ceo"].includes(r.to))
      .map((r: any) => r.prompt)
      .concat(before.slice(1));
    for (const prompt of prompts) {
      assert.match(prompt, /自定义要求保留/);
      assert.doesNotMatch(prompt, /精简推广流程 v1|旧要求|就说明是待导入/);
      assert.equal(prompt.split("精简推广流程 v2").length, 2);
      assert.match(prompt, /第一人称、自然口语/);
      assert.match(prompt, /只写在 handoff\/facts/);
      assert.match(prompt, /必须 deliveries.verdict=revise/);
      assert.match(prompt, /knowledge\/content-guide\.md/);
      assert.match(prompt, /manual 董事长手动帖/);
      assert.match(prompt, /最近10篇已发帖/);
      assert.match(prompt, /manage.ts cards/);
      assert.match(prompt, /禁止 imagegen/);
      assert.match(prompt, /第五节8项清单逐条审/);
      assert.match(prompt, /是否符合账号人设、App 推广是否克制/);
      assert.match(prompt, /每三篇最多一篇以 App 为主角/);
      assert.match(prompt, /旧备稿在下次审核时同样执行/);
    }
    ensureBusinessRules(dir);
    assert.deepEqual(
      paths.map((p) => readFileSync(join(dir, p), "utf8")),
      before,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const failure of ["none", "partial", "all", "missing", "tampered"])
  test(`full frozen publication card: ${failure}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "writing-card-")),
      key = "a".repeat(32),
      calls: string[][] = [],
      uploaded: Buffer[] = [];
    try {
      mkdirSync(join(dir, "publications"));
      const images = [Buffer.from("89504e470d0a1a0a01", "hex"), Buffer.from("89504e470d0a1a0a02", "hex")];
      const draft = {
        title: "我做的APP",
        content: "我为什么做它\n\n" + "完整正文".repeat(180) + "<b>末尾</b>",
        images: images.map((b) => ({ mime: "image/png", base64: b.toString("base64") })),
      };
      const content = JSON.stringify(draft);
      const path = join(dir, "publications", key + ".json");
      writeFileSync(
        path,
        JSON.stringify({
          key,
          artifacts: [
            { path: "tasks/T/xiaohongshu.json", content, sha256: createHash("sha256").update(content).digest("hex") },
          ],
        }),
      );
      const text = publicationPreview(dir, key, "记住 APP");
      assert.ok(text.includes(draft.content));
      if (failure === "missing") rmSync(path);
      if (failure === "tampered")
        writeFileSync(path, readFileSync(path, "utf8").replace("我为什么做它", "未经审核改动"));
      const card: any = {
        id: 42,
        version: 1,
        kind: "ask",
        state: "open",
        title: "发布确认",
        text,
        options: ["发布", "退回修改", "暂缓"],
        choice: null,
        answer: null,
        result: null,
        ref: null,
        recommend: null,
      };
      const delivered: any[] = [];
      const hub: any = { delivered: async (...args: any[]) => delivered.push(args) };
      const lark = async (args: string[], cwd?: string) => {
        calls.push(args);
        if (args[1] === "images") {
          assert.equal(args[args.indexOf("--as") + 1], "bot");
          const data = JSON.parse(args[args.indexOf("--data") + 1]);
          assert.equal(data.image_type, "message");
          const file = args[args.indexOf("--file") + 1];
          assert.ok(file.startsWith("image="));
          assert.ok(cwd);
          assert.match(file, /^image=\d+\.png$/);
          uploaded.push(readFileSync(join(cwd!, file.slice("image=".length))));
          if (failure === "all" || (failure === "partial" && uploaded.length === 1)) throw Error("upload failed");
          return { data: { image_key: "img_test_" + uploaded.length } };
        }
        return { data: { message_id: "om_test" } };
      };
      const file = join(dir, "feishu-state.json");
      let bridge = new CompanyFeishu(file, "ou_owner", hub, lark, undefined, true);
      await bridge.deliver(card);
      const send = calls.find((c) => c[1] === "+messages-send")!;
      const rendered = JSON.parse(send[send.indexOf("--content") + 1]);
      const els = rendered.body.elements;
      assert.ok(els.some((e: any) => e.text?.tag === "plain_text" && e.text.content.includes(draft.content)));
      assert.ok(!JSON.stringify(rendered).includes("发布稿件："));
      assert.deepEqual(
        els.filter((e: any) => e.tag === "img").map((e: any) => e.img_key),
        failure === "none" ? ["img_test_1", "img_test_2"] : failure === "partial" ? ["img_test_2"] : [],
      );
      assert.equal(JSON.stringify(rendered).includes("图片未能加载，共 2 张"), failure !== "none");
      if (!["missing", "tampered"].includes(failure)) assert.deepEqual(uploaded, images);
      assert.ok(!readdirSync(dir).some((n) => n.startsWith(".card-images-")));
      if (failure === "none") {
        const legacy = JSON.parse(readFileSync(file, "utf8"));
        delete legacy.cards[42].publicationMedia.version;
        writeFileSync(file, JSON.stringify(legacy));
      }
      bridge = new CompanyFeishu(file, "ou_owner", hub, lark, undefined, true);
      await bridge.deliver(card);
      await bridge.deliver({ ...card, version: 2, state: "decided", choice: 1 });
      assert.equal(calls.filter((c) => c[1] === "+messages-send").length, 1);
      assert.equal(uploaded.length, ["missing", "tampered"].includes(failure) ? 0 : failure === "none" ? 4 : 2);
      assert.equal(delivered.length, 3);
      assert.ok(calls.some((c) => c[1] === "PATCH"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
