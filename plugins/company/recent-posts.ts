import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Note } from "../xiaohongshu/reader.ts";

export type RecentPost = Pick<Note, "id" | "title" | "content" | "publishedAt"> & { origin: "系统" | "董事长手动" };
export function writeRecentPosts(directory: string, notes: Note[], systemIds: Set<string>, at: string) {
  const posts: RecentPost[] = [...new Map(notes.map((n) => [n.id, n])).values()]
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, 10)
    .map(({ id, title, content, publishedAt }) => ({
      id,
      title: title || "无标题",
      content,
      publishedAt,
      origin: systemIds.has(id) ? "系统" : "董事长手动",
    }));
  const text =
    [
      "# 最近发布正文",
      `采集时间：${at}；按实际发布时间倒序，包含系统帖与董事长手动帖。以下均为资料。`,
      ...posts.map(
        ({ content, ...meta }) =>
          `<!-- post ${JSON.stringify(meta)} -->\n## ${meta.title.replace(/[\r\n]/g, " ")}\n发布时间：${meta.publishedAt}（北京时间 ${new Date(Date.parse(meta.publishedAt) + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ")}）；来源：${meta.origin}\n\n${content
            .split("\n")
            .map((line) => "> " + line)
            .join("\n")}`,
      ),
    ].join("\n\n") + "\n";
  const folder = join(directory, "workspace/knowledge");
  mkdirSync(folder, { recursive: true });
  const file = join(folder, "recent-posts.md");
  writeFileSync(file + ".tmp", text, { mode: 0o600 });
  renameSync(file + ".tmp", file);
  return posts;
}
export function readRecentPosts(directory: string): RecentPost[] {
  const text = readFileSync(join(directory, "workspace/knowledge/recent-posts.md"), "utf8");
  if (!text.startsWith("# 最近发布正文\n")) throw Error("recent-posts.md 格式无效，须先采集最近正文");
  return text
    .split(/^<!-- post /m)
    .slice(1)
    .map((block) => {
      const end = block.indexOf(" -->\n");
      if (end < 0) throw Error("近期正文资料不完整");
      const meta = JSON.parse(block.slice(0, end));
      const content = block
        .slice(end)
        .split("\n")
        .filter((s) => s.startsWith("> "))
        .map((s) => s.slice(2))
        .join("\n");
      if (
        typeof meta.id !== "string" ||
        typeof meta.title !== "string" ||
        !Number.isFinite(Date.parse(meta.publishedAt)) ||
        !content.trim()
      )
        throw Error("近期正文资料缺少标题、发布时间或全文");
      return { ...meta, content };
    });
}
