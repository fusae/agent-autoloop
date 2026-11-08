import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { xhsApi } from "./publisher.ts";

export type Note = {
  id: string;
  author: string;
  title: string;
  content: string;
  images: number;
  publishedAt: string;
  likes: number;
  collects: number;
  comments: number;
};
export type Observation =
  | { state: "ready"; account: string; followers: number; notes: Note[] }
  | { state: "unknown" | "blocked"; reason: string };
function count(value: unknown): number {
  if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw Error("平台未返回精确计数，不能当作零");
  return Number(value);
}
export async function readXhs(
  config: { endpoint: string; token: string; accountId: string },
  directory: string,
  request: any,
  call = xhsApi(config),
): Promise<Observation> {
  if (
    !request ||
    request.action !== "read" ||
    Object.keys(request).some((k) => !["action", "notes"].includes(k)) ||
    !Array.isArray(request.notes) ||
    request.notes.length > 200 ||
    request.notes.some((id: unknown) => typeof id !== "string" || !/^[a-f0-9]{24}$/.test(id))
  )
    throw Error("只允许读取指定笔记");
  if (!config.accountId) throw Error("只读账号尚未绑定");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const shared = join(directory, "..", "xiaohongshu-publications");
  mkdirSync(shared, { recursive: true, mode: 0o700 });
  const lock = join(shared, "publisher.lock"),
    tokensFile = join(directory, "tokens.json");
  try {
    mkdirSync(lock);
  } catch {
    return { state: "unknown", reason: "同账号读取正在进行" };
  }
  try {
    // API failures fail closed: no next note, no search, and no comment pagination.
    let raw: any, status: any;
    try {
      status = await call("/api/v1/login/status");
      if (status?.is_logged_in !== true) return { state: "blocked", reason: "登录已失效，请本人处理" };
      raw = await call("/api/v1/user/me");
    } catch {
      return { state: "blocked", reason: "账号读取受阻，请检查登录、验证码或平台限制" };
    }
    const profile = raw?.data ?? raw;
    if ((status?.user_id || profile?.userBasicInfo?.userId) !== config.accountId || !Array.isArray(profile.feeds))
      return { state: "blocked", reason: "登录失效、账号不符或平台限制，请本人处理" };
    const followers = count(profile.interactions?.find((v: any) => v.type === "fans")?.count);
    const tokens: Record<string, string> = existsSync(tokensFile) ? JSON.parse(readFileSync(tokensFile, "utf8")) : {};
    for (const f of profile.feeds)
      if (/^[a-f0-9]{24}$/.test(f.id) && typeof f.xsecToken === "string") tokens[f.id] = f.xsecToken;
    writeFileSync(tokensFile + ".tmp", JSON.stringify(tokens), { mode: 0o600 });
    renameSync(tokensFile + ".tmp", tokensFile);
    const notes: Note[] = [];
    for (const id of [...new Set<string>(request.notes)]) {
      if (!tokens[id]) return { state: "unknown", reason: "本人列表尚未提供指定笔记的读取凭据" };
      let response: any;
      try {
        response = await call("/api/v1/feeds/detail", {
          feed_id: id,
          xsec_token: tokens[id],
          load_all_comments: false,
        });
      } catch {
        return { state: "blocked", reason: "笔记读取受阻，请检查登录、验证码或平台限制" };
      }
      const n = response?.data?.note;
      if (!n || n.noteId !== id || n.user?.userId !== config.accountId)
        return { state: "blocked", reason: "笔记不可读或作者不符，请本人处理" };
      if (
        typeof n.title !== "string" ||
        typeof n.desc !== "string" ||
        !Array.isArray(n.imageList) ||
        !Number.isFinite(n.time)
      )
        return { state: "unknown", reason: "平台笔记字段不完整" };
      notes.push({
        id,
        author: n.user.userId,
        title: n.title,
        content: n.desc,
        images: n.imageList.length,
        publishedAt: new Date(n.time).toISOString(),
        likes: count(n.interactInfo?.likedCount),
        collects: count(n.interactInfo?.collectedCount),
        comments: count(n.interactInfo?.commentCount),
      });
    }
    return { state: "ready", account: config.accountId, followers, notes };
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
