import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { Project } from "./operations.ts";
import type { Task, Receipt, Context } from "./company.ts";
import { taskProject } from "./staff-model.ts";
import { readStories, type Story } from "./ai-stories.ts";
import { localDay } from "./workday.ts";
import { failedEvidence, type SearchEvidence } from "../xiaohongshu/search.ts";

export type StoryProposal = { title: string; story: string; hook: string; keyword: string };
export type StoryBatch = {
  id: string;
  date: string;
  task: string;
  candidates: Story[];
  excluded: string[];
  proposals?: (StoryProposal & { evidence: SearchEvidence })[];
  cardSent?: boolean;
  closed?: boolean;
  rejected?: boolean;
  selected?: string;
  opinion?: string;
};
const id = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);
export const aiTopicPrompt = `今朝每日选题规范：仅适用于启用aiStoryTopics的今朝。本节优先于直接写稿要求。选题任务只报3个未写过的真实故事，不写正文、不做图、不自行搜索或发布。只从knowledge/ai-stories.md取材，口吻参考chairman-voice-samples.md前三篇；旧素材、范文和平台笔记不能充当本人的新经历。读取knowledge/operations/jinzhao.json中本次aiTopicBatches的candidates和excluded，严格从候选卡选3个不同编号，排除已退回编号；company.result.detail带aiTopics:[{title,story,hook,keyword}]，标题≤20字，story为S编号，一句话钩子≤100字，keyword≤80字，artifacts为空。搜索由程序只读执行并附证据。素材不足就verdict:blocked、summary:素材不足并停止。董事长选中后才按派工里的story编号写那一篇，stories只能列该编号；不得改素材库、编造经历、数字、对话或用平台案例冒充本人。JinZhao Reading和记住只在故事相关时自然提一句，不写下载或获取引导。不恢复CEO初筛，不催选题。`;
export function topicBatchForTask(directory: string, task: string) {
  return taskProject(directory, task)?.aiTopicBatches?.find((b) => b.task === task);
}
export function storyProposals(value: unknown, batch: StoryBatch, directory: string): StoryProposal[] {
  if (!Array.isArray(value) || value.length !== 3) throw Error("选题必须恰好3个");
  const current = readStories(directory);
  const proposals = value.map((v) => {
    if (!v || typeof v !== "object") throw Error("选题格式无效");
    for (const [key, max] of [
      ["title", 20],
      ["story", 20],
      ["hook", 100],
      ["keyword", 80],
    ] as const)
      if (typeof v[key] !== "string" || !v[key].trim() || [...v[key]].length > max || /[\r\n\x00-\x1f]/.test(v[key]))
        throw Error("选题字段无效");
    const candidate = batch.candidates.find((s) => s.id === v.story);
    if (
      !candidate ||
      batch.excluded.includes(v.story) ||
      !current.some((s) => s.id === candidate.id && s.text === candidate.text)
    )
      throw Error("故事卡不存在、已使用或内容已变更");
    return { title: v.title.trim(), story: v.story, hook: v.hook.trim(), keyword: v.keyword.trim() };
  });
  if (new Set(proposals.map((p) => p.story)).size !== 3) throw Error("故事卡不能重复");
  return proposals;
}
function evidenceCommand(command: string[], keyword: string): Promise<SearchEvidence> {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe"], timeout: 70000 });
    let output = "";
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 256000) child.kill();
    });
    child.stderr.resume();
    child.on("error", () => resolve(failedEvidence()));
    child.on("close", (code) => {
      try {
        const result = JSON.parse(output);
        if (
          code !== 0 ||
          !["有平台证据", "无平台证据", "证据获取失败"].includes(result.status) ||
          !Array.isArray(result.notes) ||
          result.notes.length > 3 ||
          result.notes.some(
            (n: any) =>
              typeof n.title !== "string" ||
              n.title.length > 100 ||
              !Number.isFinite(n.likes) ||
              n.likes < 100 ||
              !/^https:\/\/www\.xiaohongshu\.com\/explore\/[a-f0-9]{24}$/.test(n.url),
          ) ||
          (result.status === "有平台证据" && result.notes.length < 2)
        )
          throw Error();
        resolve(result);
      } catch {
        resolve(failedEvidence());
      }
    });
    child.stdin.end(JSON.stringify({ action: "search", keyword }));
  });
}
export async function collectTopicEvidence(
  directory: string,
  projects: Project[],
  tasks: Task[],
  command?: string[],
  now = new Date(),
  search = evidenceCommand,
  wait: (ms: number) => Promise<unknown> = delay,
) {
  const path = join(directory, "ai-topic-evidence.json");
  const cache: Record<string, SearchEvidence[]> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const save = () => {
    writeFileSync(path + ".tmp", JSON.stringify(cache), { mode: 0o600 });
    renameSync(path + ".tmp", path);
  };
  for (const b of projects.find((p) => p.business === "jinzhao")?.aiTopicBatches ?? []) {
    if (b.closed || b.date !== localDay(now) || cache[b.id]) continue;
    const task = tasks.find((t) => t.id === b.task && t.status === "completed");
    const proposals = task?.reports.at(-1)?.aiTopics;
    if (!proposals) continue;
    // Mark all attempts before I/O; restart never repeats a failed or interrupted search batch.
    cache[b.id] = proposals.map(() => failedEvidence());
    save();
    if (!command?.length) continue;
    for (let i = 0; i < proposals.length; i++) {
      if (i) await wait(5500);
      cache[b.id][i] = await search(command, proposals[i].keyword);
      save();
      if (cache[b.id][i].status === "证据获取失败") break;
    }
  }
}
export function storyTopicTick(
  directory: string,
  p: Project,
  tasks: Task[],
  receipt: Receipt,
  answers: Context["answers"],
  now: Date,
  canStart: boolean,
) {
  const date = localDay(now),
    batches = (p.aiTopicBatches ??= []);
  const stories = readStories(directory);
  const used = new Set(batches.flatMap((b) => (b.selected ? [b.selected] : [])));
  for (const b of batches) {
    if (b.closed) continue;
    if (b.date !== date) {
      b.closed = true;
      continue;
    }
    const task = tasks.find((t) => t.id === b.task);
    if (task && ["blocked", "rejected", "superseded"].includes(task.status)) {
      b.closed = true;
      continue;
    }
    if (!b.proposals && task?.status === "completed") {
      const proposals = task.reports.at(-1)?.aiTopics;
      const file = join(directory, "ai-topic-evidence.json");
      const evidence = existsSync(file) ? JSON.parse(readFileSync(file, "utf8"))[b.id] : undefined;
      if (proposals && evidence)
        b.proposals = proposals
          .map((v, i) => ({ ...v, evidence: evidence[i] ?? failedEvidence() }))
          .sort((a, b) => Number(b.evidence.status === "有平台证据") - Number(a.evidence.status === "有平台证据"));
    }
    if (!b.proposals) continue;
    if (!b.cardSent) {
      (receipt.ask ??= []).push({
        key: `ai-topics:${b.id}`,
        about: `ai-topics:${b.id}`,
        title: "今朝选题",
        text:
          `今日选题（${date}，仅当天有效；未选择不写、不催）\n\n` +
          b.proposals
            .map(
              (t, i) =>
                `${i + 1}. ${t.title}\n故事卡：${t.story}\n钩子：${t.hook}\n${t.evidence.status}\n${t.evidence.notes.map((n) => `${n.title}｜${n.likes}赞｜${n.url}`).join("\n")}`,
            )
            .join("\n\n"),
        options: [...b.proposals.map((t, i) => `写这个：${i + 1} ${t.title}`), "都不要，换一批"],
      });
      b.cardSent = true;
    }
    const answer = answers.find(
      (a) =>
        a.about === `ai-topics:${b.id}` &&
        a.choice !== null &&
        a.choice >= 0 &&
        a.choice <= 3 &&
        localDay(new Date(a.at ?? now)) === date,
    );
    if (!answer) continue;
    b.closed = true;
    b.opinion = answer.text?.trim() ?? "";
    if (answer.choice === 3) {
      b.rejected = true;
      continue;
    }
    const topic = b.proposals[answer.choice!];
    if (!stories.some((s) => s.id === topic.story && s.text === b.candidates.find((s) => s.id === topic.story)?.text))
      continue;
    if (!canStart) {
      p.aiTopicStatus = "当前不能写稿，未占用故事";
      continue;
    }
    b.selected = topic.story;
    return { ...topic, batch: b.id, opinion: b.opinion };
  }
  const today = batches.filter((b) => b.date === date);
  if (
    !canStart ||
    today.some((b) => !b.closed) ||
    today.some((b) => b.selected) ||
    (today.length && !today.at(-1)?.rejected)
  )
    return;
  const excluded = today.flatMap((b) => (b.rejected ? (b.proposals?.map((p) => p.story) ?? []) : []));
  const candidates = stories.filter((s) => !used.has(s.id) && !excluded.includes(s.id));
  if (candidates.length < 3) {
    p.aiTopicStatus = "素材不足";
    return;
  }
  if (today.length >= 5) {
    p.aiTopicStatus = "今日选题搜索额度已用完";
    return;
  }
  const key = id(`ai-stories:${date}:${today.length}`),
    task = `T-${key}`;
  batches.push({ id: key, date, task, candidates, excluded });
  p.aiTopicStatus = "待报选题";
  p.activity.push({ task, role: "growth", kind: "work", at: now.toISOString() });
  (receipt.events ??= []).push({
    id: `company:ai-topics:${key}`,
    type: "company.task.create",
    subject: task,
    summary: "今朝 · 每日选题",
    detail: JSON.stringify({
      title: "今朝 · 每日选题",
      kind: "staff-growth",
      goal: `只报3个选题，不写稿。按aiTopicBatches批次${key}的候选故事卡取材，读取ai-stories.md和recent-posts.md，避开最近10篇及已写故事。按规范提交aiTopics，平台证据由程序补齐。上批意见：${today.at(-1)?.opinion ?? "无"}`.slice(
        0,
        500,
      ),
      acceptance: ["3个未写故事的标题、故事卡编号、一句话钩子和搜索关键词", "仅报题，不写稿"],
    }),
  });
}
