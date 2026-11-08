import { existsSync, readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
  if (config.publishPolicies !== undefined) {
    if (!config.publishPolicies || Array.isArray(config.publishPolicies) || typeof config.publishPolicies !== "object")
      throw Error("业务发布规则无效");
    for (const [business, policy] of Object.entries(config.publishPolicies))
      if (
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(business) ||
        !policy ||
        !Number.isSafeInteger(policy.dailyLimit) ||
        policy.dailyLimit < 0 ||
        typeof policy.alwaysConfirm !== "boolean"
      )
        throw Error("业务发布规则需要每日上限和逐篇确认开关");
  }
  if (config.publishApproval?.preview !== undefined && typeof config.publishApproval.preview !== "boolean")
    throw Error("发布预告开关不正确");
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
export function businessPublishPolicy(config: Partial<CompanyConfig>, business: string) {
  const policy = config.publishPolicies?.[business];
  return {
    publishDailyLimit: policy?.dailyLimit ?? config.publishDailyLimit,
    publishApproval: config.publishApproval,
    alwaysConfirm: policy?.alwaysConfirm === true,
  };
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
  const xhs = request.artifacts.find((a: any) => /(^|\/)(xiaohongshu|rabbitrun)\.json$/.test(a.path));
  const draft = xhs
    ? JSON.parse(xhs.content)
    : { title: "已审核正文", content: request.artifacts.map((a: any) => a.content).join("\n"), images: [] };
  if (typeof draft.title !== "string" || typeof draft.content !== "string" || !Array.isArray(draft.images))
    throw Error("已审核稿件缺少标题、正文或图片");
  const platforms =
    request.business === "rabbitrun"
      ? "\n平台：X @rabbitrun_eth + 币安广场 rabbitrun_eth；同文双发，标题为正文第一行。每篇均需董事长确认。\nX 待发，请手动发布。"
      : "";
  return `${request.business === "rabbitrun" ? "业务" : "APP"}：${business}\n标题：${draft.title}\n正文：${draft.content}\n图片数：${draft.images.length}${platforms}\n只发布本次已冻结的审核稿；可补充文字意见。\n发布稿件：${key}`;
}

export type PublishPreview = { key: string; about: string; createdAt: string; publishAt: string };
export function previewEnabled(config: Partial<CompanyConfig>, successes: number) {
  return config.publishApproval?.preview === true && successes >= Math.max(5, config.publishApproval.confirmFirst);
}
export function publicationTeaser(directory: string, key: string, business: string, at: string) {
  publicationPreview(directory, key, business);
  const request = JSON.parse(readFileSync(join(directory, "publications", `${key}.json`), "utf8"));
  const xhs = request.artifacts.find((a: any) => /(^|\/)xiaohongshu\.json$/.test(a.path));
  const draft = xhs
    ? JSON.parse(xhs.content)
    : { title: "已审核正文", content: request.artifacts.map((a: any) => a.content).join("\n") };
  return `${request.business === "rabbitrun" ? "业务" : "APP"}：${business}\n标题：${draft.title}\n正文：${Array.from(
    draft.content as string,
  )
    .slice(0, 200)
    .join(
      "",
    )}\n预计发布时间：${new Date(at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}（北京时间）\n一小时内可取消；送达延迟则顺延，未取消由固定程序发布。`;
}
// Read only hub facts: a delayed callback must still cancel before a publisher starts.
export function previewDelivery(directory: string, preview: PublishPreview) {
  const file = join(directory, "hub/hub.db");
  if (!existsSync(file)) return { deliveredAt: undefined, cancelled: false };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT data FROM projections WHERE collection='cards' AND json_extract(data,'$.agent')='company-business' AND json_extract(data,'$.grp')='company-business' AND json_extract(data,'$.about')=? ORDER BY json_extract(data,'$.id') DESC LIMIT 1",
      )
      .get(preview.about);
    if (!row) return { deliveredAt: undefined, cancelled: false };
    const card = JSON.parse(row.data as string);
    const fact = db
      .prepare(
        "SELECT json_extract(fact,'$.at') AS at FROM facts, json_each(fact,'$.changes') AS change WHERE json_extract(change.value,'$.table')='deliveries' AND json_extract(change.value,'$.row.card_id')=? AND json_extract(change.value,'$.row.channel')='company-feishu' AND json_extract(change.value,'$.row.ref') IS NOT NULL ORDER BY seq LIMIT 1",
      )
      .get(card.id);
    const deliveredAt = fact ? new Date(fact.at as number).toISOString() : undefined;
    const deadline = Math.max(
      Date.parse(preview.publishAt),
      deliveredAt ? Date.parse(deliveredAt) + 3600_000 : Infinity,
    );
    return {
      card: card.id as number,
      deliveredAt,
      cancelled:
        card.state === "decided" &&
        (card.choice === 0 || card.answer?.trim() === "取消") &&
        Date.parse(card.decided_at) <= deadline,
    };
  } finally {
    db.close();
  }
}
