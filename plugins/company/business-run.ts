import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Businesses } from "./business.ts";
import { Company, type Context } from "./company.ts";
const [configFile, contextFile] = process.argv.slice(2);
const office = new Company(JSON.parse(readFileSync(configFile, "utf8")));
const businesses = new Businesses(dirname(configFile));
try {
  const context: Context = JSON.parse(readFileSync(contextFile, "utf8"));
  const batch = createHash("sha256")
    .update(
      JSON.stringify({
        events: context.events.map((e) => e.id).sort((a, b) => a - b),
        answers: context.answers.map((a) => a.card).sort((a, b) => a - b),
      }),
    )
    .digest("hex");
  const receipt = businesses.plan(batch, office.tasks());
  process.stdout.write(`经营周期已检查。\n\n\`\`\`agent-autoloop\n${JSON.stringify(receipt)}\n\`\`\`\n`);
} finally {
  businesses.close();
  office.close();
}
