import { readFileSync } from "node:fs";
import { Company } from "./company.ts";
const [configFile, contextFile] = process.argv.slice(2);
const company = new Company(JSON.parse(readFileSync(configFile, "utf8")));
try {
  const receipt = company.process(JSON.parse(readFileSync(contextFile, "utf8")));
  process.stdout.write(`公司任务状态已更新。\n\n\`\`\`agent-autoloop\n${JSON.stringify(receipt)}\n\`\`\`\n`);
} finally {
  company.close();
}
