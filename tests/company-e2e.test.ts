// Failure modes: generated company rules work in isolation but not through the real worker, the hop cap prevents final
// approval, or the CLI leaks state outside its isolated home. Fake departments are explicit fixtures, never real models.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Company } from "../plugins/company/company.ts";
import { Operations } from "../plugins/company/operations.ts";
import { Businesses } from "../plugins/company/business.ts";
import { CompanyFeishu } from "../plugins/company/channel.ts";
import { hubClient } from "../protocol/client.ts";

const cli = resolve(import.meta.dirname, "../bin/agent-company.ts");
async function until<T>(get: () => T | Promise<T>, timeout = 120_000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await get();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("公司闭环没有在时限内完成");
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
test(
  "company CLI runs real hub → product → engineering → QA → human approval → archive",
  { timeout: 180_000 },
  async () => {
    const scratch = mkdtempSync(join(tmpdir(), "company-e2e-"));
    const directory = join(scratch, "office"),
      port = await freePort();
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("AGENT_AUTOLOOP_")));
    const run = (...args: string[]) => {
      const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", timeout: 10_000 });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      return result.stdout;
    };
    let up: ReturnType<typeof spawn> | undefined;
    let office: Company | undefined;
    let logs = "";
    try {
      run("init", directory, "codex", String(port));
      const channelKey = spawnSync(
        process.execPath,
        [resolve(import.meta.dirname, "../bin/agent-autoloop.ts"), "key", "new", "channel", "test-chat"],
        {
          env: { ...env, AGENT_AUTOLOOP_HOME: join(directory, "hub") },
          encoding: "utf8",
        },
      );
      assert.equal(channelKey.status, 0, channelKey.stderr);
      const fixture = join(scratch, "department.ts");
      writeFileSync(
        fixture,
        `import {readFileSync} from 'node:fs';
const context=JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT,'utf8'));
if(context.events[0].type==='company.owner.question') {
  const question=JSON.parse(context.events[0].detail).question;
  console.log('业务答复。\\n\\n\`\`\`agent-autoloop\\n'+JSON.stringify({notice:[{key:'owner-answer-'+context.events[0].id,title:'CEO · 业务答复',text:'问题：'+question+'\\n答复：当前没有业务任务；此为测试记录。'}]})+'\\n\`\`\`');
  process.exit(0);
}
const brief=JSON.parse(context.events[0].detail);
const event={id:brief.task+':'+brief.assignment+':result',type:'company.result',subject:brief.task,
 detail:JSON.stringify({assignment:brief.assignment,verdict:'pass',summary:'模拟部门交付',artifacts:['tasks/'+brief.task+'/demo.md'],evidence:['模拟检查通过；非真实业务'],...(brief.inspection?{inspection:{state:brief.role==='growth'?'action':'idle',actions:brief.role==='growth'?[{key:'guide',title:'使用说明',kind:'content',goal:'生成模拟使用说明',acceptance:['仅测试资料'],priority:1,dueDays:2,followUpDays:3,measure:'首次使用人数'}]:[],reviews:[]}}:{})})};
console.log('模拟部门完成。\\n\\n\`\`\`agent-autoloop\\n'+JSON.stringify({events:[event]})+'\\n\`\`\`');`,
      );
      const rulesFile = join(directory, "hub/rules.json");
      const rules = JSON.parse(readFileSync(rulesFile, "utf8"));
      rules.channels["test-chat"] = { name: "模拟飞书", answerers: ["ou_owner"] };
      for (const [id, agent] of Object.entries(rules.agents) as [string, Record<string, unknown>][]) {
        if (id !== "company-office" && id !== "company-business") {
          agent.use = "command";
          agent.command = [process.execPath, fixture];
        }
      }
      writeFileSync(rulesFile, JSON.stringify(rules));
      office = new Company(JSON.parse(readFileSync(join(directory, "company.json"), "utf8")));
      up = spawn(process.execPath, [cli, "up", directory], { env, stdio: ["ignore", "pipe", "pipe"] });
      up.stdout!.on("data", (chunk) => (logs += chunk));
      up.stderr!.on("data", (chunk) => (logs += chunk));
      await until(() =>
        fetch(`http://127.0.0.1:${port}/healthz`)
          .then((r) => r.ok)
          .catch(() => false),
      );
      const config = JSON.parse(readFileSync(join(directory, "hub/config.json"), "utf8"));
      const owner = hubClient(config.url, config.owner);
      const messages: string[][] = [];
      const bridge = new CompanyFeishu(
        join(scratch, "feishu.json"),
        "ou_owner",
        hubClient(config.url, channelKey.stdout.trim()),
        async (args) => {
          messages.push(args);
          return { data: { message_id: "om_reply" } };
        },
        hubClient(config.url, config.source.key).event,
      );
      const question = {
        message_id: "om_question",
        msg_type: "text",
        sender: { id: "ou_owner", sender_type: "user" },
        content: "目前员工在做什么？",
      };
      await bridge.receive([question, question]);
      const reply = await until(async () => (await owner.state()).cards.find((c: any) => c.title === "CEO · 业务答复"));
      // The notice reaches the same delivery path used by real Feishu; no live messages in tests.
      const { companyBriefing } = await import("../plugins/company/briefing.ts");
      const knowledge = companyBriefing(directory);
      assert.equal(knowledge.execution!.conversation.questions.length, 1);
      assert.match(String(knowledge.execution!.conversation.answers[0].text), /目前员工在做什么/);
      await bridge.deliver({
        ...reply,
        ref: null,
        options: [],
        recommend: null,
        choice: null,
        answer: null,
        result: null,
        link: null,
      });
      assert.equal(messages.length, 1);
      assert.match(messages[0][messages[0].indexOf("--text") + 1], /当前没有业务任务/);
      assert.equal(office.tasks().length, 0);
      const request = join(scratch, "request.json");
      writeFileSync(
        request,
        JSON.stringify({ title: "演示闭环", goal: "验证调度和审批", kind: "software", acceptance: ["有模拟检查证据"] }),
      );
      run("submit", directory, "DEMO-1", request);
      run("submit", directory, "DEMO-1", request);
      await until(() => office!.task("DEMO-1")?.status === "awaiting_approval");
      const cfg = JSON.parse(readFileSync(join(directory, "hub/config.json"), "utf8"));
      const card = await until(async () => {
        const state = await (
          await fetch(cfg.url + "/v1/state", { headers: { authorization: `Bearer ${cfg.owner}` } })
        ).json();
        return state.cards.find((c: { kind: string }) => c.kind === "ask");
      });
      assert.equal(office.task("DEMO-1")?.assignment, 3);
      run("answer", directory, String(card.id), "1");
      await until(() => office!.task("DEMO-1")?.status === "completed");
      const history = JSON.parse(run("history", directory, "DEMO-1"));
      assert.equal(history.length, 5);
      assert.deepEqual(
        office.task("DEMO-1")?.reports.map((r) => r.role),
        ["product", "engineering", "qa"],
      );
      assert.match(run("status", directory), /completed/);
      const businesses = new Businesses(directory);
      try {
        businesses.save({
          id: "test-app",
          name: "测试业务",
          description: "用于验证持续经营",
          audience: "测试用户",
          objective: "验证周期派工",
          stage: "operating",
        });
        businesses.status("test-app", "active");
        const response = await fetch(cfg.url + "/v1/events", {
          method: "POST",
          headers: { authorization: `Bearer ${cfg.source.key}`, "content-type": "application/json" },
          body: JSON.stringify({ id: "wake-test", type: "company.business.wake", subject: "test-app", detail: "{}" }),
        });
        assert.equal(response.status, 200);
        await until(
          () => office!.tasks().filter((t) => t.id.startsWith("B-") && t.status === "awaiting_approval").length === 3,
        );
        assert.equal(businesses.list()[0].cycles.length, 3);
        businesses.status("test-app", "paused");
        businesses.autonomy("test-app", true);
        businesses.status("test-app", "active");
        const wake = async (id: string) =>
          fetch(cfg.url + "/v1/events", {
            method: "POST",
            headers: { authorization: `Bearer ${cfg.source.key}`, "content-type": "application/json" },
            body: JSON.stringify({ id, type: "company.business.wake", subject: "test-app", detail: "{}" }),
          });
        await wake("autonomy-first");
        await until(
          () => office!.tasks().filter((t) => t.kind.startsWith("check-") && t.status === "completed").length === 3,
        );
        await wake("autonomy-second");
        await until(
          () => office!.tasks().filter((t) => t.kind.startsWith("check-") && t.status === "completed").length === 6,
        );
        await wake("autonomy-work");
        await until(() => office!.tasks().some((t) => t.kind === "internal-content" && t.status === "completed"));
        const ops = new Operations(directory);
        try {
          await wake("autonomy-followup");
          await until(() =>
            ops.snapshot(businesses.list(), office!.tasks())[0].plans.some((p) => p.status === "observing"),
          );
          assert.equal(ops.snapshot(businesses.list(), office.tasks())[0].plans[0].outcome, null);
        } finally {
          ops.close();
        }
        businesses.status("test-app", "paused");
      } finally {
        businesses.close();
      }
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${logs}`, { cause: error });
    } finally {
      if (up && up.exitCode === null) {
        up.kill("SIGTERM");
        await new Promise((r) => up!.once("exit", r));
      }
      office?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

// A CEO question must wake the business coordinator on reply, then reach staff without another owner command.
test(
  "CEO receives owner knowledge through the hub and gives employees project objectives",
  { timeout: 120_000 },
  async () => {
    const scratch = mkdtempSync(join(tmpdir(), "company-ceo-e2e-")),
      directory = join(scratch, "office"),
      port = await freePort();
    const env = Object.fromEntries(Object.entries(process.env).filter(([n]) => !n.startsWith("AGENT_AUTOLOOP_")));
    const run = (...args: string[]) => {
      const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", timeout: 10_000 });
      assert.equal(r.status, 0, r.stderr);
    };
    let up: ReturnType<typeof spawn> | undefined,
      office: Company | undefined,
      ops: Operations | undefined,
      b: Businesses | undefined,
      logs = "";
    try {
      run("init", directory, "codex", String(port));
      run("ceo", directory);
      const fixture = join(scratch, "ceo.ts");
      writeFileSync(
        fixture,
        `import {readFileSync} from 'node:fs';
const ctx=JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT,'utf8')),brief=JSON.parse(ctx.events[0].detail);
let extra={inspection:{state:'idle',actions:[],reviews:[]}};
if(brief.role==='ceo') {
 const facts=JSON.parse(readFileSync('knowledge/ceo.json','utf8'));
 const informed=facts.knowledge.some(k=>k.source==='owner');
 extra={executive:{briefs:informed?[{business:'app',objective:'依据负责人提供的报表核对新增用户'}]:[],directives:[],approvals:[],answers:informed?facts.issues.filter(i=>i.state==='open').map(i=>({issue:i.id,answer:'数据在本机报表，先核对新增用户',evidence:'负责人答复'})):[],escalations:informed?[]:[{key:'onboarding',issues:facts.issues.map(i=>i.id),question:'数据在哪里？',context:'业务档案缺少数据入口'}]}};
}
const report={assignment:brief.assignment,verdict:'pass',summary:'模拟管理结果',artifacts:[],evidence:['测试资料'],...extra};
console.log('\`\`\`agent-autoloop\\n'+JSON.stringify({events:[{id:brief.task+':'+brief.assignment+':result',type:'company.result',subject:brief.task,detail:JSON.stringify(report)}]})+'\\n\`\`\`');`,
      );
      const file = join(directory, "hub/rules.json"),
        rules = JSON.parse(readFileSync(file, "utf8"));
      for (const [id, a] of Object.entries(rules.agents) as [string, any][])
        if (!["company-office", "company-business"].includes(id)) {
          a.use = "command";
          a.command = [process.execPath, fixture];
        }
      writeFileSync(file, JSON.stringify(rules));
      office = new Company(JSON.parse(readFileSync(join(directory, "company.json"), "utf8")));
      ops = new Operations(directory);
      b = new Businesses(directory);
      b.save({
        id: "app",
        name: "APP",
        description: "测试提醒",
        audience: "测试",
        objective: "提升使用",
        stage: "operating",
      });
      b.autonomy("app", true);
      b.status("app", "active");
      up = spawn(process.execPath, [cli, "up", directory], { env, stdio: ["ignore", "pipe", "pipe"] });
      up.stdout!.on("data", (c) => (logs += c));
      up.stderr!.on("data", (c) => (logs += c));
      await until(() =>
        fetch(`http://127.0.0.1:${port}/healthz`)
          .then((r) => r.ok)
          .catch(() => false),
      );
      const cfg = JSON.parse(readFileSync(join(directory, "hub/config.json"), "utf8"));
      const { hubClient } = await import("../protocol/client.ts");
      const owner = hubClient(cfg.url, cfg.owner),
        source = hubClient(cfg.url, cfg.source.key);
      const wake = (id: string) => source.event({ id, type: "company.business.wake", subject: "app", detail: "{}" });
      await wake("ceo-start");
      await until(() => office!.tasks().some((t) => t.kind === "ceo" && t.status === "completed"));
      await wake("ceo-consume");
      const card = await until(async () => (await owner.state()).cards.find((c: any) => c.kind === "ask"));
      await owner.answer(card.id, { text: "数据在本机报表，先核对新增用户" });
      await until(() => ops!.executive().knowledge.some((k) => k.source === "owner"));
      // The next independent clock tick starts work with a fresh hop budget.
      await wake("clock-after-answer");
      await until(() => office!.tasks().filter((t) => t.kind === "ceo" && t.status === "completed").length === 2);
      assert.equal(ops.executive().knowledge[0].source, "owner");
      await wake("ceo-decisions");
      await until(() => office!.tasks().some((t) => t.kind.startsWith("check-") && t.status === "completed"));
      assert.match(ops.executive().briefs.app, /新增用户/);
      assert.ok(ops.executive().issues.every((i) => i.state === "answered"));
      const profile = JSON.parse(readFileSync(join(directory, "workspace/knowledge/operations/app.json"), "utf8"));
      assert.ok(profile.knowledge.some((k: any) => k.source === "owner"));
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${logs}`, { cause: error });
    } finally {
      if (up && up.exitCode === null) {
        up.kill("SIGTERM");
        await new Promise((r) => up!.once("exit", r));
      }
      office?.close();
      ops?.close();
      b?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
