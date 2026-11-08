// Text-to-image cards in the style of Xiaohongshu's own "文字配图": plain paper, big bold type,
// one highlighter stroke on the phrase that matters. Pure functions: spec in, standalone HTML out.
// A renderer (headless browser) turns each page into a 1080×1440 PNG.

export type CardSpec = {
  /** Cover headline. Wrap the phrase to highlight in 【】, e.g. "读英文原著总【放弃】？" */
  title: string;
  /** Optional inner pages; each string is one page of body text. Blank lines split paragraphs. */
  pages?: string[];
  /** Theme name; omitted → picked from the title so a series varies but each post is stable. */
  theme?: keyof typeof themes;
};

export const themes = {
  paper: { bg: "#fffdf6", ink: "#2b2b2b", mark: "#c8f08f", soft: "#efe7d6" },
  lemon: { bg: "#fffef9", ink: "#262626", mark: "#ffe66d", soft: "#f1ecd9" },
  sky: { bg: "#f7fbff", ink: "#1f2a33", mark: "#bfe3ff", soft: "#e2edf6" },
  blush: { bg: "#fff9f7", ink: "#2c2422", mark: "#ffd3c4", soft: "#f3e3dd" },
} as const;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function pickTheme(title: string): keyof typeof themes {
  const names = Object.keys(themes) as (keyof typeof themes)[];
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return names[h % names.length];
}

/** 【phrase】 → highlighted span; everything else escaped. */
function marked(text: string) {
  return esc(text).replace(/【([^【】]+)】/g, '<span class="mark">$1</span>');
}

function shell(theme: (typeof themes)[keyof typeof themes], body: string, fonts: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1080px;height:1440px}
body{background:${theme.bg};color:${theme.ink};font-family:${fonts};-webkit-font-smoothing:antialiased;position:relative;overflow:hidden}
.quote{position:absolute;left:96px;top:92px;font-size:220px;line-height:1;font-weight:900;color:${theme.soft};font-family:Georgia,serif}
.cover{position:absolute;left:96px;right:96px;top:0;bottom:160px;display:flex;flex-direction:column;justify-content:center}
.cover h1{font-size:var(--size);line-height:1.42;font-weight:800;letter-spacing:2px;word-break:break-all;text-wrap:balance}
.mark{background:linear-gradient(transparent 58%, ${theme.mark} 58%, ${theme.mark} 94%, transparent 94%);padding:0 4px;white-space:nowrap}
.bar{position:absolute;right:96px;bottom:110px;width:64px;height:14px;background:${theme.soft}}
.page{position:absolute;left:96px;right:96px;top:150px;bottom:150px;display:flex;flex-direction:column;justify-content:center;gap:44px}
.page p{font-size:var(--size);line-height:1.75;font-weight:500;letter-spacing:1px;word-break:break-all;text-wrap:pretty}
.page p.lead{font-weight:800}
.num{position:absolute;right:96px;top:96px;font-size:30px;color:#9a948a;letter-spacing:2px}
</style></head><body>${body}</body></html>`;
}

const FONTS =
  '"PingFang SC","Noto Sans CJK SC","Noto Sans SC","Source Han Sans SC","WenQuanYi Micro Hei","Noto Color Emoji",sans-serif';

/** Headline size shrinks with length so 2–4 lines always fit. */
function coverSize(title: string) {
  const n = Array.from(title.replace(/[【】]/g, "")).length;
  return n <= 12 ? 104 : n <= 20 ? 92 : n <= 28 ? 80 : n <= 40 ? 68 : 58;
}
function pageSize(text: string) {
  const n = Array.from(text).length;
  return n <= 60 ? 52 : n <= 110 ? 46 : n <= 170 ? 40 : 36;
}

export function renderCards(spec: CardSpec, fonts = FONTS): string[] {
  if (!spec.title?.trim()) throw Error("配图缺少标题");
  const pages = (spec.pages ?? []).map((p) => p.trim()).filter(Boolean);
  if (pages.length > 8) throw Error("配图最多 9 张（封面 + 8 页）");
  const theme = themes[spec.theme ?? pickTheme(spec.title)];
  if (!theme) throw Error("配图主题不存在");
  const total = pages.length + 1;
  const cover = shell(
    theme,
    `<div class="quote">“</div><div class="cover"><h1 style="--size:${coverSize(spec.title)}px">${marked(spec.title.trim())}</h1></div><div class="bar"></div>`,
    fonts,
  );
  const inner = pages.map((text, i) => {
    const paras = text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    return shell(
      theme,
      `${total > 1 ? `<div class="num">${i + 2} / ${total}</div>` : ""}<div class="page" style="--size:${pageSize(text)}px">${paras.map((p, j) => `<p class="${j === 0 ? "lead" : ""}">${marked(p).replace(/\n/g, "<br>")}</p>`).join("")}</div><div class="bar"></div>`,
      fonts,
    );
  });
  return [cover, ...inner];
}
