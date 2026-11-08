import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync, chownSync, statSync } from "node:fs";
import { join } from "node:path";
import { durableSave } from "../binance-square/publisher.ts";
import { rabbitChannel, rabbitDraft, rabbitText, xReceipt, type RabbitRequest } from "./rabbitrun.ts";

export function approvedRabbitRequest(directory: string, key: string, action: "lookup" | "publish"): RabbitRequest {
  if (!/^[a-f0-9]{32}$/.test(key)) throw Error("审核编号无效");
  const db = new DatabaseSync(join(directory, "operations.db"), { readOnly: true });
  let approval;
  try {
    const row = db.prepare("SELECT body FROM projects WHERE id='rabbitrun'").get();
    const project = row ? JSON.parse(row.body as string) : null;
    approval = project?.plans.find(
      (p: any) => p.publicationKey === key && p.deliveryDecision === "publish",
    )?.publishApproval;
    if (!approval || approval.key !== key || approval.state !== "approved" || !Number.isSafeInteger(approval.card))
      throw Error("本篇尚无董事长确认");
  } finally {
    db.close();
  }
  const hub = new DatabaseSync(join(directory, "hub/hub.db"), { readOnly: true });
  try {
    const row = hub
      .prepare("SELECT data FROM projections WHERE collection='cards' AND json_extract(data,'$.id')=?")
      .get(approval.card);
    const card = row ? JSON.parse(row.data as string) : null;
    if (
      !card ||
      card.about !== approval.about ||
      card.kind !== "ask" ||
      card.agent !== "company-business" ||
      card.grp !== "company-business" ||
      !["decided", "done", "closed"].includes(card.state) ||
      !(card.choice === 0 || (card.choice === null && card.answer?.trim() === "发布"))
    )
      throw Error("董事长确认卡尚未有效答复");
  } finally {
    hub.close();
  }
  const request = JSON.parse(readFileSync(join(directory, "publications", key + ".json"), "utf8"));
  if (request.key !== key || request.business !== "rabbitrun") throw Error("审核稿不匹配");
  const result = { ...request, channel: rabbitChannel, action };
  rabbitDraft(result);
  return result;
}
export function rabbitQueue(directory: string, stateDirectory: string, input: any, now = new Date()) {
  if (!input || !["list", "claim", "complete", "fail"].includes(input.action)) throw Error("X 窄命令无效");
  if (!existsSync(stateDirectory))
    return input.action === "list"
      ? []
      : (() => {
          throw Error("没有待发稿");
        })();
  const lock = join(stateDirectory, "publisher.lock");
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    throw Error("发布记录正在更新，请稍后核对");
  }
  try {
    const keys = readdirSync(stateDirectory).filter((f) => /^[a-f0-9]{32}\.json$/.test(f));
    if (input.action === "list")
      return keys.flatMap((file) => {
        const saved = JSON.parse(readFileSync(join(stateDirectory, file), "utf8"));
        if (
          !saved.proof?.x ||
          saved.proof.x.state === "published" ||
          !existsSync(join(directory, "publications", saved.proof.key + "-result.json"))
        )
          return [];
        const request = approvedRabbitRequest(directory, saved.proof.key, "lookup");
        const draft = rabbitDraft(request);
        return [{ key: request.key, title: draft.title, images: draft.images.length, x: xReceipt(saved.proof.x) }];
      });
    const request = approvedRabbitRequest(directory, input.key, "lookup"),
      draft = rabbitDraft(request);
    const file = join(stateDirectory, input.key + ".json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (!saved.proof?.x || saved.proof.key !== input.key) throw Error("币安尚未确认发布，X 不可发送");
    const x = xReceipt(saved.proof.x);
    if (input.action === "claim") {
      if (!existsSync(join(directory, "publications", input.key + "-result.json"))) throw Error("币安回执尚未登记");
      if (x.state !== "pending") throw Error("此稿已被领取或失败；先核对现有结果，禁止自动重复发送");
      const day = (s: string) => new Date(Date.parse(s) + 8 * 3600000).toISOString().slice(0, 10);
      if (
        keys.some((f) => {
          const v = JSON.parse(readFileSync(join(stateDirectory, f), "utf8")).proof?.x;
          return (
            f !== input.key + ".json" &&
            v &&
            (v.state === "claimed" ||
              v.state === "failed" ||
              (v.state === "published" && day(v.at) === day(now.toISOString())))
          );
        })
      )
        throw Error("X 今日已发或上篇结果仍待核对，每天最多一篇");
      saved.proof.x = { state: "claimed", attempts: x.attempts + 1, at: now.toISOString() };
    } else if (input.action === "complete") {
      const match = /^https:\/\/x\.com\/rabbitrun_eth\/status\/(\d{1,30})$/.exec(input.url ?? "");
      if (!match || !["claimed", "failed", "published"].includes(x.state))
        throw Error("需已领取稿件和本人账号的帖子链接");
      if (x.state === "published") {
        if (x.url !== input.url) throw Error("不可覆盖已发布结果");
      }
      if (
        keys.some(
          (f) =>
            f !== input.key + ".json" &&
            JSON.parse(readFileSync(join(stateDirectory, f), "utf8")).proof?.x?.url === input.url,
        )
      )
        throw Error("该帖子链接已登记在另一稿件");
      saved.proof.x = xReceipt({
        ...x,
        state: "published",
        at: x.state === "published" ? x.at : now.toISOString(),
        url: input.url,
        remoteId: match[1],
        reason: undefined,
      });
    } else {
      if (x.state !== "claimed" && !(x.state === "failed" && x.reason === input.reason))
        throw Error("只能标记当前已领取稿件失败");
      saved.proof.x = xReceipt({
        ...x,
        state: "failed",
        at: x.state === "failed" ? x.at : now.toISOString(),
        reason: input.reason,
      });
    }
    durableSave(file, saved);
    // The public receipt is a projection; publisher-owned state remains authoritative for X claims.
    const target = join(directory, "publications", input.key + "-result.json");
    const owner = statSync(join(directory, "publications"));
    durableSave(target, saved.proof);
    if (process.getuid?.() === 0) chownSync(target, owner.uid, owner.gid);
    return input.action === "claim"
      ? { key: input.key, text: rabbitText(draft), images: draft.images, x: saved.proof.x }
      : { key: input.key, x: saved.proof.x };
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
