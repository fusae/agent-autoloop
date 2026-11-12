// Failure modes: renamed/rephrased manual posts pass checks, boilerplate rejects a new angle,
// embedded Markdown truncates stored bodies, or callers can bypass body comparison with self-reported differences.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentFacts, duplicateDetails, checkContentDuplicates } from "../plugins/company/content-dedup.ts";
import { writeRecentPosts, readRecentPosts } from "../plugins/company/recent-posts.ts";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/content-dedup.json", import.meta.url), "utf8"));
const previous = (post: { title: string; content: string }) => ({
  ...post,
  id: "test",
  publishedAt: "2026-11-11T11:24:33Z",
  origin: "董事长手动" as const,
});
test("real withdrawn copyright draft duplicates the chairman's full manual post", () => {
  const result = duplicateDetails(fixtures.withdrawn.content, fixtures.manual.content);
  assert.equal(result.factsDuplicate, true);
  assert.match(
    checkContentDuplicates(fixtures.withdrawn.content, [previous(fixtures.manual)])[0],
    /与《做了个英语阅读的app》（2026-11-11）重复：重合点/,
  );
  assert.ok(result.overlap.includes("书名：血字的研究"));
  assert.ok(result.overlap.includes("数字：30%"));
});
test("real simplified Sherlock post and a distinct book-import angle are not duplicates", () => {
  assert.equal(duplicateDetails(fixtures.different.content, fixtures.sherlock.content).duplicate, false);
  assert.equal(duplicateDetails(fixtures.different.content, fixtures.manual.content).duplicate, false);
});
test("character n-grams catch copied prose with no known product facts", () => {
  const text =
    "窗外的雨声盖住了键盘声。我把桌上的纸摊开，逐行圈出需要修改的地方，然后给每一段换了顺序。忙完的时候天已经黑了，剩下的工作留到明天再继续。";
  const d = duplicateDetails(text.replace("键盘", "脚步").replace("明天", "周末"), text);
  assert.equal(d.factsDuplicate, false);
  assert.equal(d.textDuplicate, true);
  assert.match(checkContentDuplicates(text, [previous({ title: "雨天整理", content: text })])[0], /4-gram/);
});
test("shared book names, tags and acquisition copy alone do not reject a different angle", () => {
  const end = "目前只有安卓版，感兴趣的读者评论区聊。#英语阅读 #英文原著 #AI工具";
  assert.equal(
    duplicateDetails(
      "《福尔摩斯》导入 EPUB 后，章节乱码来自目录编码。" + end,
      "《福尔摩斯》的音频跟读可以练习发音，晚上听书十分钟。" + end,
    ).duplicate,
    false,
  );
  assert.ok(contentFacts("已经读到三成左右").has("数字：30%"));
  assert.ok(contentFacts("已读 30％").has("数字：30%"));
});
test("recent Markdown preserves full hostile-looking text, deduplicates IDs and sorts actual publication time", () => {
  const dir = mkdtempSync(join(tmpdir(), "recent-posts-"));
  try {
    const notes = Array.from({ length: 12 }, (_, i) => ({
      id: String(i),
      title: "标题" + i,
      content: `正文${i}\n\n## 伪造标题\n<!-- post {} -->\n> 原文引用\n尾部全文`,
      author: "owner",
      images: 1,
      publishedAt: new Date(Date.UTC(2026, 10, i + 1)).toISOString(),
      likes: 0,
      collects: 0,
      comments: 0,
    }));
    writeRecentPosts(dir, [notes[0], ...notes.slice().reverse()], new Set(["11"]), "2026-11-12T10:00:00Z");
    const posts = readRecentPosts(dir);
    assert.equal(posts.length, 10);
    assert.equal(posts[0].id, "11");
    assert.equal(posts[0].origin, "系统");
    assert.equal(posts[1].origin, "董事长手动");
    assert.equal(posts[0].content, notes[11].content);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Pipeline comparisons must use actual publication dates, not when the collector first noticed a pinned post.
test("pipeline takes its recent comparison list from full-text knowledge", async () => {
  const { recentPipelinePosts } = await import("../plugins/company/pipeline.ts");
  const dir = mkdtempSync(join(tmpdir(), "recent-pipeline-"));
  try {
    writeRecentPosts(
      dir,
      [
        {
          id: "a".repeat(24),
          title: "手动全文",
          content: "确切正文",
          publishedAt: "2026-11-11T11:24:33Z",
          author: "owner",
          images: 0,
          likes: 0,
          collects: 0,
          comments: 0,
        },
      ],
      new Set(),
      "2026-11-12T02:00:00Z",
    );
    assert.deepEqual(recentPipelinePosts(dir, "jinzhao"), [
      {
        publication: "manual:" + "a".repeat(24),
        title: "手动全文",
        platform: "小红书",
        at: "2026-11-11T11:24:33Z",
        fields: [],
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
