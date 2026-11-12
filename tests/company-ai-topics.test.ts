// Failure modes: empty or stale stories dispatch writers, CEO bypasses owner choice, replay writes twice,
// rejected topics recur, search failures hammer the browser, or a draft uses another story.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Company } from "../plugins/company/company.ts";
import { Operations } from "../plugins/company/operations.ts";
import { Businesses } from "../plugins/company/business.ts";
import { parseStories } from "../plugins/company/ai-stories.ts";
import { storyProposals, collectTopicEvidence } from "../plugins/company/ai-topics.ts";
import { checkJinzhaoDelivery } from "../plugins/company/jinzhao-writing.ts";
import { interactiveCard } from "../plugins/company/channel.ts";
import { chairmanNotice, pipelineSuppresses } from "../plugins/company/delegation.ts";
import { parseResult } from "../protocol/validate.ts";
const story = (n: number) =>
  `### S${n} 测试故事${n}\n- 发生时间：2026-11-01\n- 麻烦：测试麻烦${n}\n- 让 AI 怎么做：整理记录\n- 结果/数字：找到了原始记录\n- 踩坑：无\n- 可用证据：本地记录${n}\n`;
async function fixture(run: (f: any) => Promise<void> | void, count = 6) {
  const dir = mkdtempSync(join(tmpdir(), "ai-topics-"));
  const config = {
    name: "测试",
    database: join(dir, "company.db"),
    maxAssignments: 6,
    pipelineMode: true,
    jinzhaoWriting: true,
    ceoMode: true,
    aiStoryTopics: { searchCommand: ["fake"] },
    delegation: { source: "测试" },
  };
  mkdirSync(join(dir, "workspace/knowledge"), { recursive: true });
  writeFileSync(join(dir, "company.json"), JSON.stringify(config));
  writeFileSync(
    join(dir, "workspace/knowledge/ai-stories.md"),
    Array.from({ length: count }, (_, i) => story(i + 1)).join("\n"),
  );
  writeFileSync(join(dir, "workspace/knowledge/recent-posts.md"), "# 最近发布正文\n");
  const c = new Company(config),
    o = new Operations(dir),
    b = new Businesses(dir);
  b.save({
    id: "jinzhao",
    name: "今朝",
    description: "测试",
    audience: "普通人",
    objective: "故事",
    stage: "operating",
  });
  b.autonomy("jinzhao", true);
  b.status("jinzhao", "active");
  let seq = 0;
  const tick = (date = "2026-11-13T09:30:00+08:00", answers: any[] = []) => {
    const r = o.plan(`tick-${++seq}`, b.list(), c.tasks(), new Date(date), answers);
    parseResult({ outcome: "done", ...r });
    return r;
  };
  const project = () => o.snapshot(b.list(), c.tasks())[0];
  const accept = (r: any) => {
    for (const e of r.events ?? []) c.process({ events: [{ ...e, id: ++seq, source: "company-inbox" }], answers: [] });
  };
  const propose = (indices = [1, 2, 3]) => {
    const batch = project().aiTopicBatches!.at(-1)!;
    c.process({
      events: [
        {
          id: ++seq,
          source: "company-growth",
          type: "company.result",
          subject: batch.task,
          detail: JSON.stringify({
            assignment: 1,
            verdict: "pass",
            summary: "已报选题",
            artifacts: [],
            evidence: ["故事卡"],
            aiTopics: indices.map((n) => ({
              title: `AI整理记录${n}`,
              story: `S${n}`,
              hook: "找记录的麻烦终于解决",
              keyword: "AI 整理记录",
            })),
          }),
        },
      ],
      answers: [],
    });
    assert.equal(c.task(batch.task)?.status, "completed", c.task(batch.task)?.reason ?? "");
    return batch;
  };
  const evidence = async (statuses = ["有平台证据", "无平台证据", "有平台证据"]) => {
    let calls = 0;
    const waits: number[] = [];
    await collectTopicEvidence(
      dir,
      [project()],
      c.tasks(),
      ["fake"],
      new Date("2026-11-13T10:00:00+08:00"),
      async () => ({
        status: statuses[calls++] as any,
        notes: [{ title: "同类例子", likes: 150, url: "https://www.xiaohongshu.com/explore/" + "a".repeat(24) }],
      }),
      async (ms: number) => {
        waits.push(ms);
      },
    );
    return { calls, waits };
  };
  try {
    await run({ dir, config, c, o, b, tick, project, accept, propose, evidence });
  } finally {
    c.close();
    o.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
test("placeholder and incomplete cards are not stories; duplicate IDs fail closed", () => {
  assert.equal(
    parseStories(readFileSync(new URL("../examples/recipes/company/ai-stories.md", import.meta.url), "utf8")).length,
    0,
  );
  assert.equal(parseStories(story(1)).length, 1);
  assert.equal(parseStories(story(1).replace("结果/数字：找到了原始记录", "结果/数字：待填")).length, 0);
  assert.throws(() => parseStories(story(1) + story(1)), /重复/);
});
test("under three stories consumes no model or card; weekday 09:30 dispatches only a topic task", async () => {
  await fixture((f) => {
    assert.equal(f.tick().events, undefined);
    assert.equal(f.project().aiTopicStatus, "素材不足");
  }, 2);
  await fixture((f) => {
    assert.equal(f.tick("2026-11-13T09:29:00+08:00").events, undefined);
    const r = f.tick();
    assert.equal(r.events?.length, 1);
    assert.match(r.events[0].summary, /每日选题/);
    assert.equal(r.ask, undefined);
    assert.equal(f.project().plans.length, 0);
    const profile = JSON.parse(readFileSync(join(f.dir, "workspace/knowledge/operations/jinzhao.json"), "utf8"));
    assert.equal(profile.aiTopicBatches.length, 1);
    assert.equal(f.tick().events, undefined);
  });
  await fixture((f) => assert.equal(f.tick("2026-11-14T10:00:00+08:00").events, undefined));
});
test("three evidence-backed choices wait without reminders, only one selected story writes and replay does nothing", () =>
  fixture(async (f) => {
    f.accept(f.tick());
    const batch = f.propose();
    assert.deepEqual(await f.evidence(), { calls: 3, waits: [5500, 5500] });
    assert.equal((await f.evidence()).calls, 0);
    const r = f.tick("2026-11-13T10:05:00+08:00");
    const ask = r.ask[0];
    assert.equal(ask.title, "今朝选题");
    assert.equal(ask.options.length, 4);
    assert.match(ask.text, /150赞/);
    assert.deepEqual(
      f.project().aiTopicBatches[0].proposals.map((p: any) => p.story),
      ["S1", "S3", "S2"],
    );
    assert.equal(f.tick("2026-11-13T14:00:00+08:00").ask, undefined);
    assert.equal(f.project().plans.length, 0);
    assert.equal(chairmanNotice(ask.title), true);
    assert.equal(pipelineSuppresses(f.dir, { ...ask, kind: "ask" }), false);
    const card = interactiveCard({ ...ask, id: 42, version: 1, kind: "ask", state: "open", choice: null } as any);
    const encoded = JSON.stringify(card);
    assert.match(encoded, /同类例子/);
    assert.doesNotMatch(encoded, /collapsible_panel|submit_reply/);
    const answer = { card: 42, about: ask.about, choice: 1, text: "说清楚踩坑", at: "2026-11-13T06:00:00Z" };
    const chosen = f.tick("2026-11-13T14:01:00+08:00", [answer]);
    assert.equal(chosen.events.length, 1);
    assert.match(chosen.events[0].detail, /S3/);
    assert.equal(f.project().plans.length, 1);
    assert.equal(f.project().plans[0].topic, batch.id);
    assert.equal(f.tick("2026-11-13T14:02:00+08:00", [answer]).events, undefined);
    assert.throws(
      () =>
        storyProposals(
          [
            { title: "a", story: "S99", hook: "b", keyword: "c" },
            { title: "a", story: "S2", hook: "b", keyword: "c" },
            { title: "a", story: "S3", hook: "b", keyword: "c" },
          ],
          batch,
          f.dir,
        ),
      /故事卡/,
    );
  }));
test("reject-all carries opinion and excludes rejected stories; failed search never retries", () =>
  fixture(async (f) => {
    f.accept(f.tick());
    f.propose();
    assert.equal((await f.evidence(["证据获取失败"])).calls, 1);
    assert.equal((await f.evidence()).calls, 0);
    const ask = f.tick("2026-11-13T10:00:00+08:00").ask[0];
    assert.match(ask.text, /证据获取失败/);
    const r = f.tick("2026-11-13T10:01:00+08:00", [{ card: 1, about: ask.about, choice: 3, text: "换生活类麻烦" }]);
    assert.equal(r.events.length, 1);
    assert.match(r.events[0].detail, /换生活类麻烦/);
    assert.equal(f.project().plans.length, 0);
    assert.deepEqual(
      f.project().aiTopicBatches[1].candidates.map((s: any) => s.id),
      ["S4", "S5", "S6"],
    );
  }));
test("late selection cannot dispatch yesterday's story; changed story cannot be approved", async () => {
  await fixture(async (f) => {
    f.accept(f.tick());
    f.propose();
    await f.evidence();
    const ask = f.tick("2026-11-13T10:00:00+08:00").ask[0];
    const r = f.tick("2026-11-14T10:00:00+08:00", [{ card: 1, about: ask.about, choice: 0 }]);
    assert.equal(r.events, undefined);
    assert.equal(r.ask, undefined);
    assert.equal(f.project().plans.length, 0);
  });
  await fixture(async (f) => {
    f.accept(f.tick());
    f.propose();
    await f.evidence();
    const ask = f.tick("2026-11-13T10:00:00+08:00").ask[0];
    writeFileSync(join(f.dir, "workspace/knowledge/ai-stories.md"), story(1).replace("整理记录", "改过素材"));
    assert.equal(f.tick("2026-11-13T10:01:00+08:00", [{ card: 1, about: ask.about, choice: 0 }]).events, undefined);
  });
});
test("delivery rejects a valid but unselected story, preserves selected source through freeze checks", () =>
  fixture(async (f) => {
    f.accept(f.tick());
    f.propose();
    await f.evidence();
    const ask = f.tick("2026-11-13T10:00:00+08:00").ask[0];
    f.tick("2026-11-13T10:01:00+08:00", [{ card: 1, about: ask.about, choice: 0 }]);
    const task = f.project().plans[0].task,
      path = `tasks/${task}/xiaohongshu.json`;
    mkdirSync(join(f.dir, "workspace/tasks", task), { recursive: true });
    const png = Buffer.from("89504e470d0a1a0a0001", "hex").toString("base64");
    const draft = {
      title: "整理记录",
      content: "整理记录".repeat(80) + "#AI #记录 #生活",
      stories: ["S2"],
      images: [
        { mime: "image/png", base64: png },
        { mime: "image/png", base64: png },
      ],
    };
    writeFileSync(join(f.dir, "workspace", path), JSON.stringify(draft));
    assert.match(checkJinzhaoDelivery(f.dir, [path], task).join(), /选中的故事卡/);
    draft.stories = ["S1"];
    writeFileSync(join(f.dir, "workspace", path), JSON.stringify(draft));
    assert.deepEqual(checkJinzhaoDelivery(f.dir, [path], task), []);
    assert.match(checkJinzhaoDelivery(f.dir, [path], "another-task").join(), /选中的故事卡/);
  }));
