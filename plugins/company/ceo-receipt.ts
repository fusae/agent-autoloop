import { schemas } from "../../protocol/schema.ts";
import { permissions } from "./workday.ts";
import { executiveDecision } from "./executive.ts";

type Schema = {
  type: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  maxLength?: number;
  maxItems?: number;
  minimum?: number;
  additionalProperties?: boolean;
};
const text = (maxLength: number): Schema => ({ type: "string", maxLength });
const id = text(40),
  integer: Schema = { type: "integer", minimum: 0 },
  bool: Schema = { type: "boolean" };
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const list = (items: Schema, maxItems: number): Schema => ({ type: "array", items, maxItems });
const choice = (...values: string[]): Schema => ({ type: "string", enum: values });
const action = object(
  {
    key: id,
    topic: id,
    operation: choice(...Object.values(permissions).flat()),
    title: text(80),
    kind: choice("software", "content", "support", "finance"),
    goal: text(240),
    acceptance: list(text(100), 3),
    priority: integer,
    dueDays: integer,
    followUpDays: integer,
    measure: text(120),
  },
  ["key", "title", "kind", "goal", "acceptance", "priority", "dueDays", "followUpDays", "measure"],
);
export const ceoDecisionSchema: Schema = object(
  {
    briefs: list(object({ business: id, objective: text(300) }), 5),
    directives: list(object({ business: id, action }), 3),
    approvals: list(object({ business: id, plan: id, approve: bool, reason: text(200) }), 6),
    answers: list(object({ issue: id, answer: text(700), evidence: text(200) }), 5),
    escalations: list(
      object(
        {
          key: text(80),
          business: id,
          issues: list(id, 8),
          question: text(800),
          context: text(400),
          options: list(text(40), 5),
          category: choice("maintenance", "spend", "identity"),
        },
        ["key", "issues", "question", "context"],
      ),
      2,
    ),
    report: text(1800),
    deliveries: list(
      object(
        {
          business: id,
          plan: id,
          task: id,
          reviewVersion: text(64),
          verdict: choice("revise", "accept", "publish"),
          files: list(text(150), 5),
          reason: text(200),
        },
        ["business", "plan", "task", "verdict", "reason"],
      ),
      6,
    ),
    topicReviews: list(
      object({ business: id, topic: id, approve: bool, rank: integer, score: integer, reason: text(160) }, [
        "business",
        "topic",
        "approve",
        "rank",
        "reason",
      ]),
      30,
    ),
    topicReplies: list(object({ business: id, batch: id, event: integer }), 10),
    topicDecisions: list(
      object(
        {
          business: id,
          batch: id,
          source: choice("ceo"),
          event: integer,
          card: integer,
          choices: list(object({ index: integer, approve: bool, opinion: text(200) }), 8),
        },
        ["business", "batch", "choices"],
      ),
      10,
    ),
    ownerReplies: list(object({ question: id, event: integer }), 5),
    responses: list(
      object(
        {
          anomaly: id,
          action: choice("clear-wait", "retry", "review", "pause", "resume", "plan", "escalate", "observe"),
          reason: text(200),
          category: choice("code", "auth", "quota", "platform", "decision", "spend", "identity"),
          request: text(160),
        },
        ["anomaly", "action", "reason"],
      ),
      6,
    ),
    staffPlans: list(
      object(
        {
          business: id,
          role: choice("product", "engineering", "qa", "growth", "support", "finance"),
          date: text(10),
          goal: text(120),
          focus: text(160),
          doneWhen: text(120),
          mode: choice("work", "followup", "standby"),
          plan: id,
          reviewAt: text(35),
          waiting: object({ kind: choice("owner", "plan"), id }),
        },
        ["business", "role", "date", "goal", "focus", "doneWhen", "mode", "reviewAt"],
      ),
      6,
    ),
    weeklyGoals: list(
      object({
        business: id,
        role: choice("product", "engineering", "qa", "growth", "support", "finance"),
        week: text(10),
        direction: text(160),
        metrics: list(object({ name: text(40), target: { type: ["number", "null"] }, unit: text(20) }), 3),
      }),
      6,
    ),
    manualMetrics: list(
      object(
        { publication: text(90), event: integer, reads: integer, likes: integer, collects: integer, comments: integer },
        ["publication", "event"],
      ),
      20,
    ),
  },
  ["briefs", "directives", "approvals", "answers", "escalations"],
);

