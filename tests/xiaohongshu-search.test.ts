// Failure modes: search performs writes, omits rate limits, retries failures, leaks tokens, or invents missing likes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { searchNotes, searchXhs } from "../plugins/xiaohongshu/search.ts";
const feed = (id: string, likedCount: unknown) => ({
  id: id.repeat(24),
  xsecToken: "private-token",
  noteCard: { displayTitle: "同类故事", interactInfo: { likedCount } },
});
test("only high-like public note fields survive, malformed and duplicate entries cannot create evidence", () => {
  const raw = {
    feeds: [feed("a", "1.2万"), feed("b", "209"), feed("b", "209"), feed("c", "99"), feed("d", undefined)],
  };
  const result = searchNotes(raw);
  assert.equal(result.status, "有平台证据");
  assert.deepEqual(
    result.notes.map((n) => n.likes),
    [12000, 209],
  );
  assert.doesNotMatch(JSON.stringify(result), /private-token|xsecToken/);
  assert.equal(searchNotes({ feeds: [feed("a", "100")] }).status, "无平台证据");
  assert.throws(() => searchNotes({}), /搜索列表/);
});
test("server enforces five-second spacing and daily 15 total across restarts; failures count without retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "xhs-search-")),
    dir = join(root, "reader");
  const config = { endpoint: "http://127.0.0.1:18060", token: "test" };
  const request = { action: "search", keyword: "AI 整理" };
  let calls = 0;
  const call = async (path: string, body?: unknown) => {
    calls++;
    assert.equal(body, undefined);
    assert.match(path, /^\/api\/v1\/feeds\/search\?keyword=/);
    throw Error("failed");
  };
  const start = Date.parse("2026-11-13T09:30:00+08:00");
  try {
    for (let i = 0; i < 15; i++) {
      assert.equal((await searchXhs(config, dir, request, call, new Date(start + i * 5500))).status, "证据获取失败");
      await searchXhs(config, dir, request, call, new Date(start + i * 5500 + 100));
    }
    assert.equal(calls, 15);
    await searchXhs(config, dir, request, call, new Date(start + 100000));
    assert.equal(calls, 15);
    await searchXhs(config, dir, request, call, new Date(start + 86400000));
    assert.equal(calls, 16);
    await assert.rejects(searchXhs(config, dir, { ...request, action: "like" }, call), /只允许/);
    await assert.rejects(searchXhs(config, dir, { ...request, url: "https://example.org" }, call), /只允许/);
    assert.equal(calls, 16);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
