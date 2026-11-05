// Failure modes: unapproved files or model-supplied commands are published, a retry duplicates
// a post, or a local draft / unverified API response is reported as a live publication.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executePublication, freezePublication } from "../plugins/company/publication.ts";
import type { Task } from "../plugins/company/company.ts";

test("publishing uses frozen approved content, checks the platform and does not publish again on replay", () => {
  const dir = mkdtempSync(join(tmpdir(), "company-publish-"));
  try {
    mkdirSync(join(dir, "workspace/tasks/draft"), { recursive: true });
    const path = "tasks/draft/post.md";
    writeFileSync(join(dir, "workspace", path), "审核通过的正文");
    const task = { id: "draft", assignment: 2, reports: [{ artifacts: [path] }] } as Task;
    const key = freezePublication(dir, "app", "plan", task);
    assert.throws(() => executePublication(dir, key), /发布渠道和账号/);
    writeFileSync(join(dir, "workspace", path), "未经审核的修改");
    const script = join(dir, "fake-platform.mjs");
    writeFileSync(
      script,
      `import fs from 'node:fs';
      let text=''; for await (const chunk of process.stdin) text += chunk;
      const input=JSON.parse(text), file='fake-platform-state.json';
      if (input.action === 'publish') {
        if (input.artifacts[0].content !== '审核通过的正文') process.exit(2);
        if (fs.existsSync(file)) process.exit(3);
        fs.writeFileSync(file, JSON.stringify({state:'published',key:input.key,channel:input.channel,remoteId:'post-1',url:'https://example.com/post-1',publishedAt:'2026-11-05T16:00:00Z'}));
        console.log('{}');
      } else console.log(fs.existsSync(file) ? fs.readFileSync(file,'utf8') : '{"state":"absent"}');`,
    );
    writeFileSync(
      join(dir, "publishing.json"),
      JSON.stringify({ projects: { app: { channel: "测试平台", command: [process.execPath, script] } } }),
    );
    const proof = executePublication(dir, key);
    assert.equal(proof.url, "https://example.com/post-1");
    assert.deepEqual(executePublication(dir, key), proof);
    // Losing the local success cache must still reconcile by the stable platform key before a write.
    rmSync(join(dir, "publications", key + "-result.json"));
    assert.deepEqual(executePublication(dir, key), proof);
    assert.equal(JSON.parse(readFileSync(join(dir, "fake-platform-state.json"), "utf8")).remoteId, "post-1");
    writeFileSync(script, "console.log(JSON.stringify({state:'unknown'}))");
    rmSync(join(dir, "publications", key + "-result.json"));
    assert.throws(() => executePublication(dir, key), /尚未确认发布成功/);
    symlinkSync(join(dir, "publishing.json"), join(dir, "workspace/tasks/draft/escape.json"));
    assert.throws(
      () =>
        freezePublication(dir, "app", "other", {
          ...task,
          reports: [{ artifacts: ["tasks/draft/escape.json"] }],
        } as Task),
      /公司工作区/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
