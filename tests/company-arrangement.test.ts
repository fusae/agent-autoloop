// Failure modes: owner cards repeat stale questions, hide who owns the work, leak internal
// instructions into the main view, or render all projects as one wall of text.
import assert from "node:assert/strict";
import { test } from "node:test";
import { arrangementText, ARRANGEMENT_DETAILS } from "../plugins/company/arrangement.ts";
import { interactiveCard } from "../plugins/company/channel.ts";
const plan = (id: string) =>
  ({
    id,
    key: id,
    title: "推广图文草稿",
    owner: "growth",
    dueAt: "2026-11-08T01:49:38Z",
    status: "planned",
    result: "补齐配图",
  }) as any;
const decision: any = {
  briefs: [
    { business: "a", objective: "重复目标".repeat(50) },
    { business: "b", objective: "重复目标".repeat(50) },
  ],
  directives: [],
  approvals: [],
  deliveries: [
    { business: "a", plan: "one", verdict: "revise", reason: "只交草稿，由本人发布。" },
    { business: "b", plan: "two", verdict: "revise", reason: "只交草稿，由本人发布。" },
  ],
  ownerReplies: [{ question: "old", event: 1 }],
  answers: [],
  escalations: [],
};
const projects = [
  { id: "a", name: "记住 APP", plans: [plan("one")] },
  { id: "b", name: "英语阅读", plans: [plan("two")] },
];
test("daily arrangements show concrete work and keep goals and acceptance in collapsed detail", () => {
  const text = arrangementText(
    "今日安排",
    {
      briefs: [],
      directives: [],
      approvals: [],
      answers: [],
      escalations: [],
      staffPlans: [
        {
          business: "a",
          role: "growth",
          date: "2026-11-06",
          goal: "持续推广",
          focus: "完成还书提醒封面",
          doneWhen: "标题正文封面齐全",
          mode: "followup",
          reviewAt: "2026-11-06T09:00:00Z",
        },
      ],
    },
    projects,
    [],
  );
  const [main, detail] = text.split(ARRANGEMENT_DETAILS);
  assert.match(main, /运营：完成还书提醒封面/);
  assert.match(main, /17:00/);
  assert.doesNotMatch(main, /完成标准/);
  assert.match(detail, /完成标准：标题正文封面齐全/);
});
test("arrangements lead with short project sections and put rationale in details", () => {
  const text = arrangementText("员工准备草稿，负责人发布", decision, projects, []);
  const [main, detail] = text.split(ARRANGEMENT_DETAILS);
  assert.ok(main.length < 360);
  assert.match(main, /记住 APP/);
  assert.match(main, /英语阅读/);
  assert.match(main, /运营/);
  assert.match(main, /11月08日 09:49/);
  assert.match(main, /修改交付/);
  assert.doesNotMatch(main, /重复目标|旧问题|答复已记录/);
  assert.match(detail, /只交草稿/);
  assert.ok(text.length <= 4000);
  const card = interactiveCard({
    kind: "notice",
    state: "open",
    title: "CEO · 工作安排",
    text,
    options: [],
    choice: null,
  } as any);
  const visible = card.body.elements.filter((e: any) => e.tag !== "collapsible_panel");
  assert.ok(visible.length >= 2);
  assert.ok(JSON.stringify(visible).length < 1300);
  const panel = card.body.elements.find((e: any) => e.tag === "collapsible_panel");
  assert.equal(panel.expanded, false);
  assert.match(JSON.stringify(panel), /只交草稿/);
});
test("changed plans appear once; pending decisions stay visible without inventing deadlines", () => {
  const d = {
    ...decision,
    deliveries: [decision.deliveries[0]],
    approvals: [{ business: "a", plan: "one", approve: true }],
    briefs: [],
    ownerReplies: [],
    escalations: [{ question: "是否增加预算？" }],
  };
  const text = arrangementText("", d, projects, []);
  const main = text.split(ARRANGEMENT_DETAILS)[0];
  assert.equal(main.match(/推广图文草稿/g)?.length, 1);
  assert.match(main, /需要你决定：1 项/);
  const only = arrangementText(
    "已处理员工问题",
    {
      ...d,
      deliveries: [],
      approvals: [],
      escalations: [],
      answers: [{ issue: "i", answer: "使用现有资料", evidence: "资料" }],
    },
    projects,
    [{ id: "i", business: "a", role: "growth" }] as any,
  );
  assert.doesNotMatch(only.split(ARRANGEMENT_DETAILS)[0], /截止/);
  assert.match(only, /员工问题/);
});