// The CLI's structured result is data; the worker still validates the ordinary receipt and its authority.
export function ceoReceiptSchema(work?: { task: string; assignment: number }) {
  const detail = object(
    {
      summary: text(400),
      executive: ceoDecisionSchema,
      ...(work
        ? {
            assignment: { type: "integer", enum: [work.assignment] } as Schema,
            verdict: choice("pass", "revise", "blocked"),
            artifacts: list(text(150), 10),
            evidence: list(text(150), 10),
            dailyReport: object({ done: text(180), result: text(180), blockers: text(180), tomorrow: text(180) }),
            retrospective: object({ review: text(1800), notes: text(4000), through: integer }),
          }
        : {}),
    },
    work ? ["assignment", "verdict", "summary", "artifacts", "evidence", "executive"] : ["summary", "executive"],
  );
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      events: {
        type: "array",
        minItems: work ? 1 : 0,
        maxItems: 1,
        items: object({
          id: text(100),
          type: choice(work ? "company.result" : "company.ceo.decision"),
          subject: choice(work?.task ?? "owner"),
          detail,
        }),
      },
      ...Object.fromEntries(
        ["ask", "notice", "resolve"].map((k) => [
          k,
          { type: "array", items: schemas.$defs[k], maxItems: k === "ask" ? 5 : 10 },
        ]),
      ),
    },
    required: ["events"],
  };
}

const prose = new Set([
  "objective",
  "reason",
  "answer",
  "evidence",
  "question",
  "context",
  "report",
  "opinion",
  "request",
  "goal",
  "focus",
  "doneWhen",
  "direction",
  "title",
  "measure",
  "acceptance",
  "name",
  "unit",
]);
function validate(value: any, schema: Schema, field = "executive"): any {
  const kind = schema.type;
  if (Array.isArray(kind)) {
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) throw Error(`${field}类型不符`);
    return value;
  }
  if (kind === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`${field}需要对象`);
    for (const k of schema.required ?? []) if (!(k in value)) throw Error(`${field}.${k}缺失`);
    for (const k of Object.keys(value)) {
      if (!schema.properties?.[k]) throw Error(`${field}.${k}不在schema内`);
      value[k] = validate(value[k], schema.properties[k], k);
    }
  } else if (kind === "array") {
    if (!Array.isArray(value) || value.length > schema.maxItems!) throw Error(`${field}数组不符`);
    value = value.map((v) => validate(v, schema.items!, field));
  } else if (kind === "integer") {
    if (!Number.isSafeInteger(value) || value < (schema.minimum ?? 0)) throw Error(`${field}需要整数`);
  } else if (typeof value !== kind) throw Error(`${field}类型不符`);
  if (kind === "string" && schema.maxLength && value.length > schema.maxLength) {
    if (!prose.has(field)) throw Error(`${field}超过长度`);
    value = value.slice(0, schema.maxLength);
  }
  if (schema.enum && !schema.enum.includes(value)) throw Error(`${field}取值不符`);
  return value;
}
export function repairCEOText(input: string, work?: { task: string; assignment: number; proactive?: boolean }) {
  const block = /```agent-autoloop\s*\n([\s\S]*?)```/.exec(input) ?? /```(?:json)?\s*\n([\s\S]*?)```/.exec(input);
  let body = JSON.parse(block?.[1] ?? input.trim());
  if (work && !body.events && body.executive)
    body = { events: [{ type: "company.result", subject: work.task, detail: body }] };
  if (!work && body && !body.events && (body.notice || body.ask || body.resolve)) body.events = [];
  if (!body || !Array.isArray(body.events)) throw Error("CEO回执需要events");
  delete body.later; // Only the fixed scheduler owns CEO wakeups and deferred owner evidence.
  for (const event of body.events) {
    if (!["company.result", "company.ceo.decision"].includes(event.type)) continue;
    const detail = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail;
    if (!detail?.executive || typeof detail.executive !== "object") throw Error("CEO回执缺少executive");
    for (const key of ["briefs", "directives", "approvals", "answers", "escalations"]) detail.executive[key] ??= [];
    detail.executive = validate(detail.executive, ceoDecisionSchema);
    if (work?.proactive && detail.executive.report) detail.executive.report = detail.executive.report.slice(0, 500);
    executiveDecision(detail.executive);
    if (typeof detail.summary === "string") detail.summary = detail.summary.slice(0, 400);
    if (Array.isArray(detail.evidence))
      detail.evidence = detail.evidence.map((s: unknown) => (typeof s === "string" ? s.slice(0, 150) : s));
    if (work && event.type === "company.result") {
      detail.assignment ??= work.assignment;
      event.subject ??= work.task;
      event.id ??= `${work.task}:${work.assignment}:result`;
    }
    event.detail = JSON.stringify(detail);
    for (let pass = 0; pass < 4 && event.detail.length > 3500; pass++) {
      const shorten = (node: any) => {
        if (!node || typeof node !== "object") return;
        for (const [field, value] of Object.entries(node)) {
          if (typeof value === "string" && prose.has(field) && value.length > 40)
            node[field] = value.slice(0, Math.max(40, Math.floor(value.length * 0.6)));
          else if (value && typeof value === "object") shorten(value);
        }
      };
      shorten(detail.executive);
      event.detail = JSON.stringify(detail);
    }
    if (event.detail.length > 3500) throw Error("CEO决策过长，保留原文待维护，不丢弃动作");
  }
  return `CEO决策已校验。\n\n\`\`\`agent-autoloop\n${JSON.stringify(body)}\n\`\`\``;
}
