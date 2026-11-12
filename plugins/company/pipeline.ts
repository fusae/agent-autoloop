import { readFileSync, realpathSync, statSync, existsSync } from "node:fs";
import { join, relative, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import type { Task } from "./company.ts";
import type { Project } from "./operations.ts";
import { metricCatalog } from "./feedback.ts";
import { checkJinzhaoDelivery } from "./jinzhao-writing.ts";
import { rabbitDraft, rabbitChannel } from "./rabbitrun.ts";
import { publicationResults } from "./publication-policy.ts";
import { employeeEntries } from "./reporting.ts";
import { localDay } from "./workday.ts";

export const pipelinePrompt = `内容流水线规范：本节替代旧的CEO审核、选题会、周目标、上班规划和日报要求。只写本轮派发的一篇完整稿件，自行从手册与素材库挑选角度；先读knowledge/pipeline-<业务>.json最近10篇（含手动帖）和在途稿，不能重复选题或换标题复述。交付包增加angle（本篇具体角度）及duplicateCheck:[{publication:最近已发编号,difference:与该篇的具体差别}]，覆盖给定的每一篇。仅交付本地稿，由程序检查，最多退回重写2次，仍不过当天放弃。今朝按固定五份资料一次交齐图文，程序通过直接发董事长确认卡，退回附意见只改一次再确认。rabbitrun读取knowledge/rabbitrun-handbook.md及crypto-content-guide.md，合规检查通过由固定程序发布。不得自行发布、发消息或新增任务。日报由程序生成，不提交dailyReport。按原company.result格式提交结果，保留真实证据。`;

export function recentPipelinePosts(directory: string, business: string) {
  return metricCatalog(directory)
    .filter((p) => (business === "rabbitrun" ? p.platform === "币安广场" : p.platform.startsWith("小红书")))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 10);
}
export function pipelineDraft(directory: string, business: string, paths: string[]) {
  const name = business === "jinzhao" ? "xiaohongshu" : "rabbitrun";
  const selected = paths.filter((p) => new RegExp(`(?:^|/)${name}\\.json$`).test(p));
  if (selected.length !== 1) throw Error(`必须交付唯一的${name}.json`);
  const root = realpathSync(join(directory, "workspace"));
  const path = realpathSync(isAbsolute(selected[0]) ? selected[0] : join(root, selected[0]));
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel) || statSync(path).size > 1_000_000)
    throw Error("稿件必须在工作区内且不超过1MB");
  const content = readFileSync(path, "utf8");
  return {
    path: selected[0],
    content,
    draft: JSON.parse(content),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}
