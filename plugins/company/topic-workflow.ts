import type { DatabaseSync } from "node:sqlite";
import type { Project } from "./operations.ts";
import type { CompanyConfig, Context, Receipt } from "./company.ts";
import type { ExecutiveDecision } from "./executive.ts";
import { appendNote } from "./notes.ts";
import { weekOf } from "./workday.ts";
import { ownerReplyEvidence, ownerAnswerEvidence, ownerCardMessage } from "./owner-replies.ts";
import { decideTopics, parseTopicReply, screenTopic, topicCard, topicId } from "./topics.ts";

function replyChoices(e: ReturnType<typeof ownerReplyEvidence>, batch: import("./topics.ts").TopicBatch) {
  const c = e.topicChoice;
  if (
    e.topicBatch === batch.id &&
    c &&
    Number.isSafeInteger(c.index) &&
    c.index >= 0 &&
    c.index < batch.topics.length &&
    typeof c.approve === "boolean" &&
    typeof c.opinion === "string" &&
    c.opinion.length <= 200
  )
    return [c];
  return parseTopicReply(e.text.replace(/^选题批次：[a-f0-9]{24}\n/, ""), batch.topics.length);
}
export class TopicWorkflow {
  private db: DatabaseSync;
  private directory: string;
  private config: Partial<CompanyConfig>;
  constructor(db: DatabaseSync, directory: string, config: Partial<CompanyConfig> = {}) {
    this.config = config;
    this.db = db;
    this.directory = directory;
  }
  projects(): Project[] {
    return this.db
      .prepare("SELECT body FROM projects")
      .all()
      .map((r) => JSON.parse(String(r.body)));
  }
  save(p: Project, now: Date) {
    const body = JSON.stringify(p);
    this.db.prepare("UPDATE projects SET body=? WHERE id=?").run(body, p.business);
    this.db
      .prepare("INSERT INTO journal(project,kind,at,body) VALUES (?,?,?,?)")
      .run(p.business, "topics", now.toISOString(), body);
  }
  evidence(r: NonNullable<ExecutiveDecision["topicDecisions"]>[number], p: Project) {
    const b = p.topicBatches?.find((b) => b.id === r.batch);
    if (!b) throw Error("选题批次不存在");
    if (r.source === "ceo") {
      if (!this.config.delegation) throw Error("未授权CEO选题决定");
      for (const choice of r.choices) {
        const topic = p.topics?.find((t) => t.id === b.topics[choice.index] && t.batch === b.id);
        if (!topic || !["pending", choice.approve ? "approved" : "rejected"].includes(topic.state))
          throw Error("CEO决定引用了批次外或已有不同决定的选题");
      }
      return { b, e: { message: this.config.delegation.source, at: new Date().toISOString() } };
    }
    const e = r.event
      ? ownerReplyEvidence(this.directory, r.event, b.at)
      : ownerAnswerEvidence(this.directory, r.card!, b.at);
    const marker = /(?:选题批次[：:\s]*|topics:)([a-f0-9]{24})/.exec(e.context ?? e.text)?.[1];
    const pending = this.projects().flatMap((p) => (p.topicBatches ?? []).filter((b) => !b.closed));
    if (marker ? marker !== b.id : pending.length !== 1 || pending[0].id !== b.id)
      throw Error("选题答复批次不明确，需董事长指明或引用卡片");
    if (
      r.card &&
      /其余|剩余/.test(e.context ?? "") &&
      !b.topics.some((id) => p.topics?.find((t) => t.id === id)?.state === "approved")
    )
      throw Error("追问中的其余选题缺少已拍板依据，先记录此前明确的决定");
    let parsed = replyChoices(e, b);
    if (/^(?:其余|其他|剩余)(?:全部|都)?(?:撤下|退回)(?:[，,]另报新题)?[。！!]?$/u.test(e.text.trim())) {
      if (!b.topics.some((id) => p.topics?.find((t) => t.id === id)?.state === "approved"))
        throw Error("其余选题缺少已拍板依据，不能猜测范围");
      parsed = b.topics.flatMap((id, index) =>
        p.topics?.find((t) => t.id === id)?.state === "pending" ? [{ index, approve: false, opinion: e.text }] : [],
      );
    }
    for (const choice of r.choices) {
      if (!b.topics[choice.index]) throw Error("拍板引用了批次以外的选题");
      const topic = p.topics?.find((t) => t.id === b.topics[choice.index]);
      if (topic && topic.state !== "pending" && topic.state !== (choice.approve ? "approved" : "rejected"))
        throw Error("该选题已有不同决定，不能覆盖原拍板");
      if (choice.approve && /(?:不|别|不要|暂不|尚未)(?:全部)?(?:通过|同意|满意)|[？?]/.test(e.text))
        throw Error("原话是否定或询问，不能代董事长批准");
      if (parsed.length && !parsed.some((v) => v.index === choice.index && v.approve === choice.approve))
        throw Error("代录决定与董事长原话不一致");
    }
    if (!parsed.length && !/(通过|退回|撤下|满意|同意|可以|保留)/.test(e.text))
      throw Error("原话没有明确拍板决定，不能代董事长批准");
    return { b, e };
  }
  validate(d: ExecutiveDecision) {
    const projects = this.projects();
    const seen = new Set<string>();
    for (const r of d.topicReviews ?? []) {
      const t = projects.find((p) => p.business === r.business)?.topics?.find((t) => t.id === r.topic);
      if (!t || t.state !== "screening" || seen.has(t.id)) throw Error("选题初筛必须引用未初筛的选题，且不重复");
      if (
        this.config.delegation &&
        (!Number.isInteger(r.score) || r.score! < 0 || r.score! > 10 || r.approve !== r.score! >= 7)
      )
        throw Error("CEO须按对应手册评分，7分起通过，低于7分退回，并记录理由");
      seen.add(t.id);
    }
    for (const r of d.topicDecisions ?? []) {
      const p = projects.find((p) => p.business === r.business);
      if (!p) throw Error("拍板业务不存在");
      const { b, e } = this.evidence(r, p);
      for (const choice of r.choices) {
        const id = `${r.batch}:${choice.index}`;
        if (seen.has(id)) throw Error("同一选题不能重复拍板");
        seen.add(id);
      }
      decideTopics(p, b, r.choices, e.at);
    }
    for (const r of d.topicReplies ?? []) {
      const b = projects.find((p) => p.business === r.business)?.topicBatches?.find((b) => b.id === r.batch);
      if (!b) throw Error("选题批次不存在");
      const e = ownerReplyEvidence(this.directory, r.event, b.at);
      const marker = /选题批次：([a-f0-9]{24})/.exec(e.context ?? e.text)?.[1];
      const pending = projects.flatMap((p) => (p.topicBatches ?? []).filter((b) => !b.closed));
      if (marker ? marker !== b.id : pending.length !== 1 || pending[0].id !== b.id)
        throw Error("选题答复批次不明确，需董事长指明或引用卡片");
      if (!replyChoices(e, b).length) throw Error("选题答复不明确，不能代董事长拍板");
    }
  }
  record(
    p: Project,
    b: import("./topics.ts").TopicBatch,
    choices: import("./topics.ts").TopicChoice[],
    e: { event?: number; card?: number; message: string; at: string },
  ) {
    const pending = choices.filter((c) => p.topics?.find((t) => t.id === b.topics[c.index])?.state === "pending");
    decideTopics(p, b, pending, e.at, { event: e.event, card: e.card, message: e.message });
    b.closed = b.topics.every((id) => p.topics?.find((t) => t.id === id)?.state !== "pending");
    for (const choice of pending) {
      const t = p.topics!.find((t) => t.id === b.topics[choice.index])!;
      for (const agent of ["ceo", `${p.business}:${t.role}`])
        appendNote(
          this.db,
          agent,
          `topic-decision:${t.id}`,
          `${this.config.delegation ? "CEO" : "董事长"}${choice.approve ? "通过" : "退回并撤下"}《${t.title}》：${choice.opinion}（来源：${e.message}）`,
          e.at,
        );
    }
  }
  apply(d: ExecutiveDecision, now: Date) {
    for (const p of this.projects()) {
      let changed = false;
      for (const r of d.topicReviews?.filter((r) => r.business === p.business) ?? []) {
        screenTopic(
          p.topics!.find((t) => t.id === r.topic)!,
          r.approve,
          r.reason,
          r.rank,
        );
        if (this.config.delegation) {
          const t = p.topics!.find((t) => t.id === r.topic)!;
          t.score = r.score;
          t.state = r.approve ? "approved" : "returned";
          t.opinion = r.reason;
          t.decidedAt = now.toISOString();
          t.decisionSource = { message: this.config.delegation.source };
          for (const agent of ["ceo", `${p.business}:${t.role}`])
            appendNote(
              this.db,
              agent,
              `topic-review:${t.id}`,
              `CEO${r.approve ? "通过" : "退回换题"}《${t.title}》：${r.score}/10，${r.reason}`,
              now.toISOString(),
            );
        }
        changed = true;
      }
      for (const r of d.topicDecisions?.filter((r) => r.business === p.business) ?? []) {
        const { b, e } = this.evidence(r, p);
        this.record(p, b, r.choices, r.source === "ceo" ? { ...e, at: now.toISOString() } : e);
        changed = true;
      }
      for (const r of d.topicReplies?.filter((r) => r.business === p.business) ?? []) {
        const b = p.topicBatches!.find((b) => b.id === r.batch)!;
        const e = ownerReplyEvidence(this.directory, r.event, b.at);
        this.record(p, b, replyChoices(e, b), e);
        changed = true;
      }
      if (changed) this.save(p, now);
    }
  }
  tick(answers: Context["answers"], events: Context["events"], receipt: Receipt, now: Date, expected: string[] = []) {
    if (this.config.delegation) {
      for (const p of this.projects()) {
        const legacy = p.topics?.filter((t) => t.state === "ready") ?? [];
        if (!legacy.length) continue;
        for (const t of legacy) t.state = "screening";
        this.save(p, now);
      }
      return;
    }
    const projects = this.projects();
    for (const p of projects) {
      const before = JSON.stringify(p);
      for (const b of p.topicBatches ?? []) {
        const replies: {
          choices: import("./topics.ts").TopicChoice[];
          at: string;
          evidence?: ReturnType<typeof ownerReplyEvidence>;
        }[] = [];
        for (const e of events.filter((e) => e.source === "company-inbox" && e.type === "company.owner.question")) {
          let raw: any;
          try {
            raw = JSON.parse(e.detail ?? "{}");
          } catch {
            continue;
          }
          if (raw.topicBatch !== b.id || typeof raw.question !== "string") continue;
          const evidence = ownerReplyEvidence(this.directory, e.id, b.at);
          if (evidence.text !== raw.question) continue;
          replies.push({ choices: replyChoices(evidence, b), at: evidence.at, evidence });
        }
        for (const a of answers.filter((a) => a.about === `topics:${b.id}`)) {
          b.card = a.card;
          replies.push({
            choices: parseTopicReply(
              a.choice === 0 ? "全部通过" : a.choice === 1 ? "全部退回" : (a.text ?? ""),
              b.topics.length,
            ).map((choice) => ({
              ...choice,
              ...(a.choice !== null && a.text?.trim() ? { opinion: a.text.trim() } : {}),
            })),
            at: a.at ?? now.toISOString(),
          });
        }
        // Callback events and whole-card answers can arrive in the same scheduling batch.
        for (const reply of replies.sort((a, b) => a.at.localeCompare(b.at))) {
          if (reply.evidence) this.record(p, b, reply.choices, reply.evidence);
          else
            this.record(p, b, reply.choices, {
              card: b.card,
              message: ownerCardMessage(this.directory, b.card!),
              at: reply.at,
            });
        }
        b.closed = b.topics.every((id) => p.topics!.find((t) => t.id === id)?.state !== "pending");
        if (!b.closed && answers.some((a) => a.about === `topics:${b.id}`)) {
          (receipt.ask ??= []).push(topicCard(p, b));
        }
      }
      if (before !== JSON.stringify(p)) this.save(p, now);
    }
    // Send all businesses from the Monday meeting together, after the single replacement round.
    const readyProjects = this.projects();
    const weeklyWaiting = expected.some((id) => {
      const p = readyProjects.find((p) => p.business === id);
      return p?.topicMeeting?.week !== weekOf(now) || !p.topicMeeting.completed;
    });
    const screening = readyProjects.some((p) =>
      p.topics?.some((t) => t.meeting === weekOf(now) && ["screening", "returned"].includes(t.state)),
    );
    for (const p of readyProjects) {
      const ready = (p.topics ?? [])
        .filter((t) => t.state === "ready" && (t.meeting !== weekOf(now) || !(weeklyWaiting || screening)))
        .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
      if (!ready.length || (receipt.ask?.length ?? 0) >= 5) continue;
      // Each packet fits the existing 4,000-character card boundary without dropping proposal fields.
      while (ready.length && (receipt.ask?.length ?? 0) < 5) {
        const selected = ready.splice(0, 8);
        const batch = {
          id: topicId(selected.map((t) => t.id).join(":")),
          topics: selected.map((t) => t.id),
          at: now.toISOString(),
        };
        for (const t of selected) {
          t.batch = batch.id;
          t.state = "pending";
        }
        (p.topicBatches ??= []).push(batch);
        (receipt.ask ??= []).push(topicCard(p, batch));
      }
      this.save(p, now);
    }
  }
}
