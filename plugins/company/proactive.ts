import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Leadership } from "./executive.ts";
import type { Project } from "./operations.ts";
import type { Publication } from "./publication.ts";
import { localDay, weekOf } from "./workday.ts";
import { reportTime } from "./reporting.ts";

export type ProactiveKind = "strategy" | "review" | "followup";
export type ProactiveRound = { date: string; kind: ProactiveKind; task?: string; conclusion?: string };
export const proactiveTitles = { strategy: "本周打法", review: "每日经营复盘", followup: "下午进度兜底" };
export const proactivePrompt = `CEO主动经营规范 v1：仅主动经营任务适用本节，覆盖旧的仅事件唤醒限制，仍使用现有CEO动作和每日额度。先读knowledge/ceo.json、knowledge/feedback.json及feedback.md，核对昨天小红书、币安、X发布状态和效果、今朝官网下载统计、本周目标进度、员工工作笔记与在途事项；缺失或过期数据写未知，不当作零。比较此前经营判断，只根据新信息调整staffPlans、directives、选题或要求补报，不重复派工。周一首轮合并策略：先确定本周目标，再据上周数据、董事长和CEO决定记录分析什么有效、什么无效，定本周打法，随后员工开选题会。用executive.report写1–500字经营结论及依据，系统写入管理笔记和当日日报的“今日经营判断”（日报正文不重复此节）；无新信息必须简短写“无需动作”并保持动作数组为空，不安排重复唤醒。仅新增支出走现有escalations.category=spend花钱决策通道，其他在现有授权及动作范围内直接执行。主动经营规范结束。`;

export function proactiveDue(
  now: Date,
  rounds: ProactiveRound[],
  startDate?: string,
  after = "09:00",
  onceDaily = false,
) {
  const date = localDay(now),
    weekday = new Date(date).getUTCDay();
  if (!weekday || weekday === 6 || (startDate && date < startDate)) return;
  if (onceDaily) {
    if (rounds.some((r) => r.date === date) || now.toISOString() >= reportTime(date, "20:30")) return;
    return now.toISOString() >= reportTime(date, weekday === 1 ? after : "10:30")
      ? weekday === 1
        ? "strategy"
        : "review"
      : undefined;
  }
  const at = now.toISOString();
  let kind: ProactiveKind | undefined;
  if (weekday === 1 && at >= reportTime(date, after) && at < reportTime(date, "10:30")) kind = "strategy";
  else if (at >= reportTime(date, "10:30") && at < reportTime(date, "15:30")) kind = "review";
  else if (at >= reportTime(date, "15:30") && at < reportTime(date, "20:30")) kind = "followup";
  return kind && !rounds.some((r) => r.date === date && r.kind === kind) ? kind : undefined;
}

// Claims/queued tasks are not model runs; owner conversations and receipt repairs also count here.
export function ceoRanSince(directory: string, since: string, now: Date) {
  const file = join(directory, "model-runs.db");
  if (!existsSync(file)) return false;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return !!db
      .prepare(
        "SELECT 1 FROM journal j WHERE kind='started' AND role='ceo' AND at>=? AND at<=? AND NOT EXISTS (SELECT 1 FROM journal r WHERE r.id=j.id||':refunded') LIMIT 1",
      )
      .get(since, now.toISOString());
  } finally {
    db.close();
  }
}

export function weeklyProgress(projects: Project[], publications: Publication[], now: Date) {
  const date = localDay(now),
    week = weekOf(now),
    elapsed = Math.min(5, (Date.parse(date) - Date.parse(week)) / 86400_000 + 1);
  return projects.flatMap((p) =>
    p.staff.flatMap((s) => {
      if (s.weeklyGoal?.week !== week) return [];
      return s.weeklyGoal.metrics
        .filter((m) => m.target !== null && m.target > 0)
        .map((m) => {
          const actual =
            m.unit === "篇"
              ? new Set(
                  publications
                    .filter(
                      (r) =>
                        localDay(new Date(r.publishedAt)) >= week &&
                        localDay(new Date(r.publishedAt)) <= date &&
                        p.plans.some((a) => a.owner === s.role && a.publicationKey === r.key),
                    )
                    .map((r) => r.key),
                ).size
              : null;
          const expected = (m.target! * elapsed) / 5;
          return {
            business: p.business,
            role: s.role,
            metric: m.name,
            target: m.target,
            actual,
            expected,
            behind: actual !== null && actual < expected,
          };
        });
    }),
  );
}

export function registeredProactive(directory: string, task: string): ProactiveRound | undefined {
  const file = join(directory, "operations.db");
  if (!existsSync(file)) return;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT body FROM leadership WHERE id='company'").get();
    return row ? (JSON.parse(String(row.body)) as Leadership).proactiveRounds?.find((r) => r.task === task) : undefined;
  } finally {
    db.close();
  }
}

export function operatingJudgment(c: Leadership, date: string) {
  const rounds = c.proactiveRounds?.filter((r) => r.date === date) ?? [];
  return (
    "\n\n今日经营判断\n" +
    (rounds.length
      ? rounds.map((r) => `${proactiveTitles[r.kind]}：${r.conclusion ?? "本轮尚未完成，暂无结论"}`).join("\n")
      : "今日尚无主动经营结论")
  );
}
