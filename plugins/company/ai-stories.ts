import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const storyFields = ["发生时间", "麻烦", "让 AI 怎么做", "结果/数字", "踩坑", "可用证据"] as const;
export const networkStoryFields = [
  "来源类型",
  "来源链接",
  "原作者/平台",
  "发布日期",
  "核心做法",
  "结果/数字",
  "可借鉴点",
  "证据",
] as const;
export const networkStoryRules =
  "网络素材不能写成董事长本人经历；用‘我看到…’‘有人分享…’‘官方刚上线…’等说法；数字只能引用原文；不搬运原文段落，用自己的话讲做法和看法；正文不放外链。";
export type Story = { id: string; text: string; source?: "network" };
export function parseStories(text: string): Story[] {
  const cards = [...text.matchAll(/^### (S\d+)\s+[^\n]+\n([\s\S]*?)(?=^### |$(?![\s\S]))/gm)];
  const seen = new Set<string>();
  return cards.flatMap((m) => {
    if (seen.has(m[1])) throw Error("故事卡编号重复");
    seen.add(m[1]);
    const network = /^- 来源类型：\s*网络\s*$/m.test(m[2]);
    const complete = (network ? networkStoryFields : storyFields).every((field) => {
      const line = m[2].split("\n").find((s) => s.startsWith(`- ${field}：`));
      const value = line?.slice(field.length + 3).trim();
      return !!value && !/^(待填|待补|TODO|\.{3}|…|<.*>)$/i.test(value);
    });
    return complete ? [{ id: m[1], text: m[0].trim(), ...(network ? { source: "network" as const } : {}) }] : [];
  });
}
export function readStories(directory: string) {
  const file = join(directory, "workspace/knowledge/ai-stories.md");
  return existsSync(file) ? parseStories(readFileSync(file, "utf8")) : [];
}
