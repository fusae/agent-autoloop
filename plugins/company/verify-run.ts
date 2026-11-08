import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Company, taskId } from "./company.ts";
import { verifyPublication, verificationDelay } from "./verification.ts";
const [configFile, contextFile] = process.argv.slice(2),
  directory = dirname(configFile);
const config = JSON.parse(readFileSync(configFile, "utf8")),
  context = JSON.parse(readFileSync(contextFile, "utf8"));
const office = new Company(config),
  events: any[] = [],
  later: any[] = [];
try {
  const inputs = [
    ...context.events
      .filter((e: any) => e.source === "company-office" && e.type === "company.work.verify")
      .map((e: any) => ({ ...JSON.parse(e.detail), task: e.subject, attempt: 0 })),
    ...(context.timers ?? []).map((t: any) => JSON.parse(t.about)),
  ];
  for (const input of inputs) {
    const task = office.tasks().find((t) => t.id === taskId(input.task));
    if (
      config.publishVerification !== "program" ||
      !task ||
      task.kind !== "publish-content" ||
      task.stage !== 1 ||
      task.status !== "active" ||
      task.assignment !== input.assignment ||
      task.publication !== input.publication
    )
      continue;
    const timer = `verify-${task.id}-${task.assignment}`;
    let result: ReturnType<typeof verifyPublication>;
    try {
      result = verifyPublication(directory, task.publication!);
    } catch {
      result = { state: "unknown", reason: "只读核验暂时失败" };
    }
    const delay = verificationDelay(input.attempt);
    if (result.state === "unknown" && delay !== undefined) {
      later.push({
        key: timer,
        at: new Date(Date.now() + delay).toISOString(),
        about: JSON.stringify({ ...input, attempt: input.attempt + 1 }),
      });
      continue;
    }
    const artifact = `tasks/${task.id}/verification.json`;
    if (result.state === "verified") {
      mkdirSync(join(directory, "workspace/tasks", task.id), { recursive: true });
      writeFileSync(
        join(directory, "workspace", artifact),
        JSON.stringify({ ...result, assignment: task.assignment, checkedAt: new Date().toISOString() }, null, 2),
        { mode: 0o600 },
      );
    }
    events.push({
      id: `${task.id}:${task.assignment}:verified`,
      type: "company.result",
      subject: task.id,
      summary: result.state === "verified" ? "程序回读核验通过" : result.reason,
      detail: JSON.stringify({
        assignment: task.assignment,
        verdict: result.state === "verified" ? "pass" : "blocked",
        summary:
          result.state === "verified"
            ? "receiptOnly" in result
              ? "币安官方发布回执已登记；X 状态单独跟踪，本阶段不抓取效果数据"
              : "程序已核对作者、标题、正文、图片数和发布时间，进入效果观察"
            : result.reason,
        artifacts: result.state === "verified" ? [artifact] : [],
        evidence: [
          "receiptOnly" in result
            ? "仅核对已登记的官方发布回执，不代表回读平台正文"
            : "独立只读通道回读平台；未执行发布",
        ],
        ...(result.state === "verified" ? { publication: result.proof } : {}),
      }),
    });
  }
  process.stdout.write(`程序核验结束。\n\n\`\`\`agent-autoloop\n${JSON.stringify({ events, later })}\n\`\`\`\n`);
} finally {
  office.close();
}
