import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Company, taskId, taskRequest } from "../plugins/company/company.ts";
import { initialize, ensureBusinessRules } from "../plugins/company/setup.ts";
import { hubClient } from "../protocol/client.ts";

const hubCLI = resolve(import.meta.dirname, "../bin/agent-autoloop.ts");
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const json = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const environment = (directory: string) => ({
  ...process.env,
  AGENT_AUTOLOOP_HOME: join(directory, "hub"),
  AGENT_AUTOLOOP_RULES: join(directory, "hub/rules.json"),
});
export async function companyCLI(args: string[]) {
  const [command, given, ...rest] = args;
  if (!given || !command || command === "help") {
    console.log(
      "用法：agent-company init <新目录> [codex|claude] [端口]\n" +
        "      agent-company start|web <目录> [网页端口]\n" +
        "      agent-company up|status|ceo <目录>\n" +
        "      agent-company feishu <目录> <本人 open_id>\n" +
        "      agent-company submit <目录> <任务编号> <需求.json>\n" +
        "      agent-company retry <目录> <任务编号> [请求编号]\n" +
        "      agent-company show|history <目录> <任务编号>\n" +
        "      agent-company answer <目录> <卡片编号> <选项序号，从1开始>",
    );
    return;
  }
  const directory = resolve(given);
  if (command === "init") {
    const agent = rest[0] ?? "codex";
    if (agent !== "codex" && agent !== "claude") throw new Error("Agent 只能是 codex 或 claude");
    const port = Number(rest[1] ?? 3360);
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("端口需要在 1024–65535 之间");
    const rules = initialize(directory, "local", agent);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(directory, "hub"), { mode: 0o700 });
    writeFileSync(join(directory, "hub/rules.json"), JSON.stringify(rules, null, 2) + "\n", { mode: 0o600 });
    const key = (kind: string, name: string) =>
      execFileSync(process.execPath, [hubCLI, "key", "new", kind, name], {
        env: environment(directory),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const config = {
      url: `http://127.0.0.1:${port}`,
      hub: { listen: `127.0.0.1:${port}` },
      worker: { name: "local", key: key("worker", "local"), capacity: 2 },
      source: { name: "company-inbox", key: key("source", "company-inbox") },
      owner: key("owner", "owner"),
    };
    writeFileSync(join(directory, "hub/config.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    console.log(`公司已创建：${directory}\n启动：npm run company -- up ${JSON.stringify(directory)}`);
    return;
  }
  if (command === "ceo") {
    ensureBusinessRules(directory);
    const file = join(directory, "company.json"),
      config = read(file);
    config.ceoMode = true;
    writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    const { Operations } = await import("../plugins/company/operations.ts");
    const operations = new Operations(directory);
    try {
      operations.leadership(true);
    } finally {
      operations.close();
    }
    console.log("CEO 管理已启用；重启公司服务后生效。");
    return;
  }
  if (command === "feishu") {
    const user = rest[0];
    if (!/^ou_[A-Za-z0-9]+$/.test(user ?? "")) throw new Error("需要本人飞书 open_id");
    const file = join(directory, "hub/config.json"),
      config = read(file),
      rulesFile = join(directory, "hub/rules.json"),
      rules = read(rulesFile);
    config.channels ??= {};
    rules.channels ??= {};
    const old = config.channels["company-feishu"];
    const key =
      old?.key ??
      execFileSync(process.execPath, [hubCLI, "key", "new", "channel", "company-feishu"], {
        env: environment(directory),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    config.channels["company-feishu"] = { use: "company", key, user, stateFile: join(directory, "feishu-state.json") };
    rules.channels["company-feishu"] = { name: "CEO 飞书", answerers: [user] };
    writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    writeFileSync(rulesFile, JSON.stringify(rules, null, 2) + "\n", { mode: 0o600 });
    console.log("CEO 飞书通道已配置；重启公司服务后生效。");
    return;
  }
  if (command === "web" || command === "start") {
    if (command === "start" && !existsSync(directory)) await companyCLI(["init", directory]);
    if (command === "start") ensureBusinessRules(directory);
    const port = Number(rest[0] ?? 3361);
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("端口需要在 1024–65535 之间");
    const { startDashboard } = await import("./company-dashboard.ts");
    let child: ReturnType<typeof spawn> | undefined;
    const dashboard = await startDashboard(directory, port, { publicOrigin: process.env.AGENT_COMPANY_PUBLIC_ORIGIN });
    try {
      if (command === "start") {
        const config = read(join(directory, "hub/config.json"));
        const reachable = await fetch(config.url + "/healthz", { signal: AbortSignal.timeout(1500) })
          .then((r) => r.ok)
          .catch(() => false);
        if (!reachable) {
          child = spawn(process.execPath, [hubCLI, "up"], { env: environment(directory), stdio: "inherit" });
          child.on("error", (error) => console.error(`任务引擎启动失败：${error.message}`));
          child.on("exit", (code) => {
            if (code) console.error(`任务引擎已退出（${code}），工作台保留只读视图。`);
          });
        }
      }
      console.log(`公司工作台：${dashboard.url}`);
      await new Promise<void>((done) => {
        const stop = () => {
          process.off("SIGTERM", stop);
          process.off("SIGINT", stop);
          done();
        };
        process.on("SIGTERM", stop);
        process.on("SIGINT", stop);
      });
    } finally {
      await dashboard.close();
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((done) => child!.once("exit", done));
      }
    }
    return;
  }
  if (command === "up") {
    ensureBusinessRules(directory);
    const child = spawn(process.execPath, [hubCLI, "up"], { env: environment(directory), stdio: "inherit" });
    const stop = () => child.kill("SIGTERM");
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    try {
      const code = await new Promise<number | null>((done, reject) => {
        child.once("error", reject);
        child.once("exit", done);
      });
      if (code) throw new Error(`中台退出：${code}`);
    } finally {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
    }
    return;
  }
  if (["status", "show", "history"].includes(command)) {
    const company = new Company(read(join(directory, "company.json")));
    try {
      if (command === "show") {
        const task = company.task(taskId(rest[0] ?? ""));
        if (!task) throw new Error("任务不存在");
        json(task);
      } else if (command === "history") json(company.history(taskId(rest[0] ?? "")));
      else {
        const tasks = company
          .tasks()
          .map((t) => ({ id: t.id, title: t.title, status: t.status, assignments: t.assignment, reason: t.reason }));
        const config = read(join(directory, "hub/config.json"));
        try {
          const state = await hubClient(config.url, config.owner).state();
          json({ tasks, cards: state.cards, spending: state.spending });
        } catch {
          json({ tasks, hub: "离线；这里只显示公司已保存的任务状态" });
        }
      }
    } finally {
      company.close();
    }
    return;
  }
  const config = read(join(directory, "hub/config.json"));
  if (command === "answer") {
    const card = Number(rest[0]),
      choice = Number(rest[1]);
    if (!Number.isSafeInteger(card) || card < 1 || !Number.isSafeInteger(choice) || choice < 1 || choice > 5)
      throw new Error("需要卡片编号和选项序号（从 1 开始）");
    json(await hubClient(config.url, config.owner).answer(card, { choice: choice - 1 }));
    return;
  }
  if (command !== "submit" && command !== "retry") throw new Error("未知命令，运行 npm run company -- help");
  const id = taskId(rest[0] ?? "");
  const data = command === "submit" ? taskRequest(read(resolve(rest[1] ?? ""))) : {};
  const eventId =
    command === "submit" ? `company:create:${id}` : `company:retry:${id}:${taskId(rest[1] ?? randomUUID())}`;
  const response = await hubClient(config.url, config.source.key).event({
    id: eventId,
    type: command === "submit" ? "company.task.create" : "company.task.retry",
    subject: id,
    detail: JSON.stringify(data),
  });
  if (!response.routed?.length) throw new Error("事件已记录，但公司规则未接单；检查 hub/rules.json");
  json(response);
}
