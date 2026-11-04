import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Company } from "./company.ts";
const [configFile, contextFile] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configFile, "utf8"));
const company = new Company(config);
try {
  const context = JSON.parse(readFileSync(contextFile, "utf8"));
  const receipt = company.process(context);
  if (
    config.ceoMode &&
    Math.max(0, ...context.events.map((e: any) => e.hops ?? 0)) < 8 &&
    context.events.some((e: any) => e.type === "company.result" || e.type === "company.task.failed")
  ) {
    receipt.events ??= [];
    receipt.events.push({
      id: `company:progress:${createHash("sha256")
        .update(
          context.events
            .map((e: any) => e.id)
            .sort((a: number, b: number) => a - b)
            .join("-"),
        )
        .digest("hex")
        .slice(0, 24)}`,
      type: "company.business.wake",
      subject: "company",
      summary: "处理员工结果",
      detail: "{}",
    });
  }
  process.stdout.write(`公司任务状态已更新。\n\n\`\`\`agent-autoloop\n${JSON.stringify(receipt)}\n\`\`\`\n`);
} finally {
  company.close();
}
