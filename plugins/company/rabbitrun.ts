import { createHash } from "node:crypto";

export const rabbitChannel = "rabbitrun · 币安广场 + X";
export type RabbitDraft = { title: string; content: string; images: { mime: string; base64: string }[] };
export type RabbitRequest = {
  key: string;
  business: string;
  channel: string;
  action: string;
  artifacts: { path: string; content: string; sha256: string }[];
};
export type XReceipt = {
  state: "pending" | "claimed" | "failed" | "published";
  attempts: number;
  at: string;
  url?: string;
  remoteId?: string;
  reason?: "login" | "verification" | "risk" | "failed" | "unknown";
};
export function rabbitDraft(request: RabbitRequest): RabbitDraft {
  if (
    request.business !== "rabbitrun" ||
    request.channel !== rabbitChannel ||
    !/^[a-f0-9]{32}$/.test(request.key) ||
    !["lookup", "publish"].includes(request.action)
  )
    throw Error("rabbitrun 发布请求无效");
  const files = request.artifacts.filter((a) => /(^|\/)rabbitrun\.json$/.test(a.path));
  if (files.length !== 1) throw Error("需要唯一的 rabbitrun.json 已审核稿");
  const file = files[0];
  if (
    Buffer.byteLength(file.content) > 1_000_000 ||
    createHash("sha256").update(file.content).digest("hex") !== file.sha256
  )
    throw Error("稿件与审核内容不一致");
  const draft = JSON.parse(file.content) as RabbitDraft;
  if (
    typeof draft.title !== "string" ||
    !draft.title.trim() ||
    draft.title.length > 120 ||
    /[\r\n]/.test(draft.title) ||
    typeof draft.content !== "string" ||
    !draft.content.trim() ||
    [...draft.content].length > 10000 ||
    !Array.isArray(draft.images) ||
    draft.images.length > 4
  )
    throw Error("稿件需要标题、正文和0–4张图片");
  for (const image of draft.images) {
    if (!image || !["image/png", "image/jpeg", "image/webp"].includes(image.mime) || typeof image.base64 !== "string")
      throw Error("图片格式无效");
    const b = Buffer.from(image.base64, "base64");
    const valid =
      image.mime === "image/png"
        ? b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
        : image.mime === "image/jpeg"
          ? b[0] === 255 && b[1] === 216 && b[2] === 255
          : b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP";
    if (!valid || b.toString("base64") !== image.base64) throw Error("图片内容无效");
  }
  return draft;
}
export const rabbitText = (draft: RabbitDraft) =>
  draft.content.split(/\r?\n/, 1)[0] === draft.title ? draft.content : `${draft.title}\n\n${draft.content}`;
export function xReceipt(value: unknown): XReceipt {
  const x = value as XReceipt;
  if (
    !x ||
    !["pending", "claimed", "failed", "published"].includes(x.state) ||
    !Number.isSafeInteger(x.attempts) ||
    x.attempts < 0 ||
    x.attempts > 2 ||
    !Number.isFinite(Date.parse(x.at))
  )
    throw Error("X 发布状态无效");
  if (
    x.state === "published" &&
    (x.url !== undefined || x.remoteId !== undefined) &&
    (!/^[0-9]{1,30}$/.test(x.remoteId ?? "") || x.url !== `https://x.com/rabbitrun_eth/status/${x.remoteId}`)
  )
    throw Error("X 回执必须属于 rabbitrun_eth");
  if (x.reason !== undefined && !["login", "verification", "risk", "failed", "unknown"].includes(x.reason))
    throw Error("X 失败原因无效");
  return {
    state: x.state,
    attempts: x.attempts,
    at: x.at,
    ...(x.state === "published" && x.url ? { url: x.url, remoteId: x.remoteId } : {}),
    ...(x.reason ? { reason: x.reason } : {}),
  };
}
export function xStatus(x: XReceipt) {
  return x.state === "published" ? `X 已发${x.url ? "：" + x.url : ""}` : "X 待发，请手动发布";
}
export const manualXNotice = (key: string) => `X 待发，请手动发布\n发布稿件：${key}`;
export const manualXKey = (card: { kind: string; text: string }) =>
  card.kind === "notice" ? /^X 待发，请手动发布\n发布稿件：([a-f0-9]{32})$/.exec(card.text)?.[1] : undefined;
export function pendingXReminder(results: { x?: XReceipt; publishedAt: string }[], date: string) {
  const pending = results.filter(
    (p) =>
      p.x &&
      p.x.state !== "published" &&
      new Date(Date.parse(p.publishedAt) + 8 * 3600000).toISOString().slice(0, 10) < date,
  );
  return pending.length ? `\n\nX 还有 ${pending.length} 篇待手动发布，发布后请点原卡片“我已在 X 发布”。` : "";
}
