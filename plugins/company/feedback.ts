import { localDay, weekOf } from "./workday.ts";
import { frozenSummary } from "./content.ts";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { publicationResults, publishDay } from "./publication-policy.ts";
import { readFeedback } from "./verification.ts";
import { sourceSnapshots } from "./sources.ts";
import type { Leadership } from "./executive.ts";
import type { Observation } from "../xiaohongshu/reader.ts";
const load = (p: string, fallback: any) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);
function save(p: string, value: unknown) {
  writeFileSync(p + ".tmp", JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(p + ".tmp", p);
}
export type ManualMetric = {
  publication: string;
  event: number;
  reads?: number;
  likes?: number;
  collects?: number;
  comments?: number;
  source: "董事长" | "董事长提供";
  at: string;
  text: string;
};
type Daily = { day: string; at: string; observation: Observation };
type ManualPost = {
  id: string;
  title: string;
  url: string;
  firstSeen: string;
  samples: { at: string; likes: number | null }[];
};
const shiftedDay = (day: string, offset: number) =>
  new Date(Date.parse(day + "T00:00:00Z") + offset * 86400000).toISOString().slice(0, 10);
export function compareDays(publishedAt: string, values: Record<string, number>, now: Date) {
  const day = publishDay(new Date(publishedAt)),
    today = publishDay(now);
  const before = [-3, -2, -1].map((n) => shiftedDay(day, n)),
    after = [1, 2, 3].map((n) => shiftedDay(day, n));
  const total = (days: string[]) =>
    days.every((d) => d < today && Number.isFinite(values[d])) ? days.reduce((n, d) => n + values[d], 0) : null;
  const baseline = total(before),
    result = total(after);
  return {
    before,
    after,
    baseline,
    result,
    change: baseline === null || result === null ? null : result - baseline,
    percent: baseline === null || baseline === 0 || result === null ? null : ((result - baseline) / baseline) * 100,
  };
}
export async function collectFeedback(
  directory: string,
  leadership: Leadership,
  now = new Date(),
  read = readFeedback,
  notify?: (key: string, text: string) => Promise<unknown>,
) {
  const cfgPath = join(directory, "feedback.json");
  if (!existsSync(cfgPath)) return;
  const cfg = load(cfgPath, {});
  if (cfg.enabled !== true) return;
  const lock = join(directory, "feedback.lock");
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    return;
  }
  try {
    const stateFile = join(directory, "feedback-state.json"),
      state = load(stateFile, { days: [], products: {}, resume: cfg.resume ?? "" });
    if (state.resume !== (cfg.resume ?? "")) {
      delete state.blocked;
      state.resume = cfg.resume ?? "";
    }
    const today = publishDay(now),
      due = Date.parse(today + "T09:35:00+08:00"),
      publications = publicationResults(directory);
    if (!state.blocked && now.getTime() >= due && !state.days.some((d: Daily) => d.day === today)) {
      // Record the attempt before the external read; a crash cannot double the daily collection.
      const daily: Daily = {
        day: today,
        at: now.toISOString(),
        observation: { state: "unknown", reason: "本次采集未完成" },
      };
      state.days.push(daily);
      save(stateFile, state);
      try {
        daily.observation = read(
          directory,
          publications.filter((p) => !p.x).map((p) => p.remoteId),
        );
      } catch {
        daily.observation = { state: "unknown", reason: "只读采集未取得完整数据" };
      }
      if (daily.observation.state === "blocked")
        state.blocked = { at: now.toISOString(), reason: daily.observation.reason };
      save(stateFile, state);
    }
    if (state.blocked && state.notifiedIncident !== state.blocked.at && state.notifiedDay !== today && notify) {
      await notify(
        `company-feedback-blocked-${today}`,
        `小红书效果采集已暂停：${state.blocked.reason}。请处理登录或平台提示，恢复后解除采集暂停。`,
      );
      state.notifiedDay = today;
      state.notifiedIncident = state.blocked.at;
      save(stateFile, state);
    }
    for (const [business, snapshot] of Object.entries(sourceSnapshots(directory))) {
      if (snapshot.database.error || !snapshot.database.checkedAt) continue;
      const data = snapshot.database.data as any;
      const daily = data?.usage?.devices_daily ?? data?.accounts?.registrations_daily;
      const downloads = data?.downloads?.daily;
      const product = (state.products[business] ??= { growth: {}, downloads: {} });
      for (const [field, rows] of [
        ["growth", daily?.rows],
        ["downloads", downloads?.rows],
      ] as const) {
        for (const [date, count] of rows ?? [])
          if (
            date < publishDay(new Date(snapshot.database.checkedAt)) &&
            /^\d{4}-\d{2}-\d{2}$/.test(date) &&
            Number.isSafeInteger(count) &&
            count >= 0
          )
            product[field][date] = count;
      }
      product.label = business === "jizhu" ? "新增设备" : "注册";
      product.checkedAt = snapshot.database.checkedAt;
      product.downloadNote = data?.downloads?.note ?? "无可用下载日志";
      product.downloadCurrent = data?.downloads?.current ?? null;
    }
    save(stateFile, state);
    const days: Daily[] = state.days;
    const systemIds = new Set(
      publicationResults(directory, true)
        .filter((p) => !p.x)
        .map((p) => p.remoteId),
    );
    const manualById = new Map<string, ManualPost>();
    for (const d of days.slice().sort((a, b) => a.at.localeCompare(b.at))) {
      if (d.observation.state !== "ready") continue;
      for (const note of d.observation.others ?? []) {
        if (systemIds.has(note.id)) continue;
        let post = manualById.get(note.id);
        if (!post) {
          post = {
            id: note.id,
            title: note.title,
            url: `https://www.xiaohongshu.com/explore/${note.id}`,
            firstSeen: d.at,
            samples: [],
          };
          manualById.set(note.id, post);
        }
        post.title = note.title;
        if (!post.samples.some((s) => publishDay(new Date(s.at)) === d.day))
          post.samples.push({ at: d.at, likes: note.likes });
      }
    }
    const manual = [...manualById.values()];
    const posts = publications.map((p) => {
      const frozen = load(join(directory, "publications", p.key + ".json"), {}),
        business = frozen.business;
      const samples = p.x
        ? []
        : days.flatMap((d) =>
            d.observation.state === "ready"
              ? d.observation.notes.filter((n) => n.id === p.remoteId).map((n) => ({ at: d.at, ...n }))
              : [],
          );
      const product = state.products[business];
      return {
        ...p,
        ...frozenSummary(frozen.artifacts),
        business,
        samples: samples.map((s, i) => ({
          ...s,
          change: i
            ? {
                likes: s.likes - samples[i - 1].likes,
                collects: s.collects - samples[i - 1].collects,
                comments: s.comments - samples[i - 1].comments,
              }
            : null,
        })),
        reads: (leadership.manualMetrics ?? []).filter((m) => m.publication === p.key),
        attribution: publications.some(
          (other) =>
            other.key !== p.key &&
            load(join(directory, "publications", other.key + ".json"), {}).business === business &&
            Math.abs(
              Date.parse(publishDay(new Date(other.publishedAt))) - Date.parse(publishDay(new Date(p.publishedAt))),
            ) <=
              6 * 86400000,
        )
          ? "无法单篇归因"
          : "时间对比，不证明因果",
        product: product
          ? {
              label: product.label,
              growth: compareDays(p.publishedAt, product.growth, now),
              downloads: compareDays(p.publishedAt, product.downloads, now),
              downloadNote: product.downloadNote,
            }
          : null,
      };
    });
    const followers = days
      .flatMap((d) => (d.observation.state === "ready" ? [{ at: d.at, count: d.observation.followers }] : []))
      .map((v, i, all) => ({ ...v, change: i ? v.count - all[i - 1].count : null }));
    const folder = join(directory, "workspace/knowledge");
    mkdirSync(folder, { recursive: true });
    save(join(folder, "feedback.json"), {
      at: now.toISOString(),
      status: state.blocked ?? "每天09:35采集",
      days,
      followers,
      posts,
      manual,
      products: state.products,
      ownerMetrics: leadership.manualMetrics ?? [],
    });
    const fmt = (v: unknown) => (v === null || v === undefined ? "待完整数据" : String(v));
    const text = [
      "# 效果资料",
      "北京时间每天09:35采集一次；运营复盘，CEO读取。阅读量由董事长告知。",
      "发布当天不纳入前后各3个完整自然日；基线为0不算百分比；下载点击不等于安装。",
      `账号粉丝：${followers.map((f) => `${f.at} ${f.count}（变化${fmt(f.change)}）`).join("；") || "未取得"}`,
    ];
    for (const [business, product] of Object.entries(state.products) as [string, any][]) {
      const current = product.downloadCurrent;
      text.push(
        `\n${business}下载点击：${current ? `${current.day}当前${current.count ?? "未知"}次（未满自然日，起点${current.since ?? "现存日志"}）` : "未知"}；${product.downloadNote}；采集于${product.checkedAt}`,
      );
    }
    for (const p of posts) {
      text.push(
        `\n## ${p.business} · ${p.title ?? p.samples.at(-1)?.title ?? p.remoteId}`,
        `发布：${p.publishedAt}；链接：${p.url}；冻结稿：${p.key}；${p.attribution}`,
        `正文前100字：${p.excerpt ?? "冻结稿缺失，需读取原稿"}`,
      );
      for (const s of p.samples)
        text.push(
          `${s.at}：赞${s.likes} / 藏${s.collects} / 评论${s.comments}；变化${s.change ? `${s.change.likes}/${s.change.collects}/${s.change.comments}` : "首次基线"}`,
        );
      text.push(
        `董事长提供：${
          (leadership.manualMetrics ?? [])
            .filter((r) => r.publication === p.key || r.publication.startsWith(p.key + ":"))
            .map(
              (r) =>
                `${metricText(r)}（${r.source}，${r.at}，事件${r.event}，${r.publication.endsWith(":x") ? "X" : "原平台"}）`,
            )
            .join("；") || "尚未告知"
        }`,
      );
      if (p.product)
        for (const [label, c] of [
          [p.product.label, p.product.growth],
          ["下载点击", p.product.downloads],
        ] as const)
          text.push(
            `${label}：前${c.before.join("、")}合计${fmt(c.baseline)}；后${c.after.join("、")}合计${fmt(c.result)}；变化${fmt(c.change)}；百分比${c.percent === null ? "不计算" : c.percent.toFixed(1) + "%"}`,
          );
      if (p.product) text.push(p.product.downloadNote);
    }
    if (manual.length) {
      text.push("\n## 董事长自己发的帖子", "仅供运营参考内容效果，不计入员工周目标或备稿统计。");
      for (const p of manual) {
        text.push(
          `\n### ${p.title}`,
          `首次看到：${p.firstSeen}；链接：${p.url}`,
          `董事长提供：${
            (leadership.manualMetrics ?? [])
              .filter((r) => r.publication === "manual:" + p.id)
              .map(metricText)
              .join("；") || "尚未告知"
          }`,
        );
        p.samples.forEach((s, i) => {
          const previous = p.samples[i - 1]?.likes;
          const change = s.likes === null || previous == null ? null : s.likes - previous;
          text.push(`${s.at}：赞${fmt(s.likes)}；变化${i ? fmt(change) : "首次基线"}`);
        });
      }
    }
    writeFileSync(join(folder, "feedback.md"), text.join("\n") + "\n", { mode: 0o600 });
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export const metricNames = { reads: "阅读", likes: "点赞", collects: "收藏", comments: "评论" } as const;
export type MetricField = keyof typeof metricNames;
export type MissingMetric = {
  publication: string;
  title: string;
  platform: string;
  business?: string;
  at: string;
  fields: MetricField[];
  observedAt?: string;
};
export function metricText(value: Partial<Record<MetricField, number>>) {
  return (Object.keys(metricNames) as MetricField[])
    .filter((k) => value[k] !== undefined)
    .map((k) => `${metricNames[k]}${value[k]}`)
    .join(" / ");
}
export function metricCatalog(directory: string): MissingMetric[] {
  const feedback = load(join(directory, "workspace/knowledge/feedback.json"), {});
  const items: MissingMetric[] = [];
  for (const p of publicationResults(directory)) {
    const frozen = load(join(directory, "publications", p.key + ".json"), {});
    const post = feedback.posts?.find((v: any) => v.key === p.key);
    const title = frozenSummary(frozen.artifacts).title ?? post?.title ?? p.remoteId;
    const attempt = feedback.days?.at(-1);
    const failed =
      !p.x &&
      attempt &&
      (attempt.observation?.state !== "ready" || !attempt.observation.notes?.some((n: any) => n.id === p.remoteId));
    const sample = failed ? {} : (post?.samples?.at(-1) ?? {});
    items.push({
      publication: p.key,
      title,
      platform: p.x ? "币安广场" : "小红书",
      business: frozen.business,
      at: p.publishedAt,
      observedAt: failed ? attempt.at : undefined,
      fields: p.x
        ? ["reads", "likes"]
        : (["reads", "likes", "collects", "comments"] as MetricField[]).filter((k) => sample[k] == null),
    });
    if (p.x?.state === "published")
      items.push({
        publication: p.key + ":x",
        title,
        platform: "X",
        business: frozen.business,
        at: p.x.at,
        fields: ["reads", "likes", "comments"],
      });
  }
  for (const p of feedback.manual ?? [])
    items.push({
      publication: "manual:" + p.id,
      title: p.title,
      platform: "小红书手动帖（首次采集）",
      at: p.firstSeen,
      observedAt: p.samples?.at(-1)?.at,
      fields:
        p.samples?.at(-1)?.likes == null
          ? ["reads", "likes", "collects", "comments"]
          : ["reads", "collects", "comments"],
    });
  return [...new Map(items.map((p) => [p.publication, p])).values()];
}
export function missingMetrics(directory: string, metrics: ManualMetric[], now: Date) {
  return metricCatalog(directory)
    .filter((p) => localDay(new Date(p.observedAt ?? p.at)) >= weekOf(now) && localDay(new Date(p.at)) <= localDay(now))
    .map((p) => ({
      ...p,
      fields: p.fields.filter(
        (k) =>
          !metrics.some(
            (m) => m.publication === p.publication && m[k] !== undefined && localDay(new Date(m.at)) >= weekOf(now),
          ),
      ),
    }))
    .filter((p) => p.fields.length);
}
