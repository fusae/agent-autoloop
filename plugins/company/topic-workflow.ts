import type { DatabaseSync } from "node:sqlite";
import type { Project } from "./operations.ts";
import type { Context, Receipt } from "./company.ts";
import type { ExecutiveDecision } from "./executive.ts";
import { weekOf } from "./workday.ts";
import { ownerReplyEvidence } from "./owner-replies.ts";
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
  constructor(db: DatabaseSync, directory: string) {
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
  validate(d: ExecutiveDecision) {
    const projects = this.projects();
    const seen = new Set<string>();
    for (const r of d.topicReviews ?? []) {
      const t = projects.find((p) => p.business === r.business)?.topics?.find((t) => t.id === r.topic);
      if (!t || t.state !== "screening" || seen.has(t.id)) throw Error("选题初筛必须引用未初筛的选题，且不重复");
      seen.add(t.id);
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
        changed = true;
      }
      for (const r of d.topicReplies?.filter((r) => r.business === p.business) ?? []) {
        const b = p.topicBatches!.find((b) => b.id === r.batch)!;
        const e = ownerReplyEvidence(this.directory, r.event, b.at);
        decideTopics(p, b, replyChoices(e, b), e.at);
        changed = true;
      }
      if (changed) this.save(p, now);
    }
  }
  tick(answers: Context["answers"], events: Context["events"], receipt: Receipt, now: Date, expected: string[] = []) {
    const projects = this.projects();
    for (const p of projects) {
      const before = JSON.stringify(p);
      for (const b of p.topicBatches ?? []) {
        const replies: { choices: import("./topics.ts").TopicChoice[]; at: string }[] = [];
        for (const e of events.filter((e) => e.source === "company-inbox" && e.type === "company.owner.question")) {
          let raw: any;
          try {
            raw = JSON.parse(e.detail ?? "{}");
          } catch {
            continue;
          }
          if (raw.topicBatch !== b.id || typeof raw.question !== "string") continue;
          const evidence = ownerReplyEvidence(this.directory, Number(e.id), b.at);
          if (evidence.text !== raw.question) continue;
          replies.push({ choices: replyChoices(evidence, b), at: evidence.at });
        }
        for (const a of answers.filter((a) => a.about === `topics:${b.id}`)) {
          b.card = a.card;
          replies.push({
            choices: parseTopicReply(
              a.choice === 0 ? "全部通过" : a.choice === 1 ? "全部退回" : (a.text ?? ""),
              b.topics.length,
            ),
            at: a.at ?? now.toISOString(),
          });
        }
        // Callback events and whole-card answers can arrive in the same scheduling batch.
        for (const reply of replies.sort((a, b) => a.at.localeCompare(b.at))) {
          decideTopics(p, b, reply.choices, reply.at);
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
        .filter((t) => t.state === "ready" && (!t.meeting || !(weeklyWaiting || screening)))
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
