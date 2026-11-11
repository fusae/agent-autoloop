// Failure modes: bursts run one model per event, cooldown drops new evidence, maintenance wakes a CEO,
// cosmetic receipt errors trigger more models, or locally repaired output widens a decision's authority.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ceoWake, type CEOWakeState } from "../plugins/company/ceo-wake.ts";
import { proactiveDue } from "../plugins/company/proactive.ts";
import { ceoActionable, reconcileHealth, type HealthFinding } from "../plugins/company/health.ts";
import { repairCEOText } from "../plugins/company/ceo-receipt.ts";
import agent from "../plugins/company/agent.ts";
import { resultFrom, readMessage } from "../worker/contract.ts";
const at = (minutes: number) => new Date(Date.parse("2026-11-11T02:00:00Z") + minutes * 60_000);
const decision = (extra = {}) => ({
  briefs: [],
  directives: [],
  approvals: [],
  answers: [],
  escalations: [],
  ...extra,
});
test("five-minute burst preserves all types across restart and dispatches once", () => {
  let state: CEOWakeState = {};
  assert.equal(ceoWake(state, "delivery-a", at(0), ["company.result"]), false);
  assert.equal(ceoWake(state, "delivery-a+answer", at(2), ["card.answered"]), false);
  state = JSON.parse(JSON.stringify(state));
  assert.equal(ceoWake(state, "delivery-a+answer+health", at(4), ["health"]), false);
  assert.equal(ceoWake(state, "delivery-a+answer+health", at(5)), true);
  assert.deepEqual(state.record?.types, ["card.answered", "company.result", "health"]);
  assert.equal(ceoWake(state, "delivery-a+answer+health", at(10)), false);
  assert.equal(ceoWake(state, "new-delivery", at(10), ["company.result"]), false);
  assert.equal(ceoWake(state, "new-delivery", at(15)), true);
});
test("one proactive slot per day includes Monday strategy and never adds an afternoon round", () => {
  assert.equal(proactiveDue(new Date("2026-11-09T01:00:00Z"), [], undefined, "09:00", true), "strategy");
  assert.equal(proactiveDue(at(30), [], undefined, "09:00", true), "review");
  for (const time of [at(30), at(330)])
    assert.equal(proactiveDue(time, [{ date: "2026-11-11", kind: "review" }], undefined, "09:00", true), undefined);
});
test("reminders and known maintenance remain recorded without waking; new actionable facts still wake", () => {
  const finding = (kind: string): HealthFinding => ({
    id: kind,
    kind,
    title: kind,
    impact: "test",
    evidence: "new",
    suggestion: "test",
    severity: 1,
  });
  const status = [
    finding("quota"),
    { ...finding("topics"), reminderOnly: true },
    finding("publish-failed"),
    finding("auth"),
  ];
  const quiet = reconcileHealth(undefined, status, at(0), true);
  assert.equal(quiet.pending, false);
  assert.equal(quiet.incidents.length, 4);
  const active = reconcileHealth(quiet, [...status, finding("missing-goal")], at(5), true);
  assert.equal(active.pending, true);
  assert.equal(
    ceoActionable({
      ...finding("missing-goal"),
      firstAt: at(0).toISOString(),
      lastAt: at(5).toISOString(),
      actions: [{ at: at(0).toISOString(), action: "observe", result: "known maintenance" }],
    }),
    false,
  );
});
test("bare JSON, missing empty arrays and long reasons are fixed without changing identifiers or decisions", () => {
  const input = {
    assignment: 2,
    verdict: "pass",
    summary: "完成",
    artifacts: [],
    evidence: ["账本"],
    executive: { approvals: [{ business: "app", plan: "plan", approve: true, reason: "理".repeat(500) }] },
  };
  const fixed = repairCEOText(JSON.stringify(input), { task: "CEO-test", assignment: 2 });
  const parsed = resultFrom(readMessage(fixed), {});
  assert.equal(parsed.problem, undefined);
  const d = JSON.parse(parsed.result.events![0].detail!);
  assert.equal(d.executive.approvals[0].reason.length, 200);
  assert.equal(d.executive.approvals[0].approve, true);
  assert.deepEqual(d.executive.briefs, []);
  input.executive.approvals[0].plan = "x".repeat(41);
  assert.throws(() => repairCEOText(JSON.stringify(input), { task: "CEO-test", assignment: 2 }), /超过长度/);
});
test("unrepairable decisions are recorded as blocked without worker receipt repair or fabricated authority", () => {
  const body = {
    events: [
      {
        id: "ceo",
        type: "company.result",
        subject: "CEO-test",
        detail: JSON.stringify({
          assignment: 2,
          verdict: "pass",
          summary: "完成",
          evidence: ["资料"],
          executive: decision({ approvals: [{ business: "app", plan: "p", approve: "true", reason: "test" }] }),
        }),
      },
    ],
  };
  const output =
    JSON.stringify({ companyModel: "claude", ceoEfficiency: true, companyWork: { task: "CEO-test", assignment: 2 } }) +
    "\n" +
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: `完成\n\n\`\`\`agent-autoloop\n${JSON.stringify(body)}\n\`\`\``,
    });
  const reading = agent.read(output, 0, "");
  assert.equal(reading.receiptProblem, undefined);
  const parsed = resultFrom(readMessage(reading.text!), {});
  assert.equal(parsed.problem, undefined);
  const report = JSON.parse(parsed.result.events![0].detail!);
  assert.equal(report.verdict, "blocked");
  assert.deepEqual(report.executive.approvals, []);
  assert.match(report.summary, /回执需维护/);
});

