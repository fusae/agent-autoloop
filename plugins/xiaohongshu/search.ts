import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { xhsApi } from "./publisher.ts";
export type SearchNote = { title: string; likes: number; url: string };
export type SearchEvidence = { status: "有平台证据" | "无平台证据" | "证据获取失败"; notes: SearchNote[] };
export const failedEvidence = (): SearchEvidence => ({ status: "证据获取失败", notes: [] });
export function searchNotes(raw: any): SearchEvidence {
  if (!Array.isArray(raw?.feeds)) throw Error("缺少搜索列表");
  const notes: SearchNote[] = [];
  const seen = new Set<string>();
  for (const feed of raw.feeds) {
    const card = feed?.noteCard,
      value = String(card?.interactInfo?.likedCount ?? "");
    const match = /^(\d+(?:\.\d+)?)(万|w|k)?\+?$/i.exec(value);
    const likes = match
      ? Number(match[1]) * (/万|w/i.test(match[2] ?? "") ? 10000 : /k/i.test(match[2] ?? "") ? 1000 : 1)
      : NaN;
    if (
      !/^[a-f0-9]{24}$/.test(feed?.id) ||
      seen.has(feed.id) ||
      typeof card?.displayTitle !== "string" ||
      !card.displayTitle.trim() ||
      !Number.isFinite(likes) ||
      likes < 100
    )
      continue;
    seen.add(feed.id);
    notes.push({
      title: card.displayTitle.slice(0, 100),
      likes,
      url: `https://www.xiaohongshu.com/explore/${feed.id}`,
    });
  }
  notes.sort((a, b) => b.likes - a.likes);
  return { status: notes.length >= 2 ? "有平台证据" : "无平台证据", notes: notes.slice(0, 3) };
}
export async function searchXhs(
  config: { endpoint: string; token: string },
  directory: string,
  request: any,
  call = xhsApi(config, 45_000),
  now = new Date(),
): Promise<SearchEvidence> {
  if (
    !request ||
    request.action !== "search" ||
    Object.keys(request).some((k) => !["action", "keyword"].includes(k)) ||
    typeof request.keyword !== "string" ||
    !request.keyword.trim() ||
    request.keyword.length > 80 ||
    /[\r\n\x00-\x1f]/.test(request.keyword)
  )
    throw Error("只允许关键词搜索");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const shared = join(directory, "..", "xiaohongshu-publications");
  mkdirSync(shared, { recursive: true, mode: 0o700 });
  const lock = join(shared, "publisher.lock"),
    file = join(directory, "search-budget.json");
  try {
    mkdirSync(lock);
  } catch {
    return failedEvidence();
  }
  try {
    const date = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
    const previous = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    const used = previous.date === date ? previous.used : 0;
    if (used >= 15 || now.getTime() - (previous.at ?? 0) < 5000) return failedEvidence();
    // Reserve before touching the browser: failures and process death consume the request.
    writeFileSync(file, JSON.stringify({ date, used: used + 1, at: now.getTime() }), { mode: 0o600 });
    return searchNotes(await call(`/api/v1/feeds/search?keyword=${encodeURIComponent(request.keyword.trim())}`));
  } catch {
    return failedEvidence();
  } finally {
    rmSync(lock, { recursive: true });
  }
}
