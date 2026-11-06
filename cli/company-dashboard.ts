import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { join, resolve, sep } from "node:path";
import { Company, departments, taskId, taskRequest, workflows, type Task } from "../plugins/company/company.ts";
import { sourceSnapshots } from "../plugins/company/sources.ts";
import { Operations } from "../plugins/company/operations.ts";
import { Businesses } from "../plugins/company/business.ts";

const assets = resolve(import.meta.dirname, "../plugins/company/dashboard");
class HTTPError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const publicTask = ({ approval: _approval, ...task }: Task) => task;
async function body(req: IncomingMessage) {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new HTTPError(415, "请求需要使用 JSON");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 12_000) throw new HTTPError(413, "内容过长，请精简后提交");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw 0;
    return value;
  } catch {
    throw new HTTPError(400, "内容格式不正确");
  }
}
export async function startDashboard(directory: string, port = 3361, options: { publicOrigin?: string } = {}) {
  const publicOrigin = options.publicOrigin;
  if (publicOrigin && (new URL(publicOrigin).protocol !== "https:" || new URL(publicOrigin).origin !== publicOrigin))
    throw new Error("公开工作台地址必须是 HTTPS 来源，不含路径");
  const companyConfig = JSON.parse(readFileSync(join(directory, "company.json"), "utf8"));
  const config = JSON.parse(readFileSync(join(directory, "hub/config.json"), "utf8"));
  const company = new Company(companyConfig);
  const businesses = new Businesses(directory);
  const operations = new Operations(directory);
  const csrf = randomBytes(32).toString("hex");
  let origin = "";
  async function hub(path: string, data?: unknown, source = false) {
    let response: Response;
    try {
      response = await fetch(config.url + path, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${source ? config.source.key : config.owner}`,
          "content-type": "application/json",
        },
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: AbortSignal.timeout(2500),
        redirect: "error",
      });
    } catch {
      throw new HTTPError(503, "任务引擎未连接，请启动公司服务后再试");
    }
    if (!response.ok)
      throw new HTTPError(
        response.status === 401 ? 503 : response.status,
        response.status === 401 ? "任务引擎连接配置不匹配" : "操作未完成，任务状态可能已更新，请刷新后重试",
      );
    return response.json();
  }
  const server = createServer(async (req, res) => {
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    try {
      const publicNavigation =
        publicOrigin && req.method === "GET" && req.url === "/" && req.headers["sec-fetch-mode"] === "navigate";
      if (
        req.headers.host !== new URL(origin).host ||
        (req.headers["sec-fetch-site"] === "cross-site" && !publicNavigation)
      )
        throw new HTTPError(403, "请从本机工作台访问");
      const url = new URL(req.url ?? "/", origin);
      if (req.method === "GET") {
        const staticFiles: Record<string, [string, string]> = {
          "/": ["index.html", "text/html"],
          "/app.js": ["app.js", "text/javascript"],
          "/style.css": ["style.css", "text/css"],
        };
        if (Object.hasOwn(staticFiles, url.pathname)) {
          const [file, mime] = staticFiles[url.pathname];
          res.writeHead(200, { "Content-Type": mime + "; charset=utf-8" });
          res.end(readFileSync(join(assets, file)));
          return;
        }
        if (url.pathname === "/api/session") return send(200, { csrf, remote: !!publicOrigin });
        if (url.pathname === "/api/overview") {
          let state: any = null,
            connectionError: string | null = null;
          try {
            state = await hub("/v1/state");
          } catch (error) {
            connectionError = (error as Error).message;
          }
          const tasks = company.tasks().map(publicTask);
          return send(200, {
            name: companyConfig.name,
            maxAssignments: companyConfig.maxAssignments,
            contentReview: companyConfig.ceoMode ? (companyConfig.contentReview ?? "qa") : "qa",
            dailyPlanning: !!companyConfig.dailyPlanning && !!companyConfig.ceoMode,
            connected: !!state,
            connectionError,
            at: new Date().toISOString(),
            departments,
            workflows,
            tasks,
            businesses: businesses.list(),
            operations: operations.snapshot(businesses.list(), company.tasks()),
            leadership: operations.executive(),
            sources: Object.values(sourceSnapshots(directory)).map((s) => ({
              business: s.business,
              status: s.status,
              checkedAt: s.attemptedAt,
              nextAt: s.nextAt,
              errors: [s.release.error, s.database.error, s.repositories.error].filter(Boolean),
            })),
            channels: state?.channels ?? [],
            cards: (state?.cards ?? []).map((c: any) => ({
              id: c.id,
              kind: c.kind,
              title: c.title,
              text: c.text,
              options: c.options ?? [],
            })),
            agents: state?.agents ?? [],
            runs: state?.runs ?? [],
            spending: state?.spending ?? null,
          });
        }
        const match = /^\/api\/tasks\/([A-Za-z0-9_-]+)(\/artifact)?$/.exec(url.pathname);
        if (match) {
          const task = company.task(taskId(match[1]));
          if (!task) throw new HTTPError(404, "任务不存在");
          if (match[2]) {
            const path = url.searchParams.get("path") ?? "";
            if (!task.reports.some((report) => report.artifacts.includes(path)))
              throw new HTTPError(403, "只能查看本任务已登记的交付物");
            const workspace = realpathSync(join(directory, "workspace"));
            const file = resolve(workspace, path);
            if (!file.startsWith(workspace + sep)) throw new HTTPError(403, "交付物必须位于工作区内");
            if (!existsSync(file)) throw new HTTPError(404, "交付文件尚不存在");
            const actual = realpathSync(file);
            if (!actual.startsWith(workspace + sep)) throw new HTTPError(403, "交付物链接超出了工作区");
            if (!statSync(actual).isFile() || statSync(actual).size > 512_000)
              throw new HTTPError(413, "仅支持预览 500 KB 以内的文本文件");
            const content = readFileSync(actual, "utf8");
            if (content.includes("\0")) throw new HTTPError(415, "该文件不是可预览的文本");
            return send(200, { path, content });
          }
          return send(200, {
            task: publicTask(task),
            history: company.history(task.id).map((row) => ({
              seq: row.seq,
              kind: row.kind,
              at: row.at,
              task: publicTask(JSON.parse(row.body as string)),
            })),
          });
        }
      }
      if (req.method === "POST") {
        if (
          ![origin, ...(publicOrigin ? [publicOrigin] : [])].includes(req.headers.origin ?? "") ||
          req.headers["x-company-csrf"] !== csrf
        )
          throw new HTTPError(403, "页面已失效，请刷新后重试");
        const data = await body(req);
        if (url.pathname === "/api/businesses") {
          if (data.autonomy !== undefined && typeof data.autonomy !== "boolean")
            throw new HTTPError(400, "员工自主工作配置不正确");
          const result = businesses.save(data);
          if (data.autonomy !== undefined) businesses.autonomy(result.id, data.autonomy);
          return send(200, businesses.get(result.id));
        }
        const businessAction =
          /^\/api\/businesses\/([A-Za-z0-9_-]+)\/(status|routine|metrics|autonomy|employee|signal|settings)$/.exec(
            url.pathname,
          );
        if (businessAction) {
          const [, id, operation] = businessAction;
          businesses.get(id);
          if (operation === "autonomy") return send(200, businesses.autonomy(id, data.enabled));
          if (operation === "employee") return send(200, operations.configure(id, data.role, data));
          if (operation === "signal") return send(200, operations.signal(id, data));
          if (operation === "settings") return send(200, operations.settings(id, data));
          if (operation === "metrics") return send(200, businesses.metric(id, data));
          if (operation === "routine")
            return send(200, businesses.routine(id, data.routineId, data.enabled, data.cadence));
          if (data.status === "active") await hub("/v1/state");
          const result = businesses.status(id, data.status);
          let wakeError: string | null = null;
          if (data.status === "active") {
            try {
              const wake = await hub(
                "/v1/events",
                { id: `business:wake:${id}:${randomUUID()}`, type: "company.business.wake", subject: id, detail: "{}" },
                true,
              );
              if (!wake.routed?.length) wakeError = "经营已启用，但巡检规则未接单；请使用 company start 重启公司。";
            } catch {
              wakeError = "经营已启用，暂时无法立即派工；引擎恢复后由定期巡检接续。";
            }
          }
          return send(200, { ...result, wakeError });
        }
        if (url.pathname === "/api/tasks") {
          const id = taskId(data.id ?? `TASK-${randomUUID().replaceAll("-", "")}`);
          const request = taskRequest(data);
          const result = await hub(
            "/v1/events",
            { id: `company:create:${id}`, type: "company.task.create", subject: id, detail: JSON.stringify(request) },
            true,
          );
          if (!result.routed?.length) throw new HTTPError(409, "需求已记录，但没有可用的公司派工规则");
          return send(200, { id, accepted: true, duplicate: !!result.duplicate });
        }
        const retry = /^\/api\/tasks\/([A-Za-z0-9_-]+)\/retry$/.exec(url.pathname);
        if (retry) {
          const id = taskId(retry[1]);
          const task = company.task(id);
          if (!task || !["blocked", "rejected"].includes(task.status))
            throw new HTTPError(409, "只有受阻或退回的任务可以重试");
          const requestId = taskId(data.requestId);
          const result = await hub(
            "/v1/events",
            { id: `company:retry:${id}:${requestId}`, type: "company.task.retry", subject: id, detail: "{}" },
            true,
          );
          if (!result.routed?.length) throw new HTTPError(409, "重试已记录，但没有可用的派工规则");
          return send(200, { accepted: true });
        }
        const answer = /^\/api\/cards\/(\d+)\/answer$/.exec(url.pathname);
        if (answer) {
          const state = await hub("/v1/state");
          const card = state.cards.find((c: any) => c.id === Number(answer[1]));
          if (!card || card.kind !== "ask") throw new HTTPError(409, "这项审批已处理，请刷新页面");
          if (typeof data.text === "string") {
            const text = data.text.trim();
            if (!text || text.length > 4000) throw new HTTPError(400, "回复需要 1–4000 字");
            return send(200, await hub(`/v1/cards/${answer[1]}/answer`, { text }));
          }
          if (!Number.isInteger(data.choice) || data.choice < 0 || data.choice >= card.options.length)
            throw new HTTPError(400, "请选择有效的审批选项");
          return send(200, await hub(`/v1/cards/${answer[1]}/answer`, { choice: data.choice }));
        }
      }
      throw new HTTPError(404, "没有找到这个页面");
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      send(error instanceof HTTPError ? error.status : 400, {
        error: error instanceof Error ? error.message : "操作失败",
      });
    }
  });
  try {
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", done);
    });
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  } catch (error) {
    company.close();
    businesses.close();
    operations.close();
    throw error;
  }
  return {
    url: origin,
    close: () =>
      new Promise<void>((done, reject) => {
        server.close((error) => {
          company.close();
          businesses.close();
          operations.close();
          error ? reject(error) : done();
        });
        server.closeIdleConnections();
      }),
  };
}