export function checkRabbitCompliance(draft: { title: string; content: string }) {
  const text = `${draft.title}\n${draft.content}`,
    errors: string[] = [];
  if ([...draft.title].length > 20) errors.push("标题不得超过20字");
  const count = [...draft.content.replace(/\s/g, "")].length;
  if (count < 300 || count > 800) errors.push("正文须300–800字");
  const rules: [RegExp, string][] = [
    [/(?:梭哈|必涨|稳赚|稳赚不赔|保本|翻倍|百倍币|买入点|卖出点|目标价|抄底|带单|跟单)/i, "喊单、买卖点位或收益诱导"],
    [
      /(?:建议|推荐|赶紧|现在|值得|应该).{0,12}(?:买入|卖出|加仓|建仓)|(?:买入|卖出|加仓|建仓).{0,12}(?:BTC|ETH|USDT|币|美元|[0-9])/i,
      "推荐具体交易",
    ],
    [
      /(?:返佣|邀请码|邀请链接|推广合作|项目方合作|付费推广)|(?:https?:\/\/\S*[?&](?:ref|referral|invite|code)=)/i,
      "返佣邀请或项目推广",
    ],
    [/(?:收益|盈利|赚了|获利).{0,10}(?:\d+|保证)|(?:保证|承诺|稳定).{0,8}(?:收益|盈利)/i, "承诺收益或展示盈利诱导"],
    [/(?:内幕|小道消息|据传|传闻|听说即将|骗子|诈骗犯)/i, "未经证实消息或人身攻击"],
    [
      /\b(?:0x)?[a-f0-9]{64}\b|(?:私钥|助记词|密码|账户|账号)\s*[:：]\s*\S+|\b(?:[a-z]{3,12}\s+){11,23}[a-z]{3,12}\b/i,
      "秘密或账户信息",
    ],
  ];
  for (const [pattern, reason] of rules) if (pattern.test(text)) errors.push(`合规红线：${reason}`);
  return errors;
}
export function checkPipelineDelivery(directory: string, business: string, paths: string[], requireComparison = true) {
  try {
    const file = pipelineDraft(directory, business, paths),
      d = file.draft;
    const errors =
      business === "jinzhao"
        ? checkJinzhaoDelivery(directory, paths)
        : checkRabbitCompliance(
            rabbitDraft({ key: "a".repeat(32), business, channel: rabbitChannel, action: "lookup", artifacts: [file] }),
          );
    const normalize = (s: string) => s.replace(/[\p{P}\p{Z}\s]/gu, "").toLowerCase();
    const recent = recentPipelinePosts(directory, business);
    for (const p of recent) {
      if (!p.publication.startsWith("manual:")) {
        const frozen = JSON.parse(readFileSync(join(directory, "publications", p.publication + ".json"), "utf8"));
        const previous = frozen.artifacts.find((a: any) => /(?:xiaohongshu|rabbitrun)\.json$/.test(a.path));
        if (previous && normalize(JSON.parse(previous.content).content) === normalize(d.content))
          errors.push(`正文与最近已发重复：${p.title}`);
      }
      if (normalize(d.title) === normalize(p.title)) errors.push(`与最近已发重复：${p.title}`);
      if (
        requireComparison &&
        (!Array.isArray(d.duplicateCheck) ||
          !d.duplicateCheck.some(
            (v: any) =>
              v.publication === p.publication && typeof v.difference === "string" && v.difference.trim().length >= 8,
          ))
      )
        errors.push(`缺少与《${p.title}》的具体角度对照`);
    }
    if (requireComparison && (typeof d.angle !== "string" || d.angle.trim().length < 8))
      errors.push("缺少本篇具体角度angle");
    return errors;
  } catch (error) {
    return [(error as Error).message];
  }
}

export function pipelineDailyReport(
  directory: string,
  date: string,
  tasks: Task[],
  projects: Project[],
  anomalies: string[] = [],
  programReturns: string[] = [],
) {
  const list = (items: string[]) => {
    const text = [...new Set(items)].map((s) => `- ${s}`).join("\n") || "无";
    return text.length > 550 ? text.slice(0, 500) + `\n共${items.length}项，完整记录见后台。` : text;
  };
  const entries = employeeEntries(directory, tasks, "growth", date);
  const catalog = metricCatalog(directory),
    results = publicationResults(directory);
  const title = (key: string) => catalog.find((p) => p.publication === key)?.title ?? key;
  const returns = tasks.flatMap((t) =>
    t.reports
      .filter((r) => r.writingErrors?.length && r.at && localDay(new Date(r.at)) === date)
      .map((r) => `${t.title}：${r.writingErrors!.join("；")}`),
  );
  const written = entries
    .filter((e) =>
      tasks.find((t) => t.id === e.task)?.reports.some((r) => r.assignment === e.assignment && r.verdict === "pass"),
    )
    .map((e) => tasks.find((t) => t.id === e.task)!.title);
  const published = results
    .filter((p) => localDay(new Date(p.publishedAt)) === date)
    .map((p) => `${title(p.key)}：${p.url || "已确认，链接未提供"}`);
  const feedbackFile = join(directory, "workspace/knowledge/feedback.json");
  const feedback = existsSync(feedbackFile) ? JSON.parse(readFileSync(feedbackFile, "utf8")) : {};
  const manual = (feedback.manual ?? [])
    .filter((p: any) => localDay(new Date(p.firstSeen)) === date)
    .map((p: any) => `${p.title}（当天首次采集的手动帖，发帖日期未知）：${p.url}`);
  const pending = projects.flatMap((p) =>
    p.plans.filter((a) => a.status !== "closed" && a.publishApproval?.state === "pending").map((a) => a.title),
  );
  const blocked = projects.flatMap((p) =>
    p.plans.filter((a) => a.status === "blocked").map((a) => `${a.title}：${a.result}`),
  );
  return `日报 ${date}\n\n今天写了什么\n${list(written)}\n\n发了什么\n${list([...published, ...manual])}\n\n程序退回原因\n${list([...returns, ...programReturns])}\n\n待董事长确认\n${list(pending)}\n\nX 待发\n${list(results.filter((p) => p.x && p.x.state !== "published").map((p) => title(p.key)))}\n\n异常\n${list([...blocked, ...anomalies])}`;
}
