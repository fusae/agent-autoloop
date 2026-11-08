// Failure modes: highlighted user text injects HTML, the page limit is bypassed, themes drift,
// or the CLI accepts an old screenshot after the browser failed to render a fresh image.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { renderCards, pickTheme, themes } from "../plugins/xiaohongshu/cards.ts";

test("highlight escapes HTML in covers and body pages", () => {
  const pages = renderCards({
    title: "通勤【<script>\"&'</script>】",
    pages: ["【<img src=x onerror=alert(1)>】\n第二行"],
  });
  assert.equal(pages.length, 2);
  assert.match(pages[0], /<span class="mark">&lt;script&gt;&quot;&amp;&#39;&lt;\/script&gt;<\/span>/);
  assert.match(pages[1], /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(pages[1], /<br>第二行/);
  for (const html of pages) assert.doesNotMatch(html, /<script>|<img /);
});
test("nine cards are allowed but ten are rejected; themes stay deterministic", () => {
  assert.equal(renderCards({ title: "标题", pages: Array(8).fill("正文") }).length, 9);
  assert.throws(() => renderCards({ title: "标题", pages: Array(9).fill("正文") }), /最多 9 张/);
  assert.throws(() => renderCards({ title: " " }), /缺少标题/);
  const spec = { title: "通勤阅读" };
  const first = renderCards(spec);
  renderCards({ title: "其他稿件" });
  assert.deepEqual(renderCards(spec), first);
  assert.equal(pickTheme("通勤阅读"), "paper");
  for (const theme of Object.keys(themes) as (keyof typeof themes)[])
    assert.ok(renderCards({ ...spec, theme })[0].includes(`background:${themes[theme].bg}`));
});
test("cards CLI does not report success using an existing PNG", () => {
  const dir = mkdtempSync(join(tmpdir(), "cards-cli-"));
  try {
    const spec = join(dir, "spec.json"),
      png = join(dir, "card-1.png");
    writeFileSync(spec, JSON.stringify({ title: "测试" }));
    writeFileSync(png, Buffer.alloc(2000));
    const r = spawnSync(process.execPath, ["plugins/xiaohongshu/manage.ts", "cards", spec, dir], {
      encoding: "utf8",
      env: { ...process.env, XHS_CARDS_BROWSER: "/usr/bin/true" },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /配图渲染失败/);
    assert.equal(existsSync(png), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fixed renderer accepts only text specs and returns images through files without sandbox network", async () => {
  const { requestCards, cardSpec } = await import("../plugins/xiaohongshu/cards-renderer.ts");
  const { serveCards } = await import("../plugins/xiaohongshu/cards-service.ts");
  const { readdirSync, symlinkSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "cards-service-"));
  const png = Buffer.alloc(1001);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png);
  png.writeUInt32BE(1080, 16);
  png.writeUInt32BE(1440, 20);
  let calls = 0;
  const timer = setInterval(
    () =>
      serveCards(dir, () => {
        calls++;
        return [png];
      }),
    10,
  );
  try {
    const result = await requestCards({ title: "沙箱【文字】" }, dir, 1000);
    assert.deepEqual(result, [png]);
    assert.equal(calls, 1);
    assert.deepEqual(readdirSync(dir), []);
    assert.throws(() => cardSpec({ title: "注入", command: "id" }), /格式不正确/);
    assert.throws(() => cardSpec({ title: "注入", theme: "constructor" }), /格式不正确/);
    assert.throws(() => cardSpec({ title: "注入", pages: [42] }), /格式不正确/);
    symlinkSync("/etc/passwd", join(dir, "a".repeat(36) + ".json"));
    serveCards(dir, () => {
      throw Error("must not render a symlink");
    });
    assert.equal(calls, 1);
    const errorFile = join(dir, "a".repeat(36) + ".result.json");
    assert.ok(existsSync(errorFile));
  } finally {
    clearInterval(timer);
    rmSync(dir, { recursive: true, force: true });
  }
});
