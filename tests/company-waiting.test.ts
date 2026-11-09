// Failure modes: missing, closed, or cross-business dependencies block employees; legacy prose invents owner approval.
import assert from "node:assert/strict";
import { test } from "node:test";
import { waitingReason } from "../plugins/company/waiting.ts";
import type { Leadership } from "../plugins/company/executive.ts";
test("owner waits require a real open question linked to this business", () => {
  const c = {
    questions: [{ id: "q", state: "open", issues: ["i"] }],
    issues: [{ id: "i", business: "app", state: "owner" }],
  } as Leadership;
  const daily = {
    mode: "standby" as const,
    focus: "等负责人答复",
    doneWhen: "继续",
    waiting: { kind: "owner" as const, id: "q" },
  };
  assert.equal(waitingReason(daily, "app", c, []), undefined);
  assert.ok(waitingReason(daily, "other", c, []));
  assert.ok(waitingReason({ ...daily, waiting: { kind: "owner", id: "missing" } }, "app", c, []));
  c.questions[0].state = "answered";
  assert.ok(waitingReason(daily, "app", c, []));
  c.questions[0].state = "open";
  c.issues[0].state = "answered";
  assert.ok(waitingReason(daily, "app", c, []));
  assert.ok(waitingReason({ ...daily, waiting: undefined }, "app", c, []));
});
test("completed and nonexistent plan waits clear; ordinary standby is preserved", () => {
  const c = { questions: [], issues: [] } as unknown as Leadership;
  const daily = {
    mode: "standby" as const,
    focus: "等待素材",
    doneWhen: "素材到达",
    waiting: { kind: "plan" as const, id: "p" },
  };
  assert.equal(waitingReason(daily, "app", c, [{ id: "p", status: "working" }]), undefined);
  for (const status of ["closed", "delivered", "observing"] as const)
    assert.ok(waitingReason(daily, "app", c, [{ id: "p", status }]));
  assert.ok(waitingReason(daily, "app", c, []));
  assert.equal(waitingReason({ ...daily, waiting: undefined, focus: "暂无新反馈" }, "app", c, []), undefined);
});
