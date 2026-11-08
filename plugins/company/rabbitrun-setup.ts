import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Businesses } from "./business.ts";
import { Operations } from "./operations.ts";
import { ensureBusinessRules } from "./setup.ts";
import { weekOf } from "./workday.ts";
import { rabbitChannel } from "./rabbitrun.ts";

export function setupRabbitrun(directory: string, now = new Date()) {
  const save = (path: string, value: unknown) => {
    writeFileSync(path + ".tmp", JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    renameSync(path + ".tmp", path);
  };
  const file = join(directory, "company.json"),
    config = JSON.parse(readFileSync(file, "utf8"));
  config.dailyModelRuns = { ...config.dailyModelRuns, total: 80, ceo: 20, growth: 60, employee: 20 };
  config.publishPolicies = { ...config.publishPolicies, rabbitrun: { dailyLimit: 1, alwaysConfirm: true } };
  save(file, config);
  const publishingFile = join(directory, "publishing.json");
  const publishing = existsSync(publishingFile) ? JSON.parse(readFileSync(publishingFile, "utf8")) : {};
  publishing.projects ??= {};
  publishing.projects.rabbitrun = {
    channel: rabbitChannel,
    command: ["sudo", "-n", "/usr/local/libexec/company-rabbitrun-publish"],
    timeoutMs: 600000,
  };
  save(publishingFile, publishing);
  const businesses = new Businesses(directory),
    operations = new Operations(directory);
  try {
    if (!businesses.list().some((b) => b.id === "rabbitrun")) {
      businesses.save(
        {
          id: "rabbitrun",
          name: "rabbitrun 币圈内容",
          stage: "operating",
          description:
            "推广 rabbitrun 个人内容账号，不是 App。用 AI Agent 做币圈模拟实验，分享新手避坑和学习记录；不喊单，不推荐买币。",
          audience: "中文币圈新手、对 AI 感兴趣的人及原有 AI 方向关注者",
          objective:
            "每周7篇，每天最多1篇，同一长帖发到X和币安广场；每篇永远先经董事长飞书确认。第一阶段只记录发布回执。",
          channels: "X @rabbitrun_eth + 币安广场 rabbitrun_eth",
          url: "https://x.com/rabbitrun_eth",
        },
        now,
      );
      businesses.autonomy("rabbitrun", true, now);
      businesses.status("rabbitrun", "active", now);
      for (const role of ["product", "engineering", "qa", "growth", "support", "finance"])
        operations.configure(
          "rabbitrun",
          role,
          {
            enabled: role === "growth",
            ...(role === "growth"
              ? {
                  name: "海外运营",
                  duty: "负责 rabbitrun 个人账号的选题、写稿、配图、打包和修改，必读 knowledge/crypto-content-guide.md；只交稿，不接触密钥、不自行发布。",
                  checks: [
                    "内容指南与合规红线",
                    "最近10篇及备稿查重",
                    "事实来源与免责声明",
                    "双平台发布回执与X待发状态",
                  ],
                  cadence: "daily",
                }
              : {}),
          },
          now,
        );
      for (const routine of businesses.get("rabbitrun").routines)
        businesses.routine("rabbitrun", routine.id, false, routine.cadence, now);
      operations.seedWeeklyGoals(
        [
          {
            business: "rabbitrun",
            role: "growth",
            week: weekOf(now),
            direction: "经营rabbitrun个人账号，分享AI币圈模拟实验、新手避坑和学习记录，不喊单",
            metrics: [{ name: "发帖", target: 7, unit: "篇" }],
          },
        ],
        now,
      );
    }
    mkdirSync(join(directory, "workspace/knowledge"), { recursive: true });
    writeFileSync(
      join(directory, "workspace/knowledge/crypto-content-guide.md"),
      readFileSync(new URL("../../examples/recipes/company/crypto-content-guide.md", import.meta.url)),
      { mode: 0o600 },
    );
    ensureBusinessRules(directory);
    // Refresh read-only staff knowledge without dispatching a model or submitting events.
    operations.snapshot(businesses.list(), [], now);
  } finally {
    operations.close();
    businesses.close();
  }
}
