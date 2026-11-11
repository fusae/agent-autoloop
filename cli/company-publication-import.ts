// Run against a private snapshot first; this imports metadata without invoking a publishing adapter.
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Company } from "../plugins/company/company.ts";
import { importPublicationAttempts } from "../plugins/company/publication-recovery.ts";
const file = process.argv[2];
if (!file || process.argv.length !== 3) throw Error("需要私有公司配置文件路径");
const office = new Company(JSON.parse(readFileSync(file, "utf8")));
try {
  console.log(JSON.stringify({ imported: importPublicationAttempts(dirname(file), office) }));
} finally {
  office.close();
}