test("deferred owner messages and answers survive restart and combine with new evidence without duplicates", async () => {
  const { mkdtempSync, rmSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { deferCEOOwner, restoreCEOOwner } = await import("../plugins/company/ceo-owner-queue.ts");
  const dir = mkdtempSync(join(tmpdir(), "ceo-owner-queue-"));
  try {
    const event = { source: "company-inbox", id: 1, type: "company.owner.question", detail: "原话" };
    const answer = { card: 5, choice: 0 };
    const receipt = deferCEOOwner(dir, { events: [event], answers: [answer] }, at(0));
    assert.match(receipt.later[0].at, /^2026-11-12T01:05/);
    const restored = restoreCEOOwner(dir, { events: [event, { ...event, id: 2 }], answers: [], timers: receipt.later });
    assert.equal(restored.events.length, 2);
    assert.deepEqual(restored.answers, [answer]);
    assert.match(readFileSync(join(dir, "ceo-deferred", receipt.later[0].key + ".json"), "utf8"), /原话/);
    const twice = deferCEOOwner(dir, { events: [event], answers: [answer] }, at(2));
    assert.equal(twice.later[0].key, receipt.later[0].key);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a handled anomaly wakes again when its evidence changes, while reminders remain recorded", () => {
  const finding: HealthFinding = {
    id: "issue",
    kind: "invalid-wait",
    title: "等待无效",
    impact: "test",
    evidence: "first",
    suggestion: "test",
    severity: 1,
  };
  let state = reconcileHealth(undefined, [finding], at(0), true);
  state.incidents[0].actions.push({ at: at(0).toISOString(), action: "observe", result: "maintenance" });
  state.incidents[0].handledEvidence = "first";
  state.pending = false;
  assert.equal(ceoActionable(state.incidents[0]), false);
  state = reconcileHealth(state, [{ ...finding, evidence: "new fact" }], at(5), true);
  assert.equal(ceoActionable(state.incidents[0]), true);
});

test("owner questions retain pure notices; an example JSON fence cannot replace the actual receipt", () => {
  const notice = { notice: [{ key: "answer", title: "答复", text: "已记录" }] };
  const fixed = repairCEOText("```json\n{}\n```\n```agent-autoloop\n" + JSON.stringify(notice) + "\n```");
  assert.equal(resultFrom(readMessage(fixed), {}).problem, undefined);
  assert.match(fixed, /已记录/);
});

test("CEO daily cap reserves one report, includes owner chat, and never grants a second report launch", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const { ModelBudget } = await import("../plugins/company/model-budget.ts");
  const dir = mkdtempSync(join(tmpdir(), "ceo-cap-"));
  try {
    const db = new DatabaseSync(join(dir, "operations.db"));
    db.exec("CREATE TABLE leadership(id TEXT PRIMARY KEY, body TEXT)");
    db.prepare("INSERT INTO leadership VALUES (?,?)").run(
      "company",
      JSON.stringify({ eveningReports: [{ task: "REPORT", date: "2026-11-11" }] }),
    );
    db.close();
    const budget = new ModelBudget(dir, {
      name: "test",
      database: join(dir, "company.db"),
      maxAssignments: 6,
      ceoEfficiency: true,
      reporting: { enabled: true },
    });
    try {
      for (let i = 0; i < 14; i++) assert.equal(budget.start("ceo", `normal:${i}`, i % 2 === 0, at(0)), true);
      assert.equal(budget.start("ceo", "owner-over", true, at(1)), false);
      assert.equal(budget.start("ceo", "report", false, at(1), "REPORT"), true);
      assert.equal(budget.start("ceo", "report-retry", false, at(2), "REPORT"), false);
      assert.equal(budget.snapshot(at(2)).roles.ceo, 15);
      assert.equal(budget.start("ceo", "tomorrow", false, new Date("2026-11-12T02:00:00Z")), true);
    } finally {
      budget.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
