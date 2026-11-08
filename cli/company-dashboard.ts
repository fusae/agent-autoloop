import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { join, resolve, sep } from "node:path";
import { Company, departments, taskId, taskRequest, workflows, type Task } from "../plugins/company/company.ts";
import { sourceSnapshots } from "../plugins/company/sources.ts";
import { Operations } from "../plugins/company/operations.ts";
import { Businesses } from "../plugins/company/business.ts";
import { DatabaseSync } from "node:sqlite";
import { modelDay } from "../plugins/company/model-budget.ts";
import { publicationResults } from "../plugins/company/publication-policy.ts";
import type { Publication } from "../plugins/company/publication.ts";
import { draftStock } from "../plugins/company/workday.ts";

const assets = resolve(import.meta.dirname, "../plugins/company/dashboard");
// Owner home page: read-only extras the overview did not carry (quota, promotion results, publications).
function homeData(directory: string, companyConfig: any, operations: any[]) {
  const now = new Date();
  let quota: unknown = null;
  const runsFile = join(directory, "model-runs.db");
  if (companyConfig.dailyModelRuns && existsSync(runsFile)) {
    const date = modelDay(now),
      start = new Date(date + "T00:00:00+08:00").toISOString(),
      end = new Date(Date.parse(start) + 86400_000).toISOString();
    const db = new DatabaseSync(runsFile, { readOnly: true });
    try {
      const count = (kind: string) =>
        Object.fromEntries(
          db
            .prepare("SELECT role,COUNT(*) AS n FROM journal WHERE kind=? AND at>=? AND at<? GROUP BY role")
            .all(kind, start, end)
            .map((r) => [String(r.role), Number(r.n)]),
        );
      const roles = count("started");
      quota = {
        date,
        total: Object.values(roles).reduce((a: number, b) => a + Number(b), 0),
        roles,
        employees: count("employee-started"),
        limits: companyConfig.dailyModelRuns,
        limited: !!db.prepare("SELECT 1 FROM journal WHERE id=?").get(`limited:${date}`),
      };
    } finally {
      db.close();
    }
  }
  let feedback: unknown = null;
  try {
    const file = join(directory, "workspace/knowledge/feedback.json");
    if (existsSync(file)) feedback = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    feedback = null;
  }
  let publications: Publication[] = [];
  try {
    publications = publicationResults(directory);
  } catch {
    publications = [];
  }
  const stock: Record<string, unknown> = {};
  for (const p of operations) {
    const growth = p.staff?.find((s: any) => s.role === "growth");
    if (growth) stock[p.business] = draftStock(p.plans ?? [], growth.weeklyGoal, publications, now);
  }
  return { quota, feedback, publications, stock };
}
class HTTPError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const taskSummary = ({ id, title, kind, status, stage }: Task) => ({ id, title, kind, status, stage });
function pageParams(url: URL, compound = false) {
  for (const key of url.searchParams.keys()) {
    if (!["limit", "before"].includes(key) || url.searchParams.getAll(key).length !== 1)
      throw new HTTPError(400, "分页参数不正确");
  }
  const limit = url.searchParams.get("limit") ?? (compound ? "20" : "50");
  const before = url.searchParams.get("before");
  if (!/^[1-9]\d?$/.test(limit) || Number(limit) > 50) throw new HTTPError(400, "每页数量需要 1–50");
  if (before !== null && !(compound ? /^\d{1,15}\.\d{1,15}\.\d{1,15}$/ : /^[1-9]\d{0,15}$/).test(before))
    throw new HTTPError(400, "分页游标不正确");
  if (before !== null && before.split(".").some((n) => !Number.isSafeInteger(Number(n))))
    throw new HTTPError(400, "分页游标不正确");
  return { limit: Number(limit), before };
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
    const cached = (data: unknown) => {
      const json = JSON.stringify(data);
      const etag = `"${createHash("sha256").update(json).digest("hex")}"`;
      res.setHeader("ETag", etag);
      res.setHeader("Cache-Control", "private, no-cache");
      const matches = req.headers["if-none-match"]?.split(",").map((v) => v.trim().replace(/^W\//, ""));
      if (matches?.includes(etag) || matches?.includes("*")) {
        res.writeHead(304);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(json);
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
          "/home.js": ["home.js", "text/javascript"],
          "/home.css": ["home.css", "text/css"],
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
          const tasks = company.tasks();
          const portfolio = businesses.list();
          const chief = operations.executive();
          const now = new Date();
          const snapshot = operations.snapshot(portfolio, tasks, now, chief);
          const latestReport = chief.eveningReports?.slice().sort((a, b) => b.date.localeCompare(a.date))[0];
          const home = {
            ...homeData(directory, companyConfig, snapshot),
            leadership: { enabled: chief.enabled, openIssues: chief.issues.filter((i) => i.state === "open").length },
            ceoRun:
              (state?.runs ?? [])
                .filter((r: any) => r.agent === "company-ceo" && r.summary)
                .sort((a: any, b: any) =>
                  String(b.finishedAt ?? b.createdAt).localeCompare(String(a.finishedAt ?? a.createdAt)),
                )
                .map(({ state, summary, finishedAt, createdAt }: any) => ({
                  state,
                  summary,
                  finishedAt,
                  createdAt,
                }))[0] ?? null,
            ceoReport: latestReport
              ? {
                  date: latestReport.date,
                  summary: tasks.find((t) => t.id === latestReport.task)?.reports.at(-1)?.summary ?? null,
                }
              : null,
            operations: snapshot.map((p) => ({
              business: p.business,
              workday: p.workday,
              reporting: p.reporting,
              staff: p.staff
                .filter((s) => s.role === "growth" && s.onDuty)
                .map((s) => ({
                  role: s.role,
                  onDuty: s.onDuty,
                  workday: s.workday,
                  daily: s.daily,
                  nextAction: s.nextAction,
                  workStatus: s.workStatus,
                  nextWorkdayAt: s.nextWorkdayAt,
                  reports: (s.reports ?? [])
                    .filter((r) => r.date === modelDay(now))
                    .map((r) => ({ date: r.date, entries: r.entries.slice(-1) })),
                })),
              plans: p.plans
                .filter(
                  (a) => a.owner === "growth" && ["publishing", "delivered", "working", "planned"].includes(a.status),
                )
                .map(({ owner, status, title, publicationKey, publishApproval }) => ({
                  owner,
                  status,
                  title,
                  publicationKey,
                  publishApproval: publishApproval ? { state: publishApproval.state } : undefined,
                })),
            })),
          };
          return cached({
            name: companyConfig.name,
            maxAssignments: companyConfig.maxAssignments,
            contentReview: companyConfig.ceoMode ? (companyConfig.contentReview ?? "qa") : "qa",
            dailyPlanning: !!companyConfig.dailyPlanning && !!companyConfig.ceoMode,
            connected: !!state,
            connectionError,
            departments,
            workflows,
            tasks: tasks.slice(-6).map(taskSummary),
            taskStats: {
              total: tasks.length,
              active: tasks.filter((t) => t.status === "active").length,
              blocked: tasks.filter((t) => ["blocked", "rejected"].includes(t.status)).length,
              done: tasks.filter((t) => t.status === "completed" && !t.kind.startsWith("check-") && t.kind !== "ceo")
                .length,
              checked: tasks.filter((t) => t.kind.startsWith("check-") && t.status === "completed").length,
              departments: Object.fromEntries(
                Object.keys(departments).map((role) => [
                  role,
                  tasks.filter((t) => t.status === "active" && workflows[t.kind]?.[t.stage] === role).length,
                ]),
              ),
            },
            businesses: portfolio,
            home,
            cards: (state?.cards ?? [])
              .filter((c: any) => c.kind === "ask")
              .map((c: any) => ({
                id: c.id,
                kind: c.kind,
                title: c.title,
                text: c.text,
                options: c.options ?? [],
              })),
            agents: (state?.agents ?? []).map(({ id, use, online }: any) => ({ id, use, online })),
            runs: (state?.runs ?? [])
              .filter((r: any) => r.state === "claimed")
              .map(({ id, agent, state }: any) => ({ id, agent, state })),
            spending: state?.spending ?? null,
          });
        }
        if (url.pathname === "/api/tasks") {
          const { limit, before } = pageParams(url);
          const page = company.taskPage(limit, before === null ? undefined : Number(before));
          return cached({ ...page, tasks: page.tasks.map(taskSummary) });
        }
        if (url.pathname === "/api/operations") {
          pageParams(url);
          const tasks = company.tasks();
          return cached({
            operations: operations.snapshot(businesses.list(), tasks).map((p) => ({
              ...p,
              staff: p.staff.map((s) => ({
                ...s,
                currentTask: s.currentTask
                  ? { ...taskSummary(s.currentTask as Task), reason: s.currentTask.reason }
                  : null,
              })),
            })),
            tasks: tasks.map(taskSummary),
          });
        }
        if (url.pathname === "/api/leadership") {
          const { limit, before } = pageParams(url, true);
          const chief = operations.executive();
          const collections = [chief.decisions, chief.issues, chief.knowledge];
          const ends = before === null ? collections.map((a) => a.length) : before.split(".").map(Number);
          if (ends.some((n, i) => n > collections[i].length)) throw new HTTPError(400, "分页游标超出范围");
          const starts = ends.map((n) => Math.max(0, n - limit));
          const latest = chief.lastTask ? company.task(chief.lastTask) : null;
          let channels: any[] = [];
          try {
            channels = (await hub("/v1/state")).channels ?? [];
          } catch (error) {
            if (!(error instanceof HTTPError) || error.status !== 503) throw error;
          }
          return cached({
            leadership: {
              enabled: chief.enabled,
              lastTask: chief.lastTask,
              nextReviewAt: chief.nextReviewAt,
              stalled: chief.stalled ? { reason: chief.stalled.reason } : null,
              briefs: chief.briefs,
              repairs: chief.lastTask ? { [chief.lastTask]: chief.repairs?.[chief.lastTask] } : {},
              latestTask: latest ? taskSummary(latest) : null,
              openIssues: chief.issues.filter((i) => i.state !== "answered").length,
              decisions: chief.decisions
                .slice(starts[0], ends[0])
                .map(({ task, summary, at }) => ({ task, summary, at })),
              issues: chief.issues.slice(starts[1], ends[1]),
              knowledge: chief.knowledge.slice(starts[2], ends[2]),
            },
            sources: Object.values(sourceSnapshots(directory)).map((s) => ({
              business: s.business,
              status: s.status,
              checkedAt: s.attemptedAt,
              nextAt: s.nextAt,
            })),
            channels: channels.map(({ id, online }: any) => ({ id, online })),
            nextBefore: starts.some(Boolean) ? starts.join(".") : null,
          });
        }
        if (url.pathname === "/api/runs") {
          const { limit, before } = pageParams(url);
          const state = await hub("/v1/state" + (before === null ? "" : `?before=${before}`));
          const runs = (state.runs ?? []).sort((a: any, b: any) => b.id - a.id);
          const page = runs.slice(0, limit);
          return cached({
            runs: page.map(({ id, agent, state, summary, error, createdAt, finishedAt }: any) => ({
              id,
              agent,
              state,
              summary,
              error,
              createdAt,
              finishedAt,
            })),
            nextBefore: runs.length > limit || state.nextBefore ? (page.at(-1)?.id ?? null) : null,
            spending: state.spending ?? null,
          });
        }
        // Frozen (already reviewed) drafts: full text plus embedded images, so the owner can judge quality before approving.
        const draft = /^\/api\/publications\/([a-f0-9]{32})(?:\/image\/(\d{1,2}))?$/.exec(url.pathname);
        if (draft) {
          const frozen = join(directory, "publications", `${draft[1]}.json`);
          if (!existsSync(frozen)) throw new HTTPError(404, "没有找到这份稿件");
          const request = JSON.parse(readFileSync(frozen, "utf8"));
          const xhs = (request.artifacts ?? []).find((a: any) => /(^|\/)xiaohongshu\.json$/.test(a.path));
          const parsed = xhs ? JSON.parse(xhs.content) : null;
          const images: { mime: string; base64: string }[] = Array.isArray(parsed?.images) ? parsed.images : [];
          if (draft[2] !== undefined) {
            const image = images[Number(draft[2])];
            if (!image || !/^image\/(png|jpeg|webp)$/.test(image.mime) || typeof image.base64 !== "string")
              throw new HTTPError(404, "没有这张图片");
            res.writeHead(200, { "Content-Type": image.mime });
            res.end(Buffer.from(image.base64, "base64"));
            return;
          }
          return send(200, {
            key: draft[1],
            business: request.business,
            title: typeof parsed?.title === "string" ? parsed.title : "已审核正文",
            content:
              typeof parsed?.content === "string"
                ? parsed.content
                : (request.artifacts ?? []).map((a: any) => String(a.content ?? "")).join("\n\n"),
            images: images.length,
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
          return cached({
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
