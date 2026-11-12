import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const storyFields = ["发生时间", "麻烦", "让 AI 怎么做", "结果/数字", "踩坑", "可用证据"] as const;
export type Story = { id: string; text: string };
export function parseStories(text: string): Story[] {
  const cards = [...text.matchAll(/^### (S\d+)\s+[^\n]+\n([\s\S]*?)(?=^### |$(?![\s\S]))/gm)];
  const seen = new Set<string>();
  return cards.flatMap((m) => {
    if (seen.has(m[1])) throw Error("故事卡编号重复");
    seen.add(m[1]);
    const complete = storyFields.every((field) => {
      const line = m[2].split("\n").find((s) => s.startsWith(`- ${field}：`));
      const value = line?.slice(field.length + 3).trim();
      return !!value && !/^(待填|待补|TODO|\.{3}|…|<.*>)$/i.test(value);
    });
    return complete ? [{ id: m[1], text: m[0].trim() }] : [];
  });
}
export function readStories(directory: string) {
  const file = join(directory, "workspace/knowledge/ai-stories.md");
  return existsSync(file) ? parseStories(readFileSync(file, "utf8")) : [];
}
