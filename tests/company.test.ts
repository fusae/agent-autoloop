// Failure modes: departments forge each other's results, stale results advance a newer task, a crash loses the next
// dispatch, QA is bypassed, an arbitrary answer approves delivery, or the dispatch budget starts extra paid work.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Company, type Context, type CompanyConfig } from "../plugins/company/company.ts";
import { makeRules, ensureBusinessRules } from "../plugins/company/setup.ts";
import { parseRules } from "../protocol/rules.ts";
import { parseResult } from "../protocol/validate.ts";

const config = (dir: string): CompanyConfig => ({
  name: "测试公司",
  database: join(dir, "company.db"),
  maxAssignments: 3,
});
const context = (source: string, type: string, subject: string, data: unknown, id: number): Context => ({
  events: [{ id, source, type, subject, detail: JSON.stringify(data) }],
  answers: [],
});
const request = { title: "交付日报", goal: "生成可核验的日报", kind: "software", acceptance: ["有测试证据"] };
const report = (assignment: number, verdict = "pass") => ({
  assignment,
  verdict,
  summary: "已完成",
  artifacts: ["tasks/T1/report.md"],
  evidence: ["测试通过"],
});
function withCompany(fn: (office: Company, cfg: CompanyConfig) => void, limit = 3) {
  const dir = mkdtempSync(join(tmpdir(), "company-test-"));
  const cfg = { ...config(dir), maxAssignments: limit };
  const office = new Company(cfg);
  try {
    fn(office, cfg);
  } finally {
    office.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("product → engineering → QA → owner approval, with durable replay and protocol-valid receipts", () =>
  withCompany((office, cfg) => {
    const first = context("company-inbox", "company.task.create", "T1", request, 1);
    const receipt = office.process(first);
    assert.equal(receipt.events?.[0].type, "company.work.product");
    const reopened = new Company(cfg);
    try {
      assert.deepEqual(reopened.process(first), receipt);
    } finally {
      reopened.close();
    }
    for (const [role, assignment, next] of [
      ["product", 1, "engineering"],
      ["engineering", 2, "qa"],
    ] as const) {
      const output = office.process(
        context(`company-${role}`, "company.result", "T1", report(assignment), assignment + 1),
      );
      assert.equal(output.events?.[0].type, `company.work.${next}`);
      parseResult({ outcome: "done", ...output });
    }
    const approval = office.process(context("company-qa", "company.result", "T1", report(3), 4));
    parseResult({ outcome: "done", ...approval });
    assert.equal(office.task("T1")?.status, "awaiting_approval");
    assert.equal(approval.ask?.length, 1);
    office.process({ events: [], answers: [{ card: 7, choice: 0, about: "forged" }] });
    assert.equal(office.task("T1")?.status, "awaiting_approval");
    office.process({ events: [], answers: [{ card: 8, choice: 0, about: approval.ask![0].about }] });
    assert.equal(office.task("T1")?.status, "completed");
    assert.equal(office.history("T1").length, 5);
  }));

test("wrong role, stale assignment, missing evidence and external approval text cannot advance work", () =>
  withCompany((office) => {
    office.process(context("company-inbox", "company.task.create", "T1", request, 1));
    for (const [source, data, id] of [
      ["company-engineering", report(1), 2],
      ["company-product", report(99), 3],
      ["company-product", { ...report(1), evidence: [] }, 4],
      ["company-inbox", { ...report(1), approved: true }, 5],
    ] as const) {
      assert.ok(office.process(context(source, "company.result", "T1", data, id)).notice?.length);
      assert.equal(office.task("T1")?.assignment, 1);
    }
  }));

test("QA rejection blocks the task and only an explicit inbox retry can dispatch again", () =>
  withCompany((office) => {
    office.process(context("company-inbox", "company.task.create", "T1", request, 1));
    office.process(context("company-product", "company.result", "T1", report(1), 2));
    office.process(context("company-engineering", "company.result", "T1", report(2), 3));
    office.process(context("company-qa", "company.result", "T1", report(3, "reject"), 4));
    assert.equal(office.task("T1")?.status, "blocked");
    assert.equal(office.process(context("company-qa", "company.task.retry", "T1", {}, 5)).events?.length ?? 0, 0);
    const retry = office.process(context("company-inbox", "company.task.retry", "T1", {}, 6));
    assert.equal(retry.events?.[0].type, "company.work.engineering");
    assert.equal(office.task("T1")?.assignment, 4);
  }, 6));

test("assignment cap persists across retries and keeps work blocked", () =>
  withCompany((office) => {
    office.process(context("company-inbox", "company.task.create", "T1", request, 1));
    const output = office.process(context("company-product", "company.result", "T1", report(1), 2));
    assert.equal(output.events?.length ?? 0, 0);
    assert.equal(office.task("T1")?.status, "blocked");
    office.process(context("company-inbox", "company.task.retry", "T1", {}, 3));
    assert.equal(office.task("T1")?.assignment, 1);
  }, 1));

test("generated rules isolate report sources, share the coordinator group and retain conservative access", () => {
  const rules = parseRules(JSON.stringify(makeRules("/tmp/company", "local", "codex")), Date.now(), "Asia/Shanghai");
  assert.equal(rules.agents["company-office"].use, "company");
  assert.equal(rules.agents["company-qa"].access, "read");
  assert.ok(Object.values(rules.agents).every((a) => a.access !== "full"));
  assert.equal(rules.rules.find((r) => r.to === "company-product")?.emits?.source, "company-product");
});

// Removing content QA must not bypass software QA or strand a previously dispatched content review.
test("CEO content review preserves software QA and accepts an already dispatched legacy QA result", () =>
  withCompany((office, cfg) => {
    cfg.ceoMode = true;
    office.process(
      context("company-inbox", "company.task.create", "draft", { ...request, kind: "internal-content" }, 1),
    );
    assert.equal(
      office.process(context("company-growth", "company.result", "draft", report(1), 2)).events?.[0].type,
      "company.work.qa",
    );
    cfg.contentReview = "ceo";
    office.process(context("company-qa", "company.result", "draft", report(2), 3));
    assert.equal(office.task("draft")?.status, "completed");
    office.process(
      context("company-inbox", "company.task.create", "software", { ...request, kind: "internal-software" }, 4),
    );
    office.process(context("company-product", "company.result", "software", report(1), 5));
    const next = office.process(context("company-engineering", "company.result", "software", report(2), 6));
    assert.equal(next.events?.[0].type, "company.work.qa");
    assert.equal(office.task("software")?.status, "active");
  }, 6));

test("explicit lean content configuration updates CEO and staff rules once while preserving customization", () => {
  const dir = mkdtempSync(join(tmpdir(), "company-lean-"));
  try {
    mkdirSync(join(dir, "hub"));
    mkdirSync(join(dir, "workspace/handbook"), { recursive: true });
    writeFileSync(join(dir, "workspace/handbook/growth.md"), "自定义运营职责\n");
    writeFileSync(join(dir, "company.json"), JSON.stringify({ ceoMode: true, contentReview: "ceo" }));
    writeFileSync(join(dir, "hub/rules.json"), JSON.stringify(makeRules(dir, "local", "codex")));
    ensureBusinessRules(dir);
    const text = readFileSync(join(dir, "hub/rules.json"), "utf8");
    const rules = JSON.parse(text).rules;
    for (const name of ["公司部门-growth", "公司部门-ceo", "公司部门-qa", "CEO · 业务答复"])
      assert.match(rules.find((r: any) => r.name === name).prompt, /精简推广流程 v2/);
    const book = readFileSync(join(dir, "workspace/handbook/growth.md"), "utf8");
    assert.ok(book.startsWith("自定义运营职责"));
    assert.match(book, /负责人本人发布/);
    ensureBusinessRules(dir);
    assert.equal(readFileSync(join(dir, "hub/rules.json"), "utf8"), text);
    assert.equal(readFileSync(join(dir, "workspace/handbook/growth.md"), "utf8"), book);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid current reports pause for repair instead of leaving an active task that cannot retry", () =>
  withCompany((office) => {
    office.process(context("company-inbox", "company.task.create", "T1", request, 1));
    office.process(context("company-product", "company.result", "T1", { ...report(1), evidence: [] }, 2));
    assert.equal(office.task("T1")?.status, "blocked");
    const output = office.process(context("company-inbox", "company.task.retry", "T1", {}, 3));
    assert.equal(output.events?.[0].type, "company.work.product");
  }));

test("a changed snapshot of the same input batch replays the persisted receipt", () =>
  withCompany((office) => {
    const original = context("company-inbox", "company.task.create", "T1", request, 1);
    const receipt = office.process(original);
    assert.deepEqual(office.process({ ...original, open: [{ card: 99 }] } as Context), receipt);
    assert.equal(office.task("T1")?.assignment, 1);
  }));

test("free-text approval cannot leave a closed card attached to a permanently waiting task", () =>
  withCompany((office) => {
    office.process(context("company-inbox", "company.task.create", "T1", { ...request, kind: "content" }, 1));
    office.process(context("company-growth", "company.result", "T1", report(1), 2));
    const receipt = office.process(context("company-qa", "company.result", "T1", report(2), 3));
    office.process({ events: [], answers: [{ card: 10, choice: null, about: receipt.ask![0].about }] });
    assert.equal(office.task("T1")?.status, "rejected");
  }));

// Upgrading runtime recovery must preserve owner customization and avoid blocking staff behind read-only management.
test("company upgrades preserve custom prompts and timeouts and isolate the CEO management group", () => {
  const dir = mkdtempSync(join(tmpdir(), "company-upgrade-"));
  try {
    mkdirSync(join(dir, "hub"));
    const rules = makeRules(dir, "local", "codex") as any;
    for (const r of rules.rules.filter((r: any) => r.name.startsWith("公司部门-"))) {
      r.prompt = "自定义岗位要求";
      r.group = "company-work";
    }
    rules.agents["company-growth"].timeout = 17;
    writeFileSync(join(dir, "hub/rules.json"), JSON.stringify(rules));
    ensureBusinessRules(dir);
    const file = readFileSync(join(dir, "hub/rules.json"), "utf8");
    const updated = JSON.parse(file);
    assert.ok(
      updated.rules
        .filter((r: any) => r.name.startsWith("公司部门-"))
        .every((r: any) => r.prompt.startsWith("自定义岗位要求") && r.prompt.includes("持续经营协议 v3")),
    );
    assert.equal(updated.agents["company-growth"].timeout, 17);
    assert.equal(updated.rules.find((r: any) => r.to === "company-ceo").group, "company-management");
    assert.equal(updated.rules.find((r: any) => r.to === "company-growth").group, "company-work");
    ensureBusinessRules(dir);
    assert.equal(readFileSync(join(dir, "hub/rules.json"), "utf8"), file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
