import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { publication, type Publication } from "./publication.ts";
import type { CompanyConfig } from "./company.ts";

export type PublishApproval = {
  key: string;
  about: string;
  state: "pending" | "approved" | "deferred";
  round: number;
  nextAt?: string;
  answer?: string;
  card?: number;
};
export type PublishReservation = { key: string; channel: string; at: string };
export const publishDay = (date: Date) => new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
export const nextPublishDay = (date: Date) =>
  new Date(Date.parse(`${publishDay(date)}T00:00:00+08:00`) + 86400_000).toISOString();
export function validatePublishPolicy(config: Partial<CompanyConfig>) {
  if (config.publishVerification !== undefined && !["qa", "program"].includes(config.publishVerification))
    throw Error("发布核验配置无效");
  if (
    config.publishDailyLimit !== undefined &&
    (!Number.isSafeInteger(config.publishDailyLimit) || config.publishDailyLimit < 0)
  )
    throw Error("每日发布上限须为非负整数");
  if (
    config.publishApproval !== undefined &&
    (!config.publishApproval ||
      !Number.isSafeInteger(config.publishApproval.confirmFirst) ||
      config.publishApproval.confirmFirst < 0)
  )
    throw Error("发布前确认篇数须为非负整数");
}
export function publicationChannel(directory: string, business: string): string | undefined {
  const path = join(directory, "publishing.json");
  if (!existsSync(path)) return;
  const channel = JSON.parse(readFileSync(path, "utf8")).projects?.[business]?.channel;
  return typeof channel === "string" && channel.trim() ? channel : undefined;
}
export function publicationResults(directory: string): Publication[] {
  const path = join(directory, "publications");
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((name) => /^[a-f0-9]{32}-result\.json$/.test(name))
    .map((name) => {
      const proof = publication(JSON.parse(readFileSync(join(path, name), "utf8")));
      if (name !== `${proof.key}-result.json`) throw Error("发布回执编号不一致");
      return proof;
    });
}
export function publicationUsage(
  results: Publication[],
  reservations: PublishReservation[],
  channel: string,
  now: Date,
) {
  const completed = results.filter((p) => p.channel === channel);
  const pending = new Set(
    reservations.filter((r) => r.channel === channel && !completed.some((p) => p.key === r.key)).map((r) => r.key),
  );
  return {
    successes: completed.length,
    today: completed.filter((p) => publishDay(new Date(p.publishedAt)) === publishDay(now)).length,
    pending: pending.size,
  };
}
export function publicationPreview(directory: string, key: string, business: string): string {
  if (!/^[a-f0-9]{32}$/.test(key)) throw Error("发布记录编号不正确");
  const request = JSON.parse(readFileSync(join(directory, "publications", `${key}.json`), "utf8"));
  const xhs = request.artifacts.find((a: any) => /(^|\/)xiaohongshu\.json$/.test(a.path));
  const draft = xhs
    ? JSON.parse(xhs.content)
    : { title: "已审核正文", content: request.artifacts.map((a: any) => a.content).join("\n"), images: [] };
  if (typeof draft.title !== "string" || typeof draft.content !== "string" || !Array.isArray(draft.images))
    throw Error("已审核稿件缺少标题、正文或图片");
  return `APP：${business}\n标题：${draft.title}\n正文：${draft.content}\n图片数：${draft.images.length}\n只发布本次已冻结的审核稿；可补充文字意见。\n发布稿件：${key}`;
}
