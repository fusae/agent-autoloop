import type { RecentPost } from "./recent-posts.ts";

// Shared acquisition copy and platform tags do not identify a story angle.
const prose = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/#[^#\n]*\[话题\]#/gu, "")
    .replace(/#[\p{L}\p{N}_]+/gu, "")
    .replace(/\[[^\]\n]*r\]/gi, "")
    .replace(/目前只有安卓版，感兴趣的读者评论区聊[。！!]?/g, "");
const normalize = (s: string) => prose(s).replace(/[^\p{L}\p{N}]/gu, "");
const concepts: [string, RegExp][] = [
  [
    "小说改写降难度",
    /(?:改写|改成|改简单|降低|降到)[^。\n]{0,35}(?:难度|水平|简单|能读|看得懂)|(?:长句|难词)[^。\n]{0,15}(?:短|换)/u,
  ],
  ["通勤阅读", /通勤|上班路上|地铁[^。\n]{0,15}读/u],
  [
    "原文改写对比",
    /(?:原文|原版)[^。\n]{0,45}(?:对比|对照)|(?:对比|对照)[^。\n]{0,45}(?:原文|原版)|图\s*2[^。\n]{0,35}(?:改写|版本|第一段)/u,
  ],
  [
    "生词查词打断剧情",
    /(?:生词|查词|查字典|查完字典|词不认识)[^。\n]{0,30}(?:多|剧情|停|忘)|(?:停|页)[^。\n]{0,15}(?:查词|查[^。\n]{0,8}词)/u,
  ],
  ["持续读下去", /读得下去|接着读|跟着剧情|故事一点没(?:丢|变)/u],
  ["公版书版权", /公版|版权/u],
  ["导入自有书", /导入[^。\n]{0,30}(?:epub|txt|书)|(?:epub|txt)[^。\n]{0,15}导入/u],
  ["AI写代码", /(?:ai|人工智能)[^。\n]{0,12}写[^。\n]{0,8}代码|代码[^。\n]{0,12}(?:ai|人工智能)[^。\n]{0,6}写/u],
  ["原文切换", /切回原文|切换[^。\n]{0,10}原文/u],
  ["生词本复习", /生词本|单词本|间隔重复|遗忘曲线/u],
  ["听书发音", /听书|朗读|跟读|发音/u],
];
export function contentFacts(body: string): Set<string> {
  const text = prose(body),
    facts = new Set<string>();
  for (const m of text.matchAll(/《([^》\n]{1,40})》/gu)) facts.add("书名：" + m[1]);
  for (const name of ["福尔摩斯", "血字的研究", "爱丽丝", "金银岛", "傲慢与偏见"])
    if (text.includes(name)) facts.add("书名：" + name);
  const numeric = text.replace(/三成/g, "30%").replace(/百分之三十/g, "30%");
  for (const m of numeric.matchAll(/\d+(?:\.\d+)?\s*(?:%|页|成|天|周|个月|小时|分钟|元|次|篇)|\b[abc][12]\b/gu))
    facts.add("数字：" + m[0].replace(/\s/g, ""));
  for (const [label, pattern] of concepts) if (pattern.test(text)) facts.add(label);
  return facts;
}
function grams(text: string, n = 4) {
  const chars = [...normalize(text)],
    result = new Set<string>();
  for (let i = 0; i <= chars.length - n; i++) result.add(chars.slice(i, i + n).join(""));
  return result;
}
export function duplicateDetails(content: string, previous: string) {
  const a = contentFacts(content),
    b = contentFacts(previous),
    overlap = [...a].filter((v) => b.has(v));
  const ga = grams(content),
    gb = grams(previous),
    shared = [...ga].filter((v) => gb.has(v));
  const factRatio = overlap.length / Math.max(1, Math.min(a.size, b.size));
  const textRatio = (2 * shared.length) / Math.max(1, ga.size + gb.size);
  // Four independent facts and 60% coverage catch a reworded story; one book or app feature alone does not.
  const factsDuplicate = overlap.length >= 4 && factRatio >= 0.6;
  const textDuplicate = shared.length >= 20 && textRatio >= 0.32;
  return { duplicate: factsDuplicate || textDuplicate, overlap, factRatio, textRatio, factsDuplicate, textDuplicate };
}
export function checkContentDuplicates(content: string, recent: RecentPost[]): string[] {
  return recent.flatMap((post) => {
    const d = duplicateDetails(content, post.content);
    if (!d.duplicate) return [];
    const date = new Date(Date.parse(post.publishedAt) + 8 * 3600000).toISOString().slice(0, 10);
    const points = [...d.overlap];
    if (d.textDuplicate) points.push(`正文字符4-gram相似度${Math.round(d.textRatio * 100)}%（阈值32%）`);
    if (d.factsDuplicate) points.push(`关键事实重合${Math.round(d.factRatio * 100)}%（阈值60%，至少4项）`);
    return [`与《${post.title}》（${date}）重复：重合点：${points.join("、")}`];
  });
}
