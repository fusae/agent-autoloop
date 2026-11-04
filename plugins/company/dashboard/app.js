const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const names = {
  active: "进行中",
  awaiting_approval: "待审批",
  blocked: "受阻",
  rejected: "已退回",
  completed: "已完成",
};
const roleNames = {
  product: "产品",
  engineering: "研发",
  qa: "验收",
  growth: "运营",
  support: "客服",
  finance: "财务",
};
const roleInfo = {
  product: ["◈", "把想法变成明确的需求"],
  engineering: ["⌘", "构建产品，交付可运行代码"],
  qa: ["✓", "独立检查每一项交付"],
  growth: ["↗", "内容、活动与增长方案"],
  support: ["♧", "整理反馈，准备客户回复"],
  finance: ["◴", "核对账目，梳理预算"],
};
const routes = {
  software: ["product", "engineering", "qa"],
  content: ["growth", "qa"],
  support: ["support", "qa"],
  finance: ["finance", "qa"],
};
const kindNames = { software: "产品研发", content: "内容运营", support: "客户服务", finance: "财务分析" };
const labels = {
  businesses: "业务管理",
  overview: "公司概览",
  tasks: "任务列表",
  approvals: "审批",
  departments: "部门",
  spending: "费用",
};
let live = null,
  demo = null,
  isDemo = false,
  csrf = "",
  filter = "all",
  search = "",
  view = "businesses",
  pending = 0,
  draftId = "",
  lastRefresh = 0,
  refreshing = false,
  renderedState = "";
const data = () => (isDemo ? demo : live);
const signature = ({ at, ...state }) => JSON.stringify(state);
const badge = (status) => `<span class="badge ${esc(status)}">${esc(names[status] ?? status)}</span>`;
const time = (value) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
const cost = (stats) =>
  !stats || (stats.rounds > 0 && stats.missingCost === stats.rounds) ? "—" : `$${Number(stats.cost ?? 0).toFixed(2)}`;
function toast(message, error = false) {
  const node = $("#toast");
  node.textContent = message;
  node.hidden = false;
  node.classList.toggle("error", error);
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (node.hidden = true), 4500);
}
async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json", "X-Company-CSRF": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "操作未完成，请重试");
  return result;
}
function demoData() {
  const base = {
    goal: "完成一项有明确结果、可独立验收的交付。",
    acceptance: ["交付文件完整", "有实际检查依据"],
    reports: [],
    reason: "",
    assignment: 1,
  };
  const tasks = [
    { ...base, id: "DEMO-001", title: "品牌官网首页改版", kind: "software", status: "active", stage: 1, assignment: 2 },
    {
      ...base,
      id: "DEMO-002",
      title: "十一月内容选题与发布计划",
      kind: "content",
      status: "awaiting_approval",
      stage: 1,
      assignment: 2,
      reason: "10 个选题与内容草稿已完成核验",
    },
    { ...base, id: "DEMO-003", title: "客户常见问题与回复手册", kind: "support", status: "active", stage: 0 },
    {
      ...base,
      id: "DEMO-004",
      title: "本月经营收支分析",
      kind: "finance",
      status: "blocked",
      stage: 0,
      reason: "缺少本月支出凭证，需要补充资料",
    },
    {
      ...base,
      id: "DEMO-005",
      title: "本地周报生成器",
      kind: "software",
      status: "completed",
      stage: 2,
      assignment: 3,
      reason: "交付已接受",
    },
    {
      ...base,
      id: "DEMO-006",
      title: "用户反馈归类与改进建议",
      kind: "support",
      status: "completed",
      stage: 1,
      assignment: 2,
      reason: "交付已接受",
    },
  ];
  tasks[1].reports = [
    {
      role: "growth",
      assignment: 1,
      verdict: "pass",
      summary: "已整理选题方向与草稿，等待负责人确认。",
      artifacts: ["tasks/DEMO-002/content-plan.md"],
      evidence: ["示例：已核对 10 个选题的内容结构"],
    },
    {
      role: "qa",
      assignment: 2,
      verdict: "pass",
      summary: "内容结构完整，可进入最终验收。",
      artifacts: ["tasks/DEMO-002/content-plan.md"],
      evidence: ["示例：全部交付项齐全"],
    },
  ];
  return {
    name: "同舟创意工作室",
    maxAssignments: 6,
    connected: true,
    at: new Date().toISOString(),
    tasks,
    businesses: [
      {
        id: "demo-business",
        name: "示例 · 灵感笔记",
        stage: "operating",
        status: "draft",
        description: "虚构的笔记产品，用于体验持续经营界面。",
        audience: "需要随时记录灵感的人",
        objective: "验证内容是否带来首次使用",
        channels: "场景内容与官网体验",
        url: "",
        metrics: [],
        cycles: [],
        routines: [
          {
            id: "growth",
            title: "推广内容与转化实验",
            kind: "content",
            enabled: true,
            cadence: "daily",
            nextAt: new Date().toISOString(),
            lastTask: null,
          },
          {
            id: "feedback",
            title: "用户反馈与留存维护",
            kind: "support",
            enabled: true,
            cadence: "daily",
            nextAt: new Date().toISOString(),
            lastTask: null,
          },
          {
            id: "review",
            title: "经营复盘与下周计划",
            kind: "content",
            enabled: true,
            cadence: "weekly",
            nextAt: new Date().toISOString(),
            lastTask: null,
          },
        ],
      },
    ],
    departments: roleNames,
    workflows: routes,
    cards: [
      {
        id: 1001,
        kind: "ask",
        title: "十一月内容选题与发布计划",
        text: "10 个选题、内容大纲与发布节奏已整理完毕，验收部门已核对。\n请确认是否接受本次交付。",
        options: ["接受交付", "退回修改"],
      },
    ],
    agents: Object.keys(roleNames).map((role) => ({ id: `company-${role}`, use: "codex", online: true })),
    runs: [
      {
        id: 12,
        agent: "company-engineering",
        state: "claimed",
        summary: "官网页面实现",
        createdAt: new Date().toISOString(),
      },
      {
        id: 13,
        agent: "company-support",
        state: "claimed",
        summary: "整理客户问题",
        createdAt: new Date().toISOString(),
      },
    ],
    spending: {
      today: { rounds: 12, tokens: 48620, cost: 1.28, missingTokens: 0, missingCost: 0 },
      week: { rounds: 68, tokens: 256140, cost: 8.42, missingTokens: 2, missingCost: 3 },
    },
  };
}
function statsHTML(d) {
  const active = d.tasks.filter((t) => t.status === "active").length,
    approvals = d.cards.filter((c) => c.kind === "ask").length,
    blocked = d.tasks.filter((t) => ["blocked", "rejected"].includes(t.status)).length;
  const done = d.tasks.filter((t) => t.status === "completed").length,
    today = d.spending?.today;
  return [
    {
      label: "正在推进",
      icon: "↗",
      value: active,
      unit: "项任务",
      foot: `共 ${d.tasks.length} 项任务 · 已完成 ${done} 项`,
    },
    {
      label: "待审批",
      icon: "◇",
      value: approvals,
      unit: "项决策",
      foot: approvals ? "等待处理" : "暂无待处理审批",
      alert: approvals > 0,
    },
    {
      label: "需要关注",
      icon: "⊙",
      value: blocked,
      unit: "项阻塞",
      foot: blocked ? "补充资料或调整后，可重新派工" : "无阻塞任务",
    },
    {
      label: "今日已报费用",
      icon: "◴",
      value: cost(today),
      unit: "USD",
      foot: !d.connected
        ? "任务引擎离线，费用暂不可用"
        : today?.missingCost
          ? `${today.missingCost} 轮未上报费用 · 非完整账单`
          : `${today?.rounds ?? 0} 轮执行 · 按实际回报记录`,
    },
  ]
    .map(
      (s) =>
        `<article class="stat ${s.alert ? "alert" : ""}"><div class="stat-top">${s.label}<span class="stat-icon">${s.icon}</span></div><div class="stat-value">${s.value}<em>${s.unit}</em></div><div class="stat-foot">${s.foot}</div></article>`,
    )
    .join("");
}
function departmentHTML(d) {
  return `<section class="panel ${view === "departments" ? "full-dept" : ""}"><div class="panel-heading"><h2>部门</h2>${view === "overview" ? '<a class="text-link" href="#departments">全部部门 ↗</a>' : '<span class="muted">6 个部门</span>'}</div><div class="dept-grid">${Object.entries(
    roleNames,
  )
    .map(([role, name]) => {
      const agent = d.agents.find((a) => a.id === `company-${role}`),
        running = d.runs.some((r) => r.agent === `company-${role}` && r.state === "claimed");
      const tasks = d.tasks.filter((t) => t.status === "active" && routes[t.kind]?.[t.stage] === role);
      const status =
        !d.connected || !agent?.online ? "未连接" : running ? "执行中" : tasks.length ? "待接单" : "空闲中";
      return `<button class="dept-card" data-department="${role}"><div class="dept-top"><span class="dept-icon">${roleInfo[role][0]}</span><span class="dept-status ${running ? "busy" : ""}">${status}</span></div><h3 class="dept-name">${name}部</h3><div class="dept-desc">${roleInfo[role][1]}</div><div class="dept-bottom"><span>${esc(agent?.use === "claude" ? "Claude Code" : agent?.use === "codex" ? "Codex" : (agent?.use ?? "待接入"))}</span><b>${tasks.length ? `${tasks.length} 项在途任务` : "等待新任务"}</b></div></button>`;
    })
    .join("")}</div></section>`;
}
function taskRows(d) {
  let tasks = d.tasks.filter(
    (t) =>
      (filter === "all" ||
        filter === t.status ||
        (filter.startsWith("dept:") && routes[t.kind]?.[t.stage] === filter.slice(5))) &&
      (!search || `${t.title} ${t.id}`.toLowerCase().includes(search.toLowerCase())),
  );
  if (view === "overview")
    tasks = tasks
      .slice()
      .sort((a, b) => Number(a.status === "completed") - Number(b.status === "completed"))
      .slice(0, 6);
  if (!tasks.length)
    return `<tr><td colspan="4"><div class="empty"><span class="empty-symbol">▧</span><strong>${d.tasks.length ? "没有匹配的任务" : "暂无任务"}</strong>${d.tasks.length ? "" : ""}</div></td></tr>`;
  return tasks
    .map((t) => {
      const flow = routes[t.kind] ?? [];
      return `<tr><td><button class="task-title" data-task="${esc(t.id)}">${esc(t.title)}</button><span class="task-code">${esc(t.id)}</span></td><td>${badge(t.status)}</td><td><span class="stage">${flow.map((r, i) => `<i class="${i <= t.stage ? "done" : ""}" title="${roleNames[r]}"></i>`).join("")} ${t.status === "completed" ? "已归档" : t.status === "awaiting_approval" ? "负责人" : esc(roleNames[flow[t.stage]] ?? "等待派工")}</span></td><td><button class="text-link" data-task="${esc(t.id)}">查看 ↗</button></td></tr>`;
    })
    .join("");
}
function tasksHTML(d) {
  return `<section class="panel ${view === "overview" ? "tasks-panel" : ""}"><div class="panel-heading"><h2>任务列表 <small>${d.tasks.length} 项任务</small></h2>${view === "overview" ? '<a class="text-link" href="#tasks">查看全部 ↗</a>' : '<span class="text-link">每 5 秒自动同步</span>'}</div><div class="panel-toolbar"><div class="filters">${[
    ["all", "全部"],
    ["active", "进行中"],
    ["awaiting_approval", "待审批"],
    ["completed", "已完成"],
    ["blocked", "受阻"],
  ]
    .map(
      ([id, label]) => `<button class="filter ${filter === id ? "active" : ""}" data-filter="${id}">${label}</button>`,
    )
    .join(
      "",
    )}${filter.startsWith("dept:") ? `<button class="filter active" data-filter="all">${esc(roleNames[filter.slice(5)])}部 ×</button>` : ""}</div><label class="search"><span>⌕</span><input id="search" aria-label="搜索任务" placeholder="搜索任务…" value="${esc(search)}"></label></div><div class="task-list"><table class="task-table"><thead><tr><th>任务名称</th><th>当前状态</th><th>流转阶段</th><th></th></tr></thead><tbody id="task-rows">${taskRows(d)}</tbody></table></div>${!d.tasks.length ? `<div class="onboarding"><h3>任务模板</h3><div class="suggestions"><button class="suggestion" data-template="software">周报工具</button><button class="suggestion" data-template="content">内容选题</button><button class="suggestion" data-template="support">客户回复手册</button></div></div>` : ""}</section>`;
}
function approvalsHTML(d) {
  const cards = d.cards.filter((c) => c.kind === "ask");
  return `<section class="panel approval-panel ${view === "approvals" ? "full-approvals" : ""}"><div class="panel-heading"><h2>待审批</h2><span class="count-badge">${cards.length}</span></div><div class="approval-list">${cards.length ? cards.map((c) => `<article class="approval-card"><span class="meta">审批编号 ${String(c.id).padStart(3, "0")}</span><h3>${esc(c.title)}</h3><p>${esc(c.text)}</p><div class="approval-actions">${c.options.map((option, i) => `<button class="small-button ${i ? "ghost" : ""}" data-answer="${c.id}" data-choice="${i}" ${!d.connected ? "disabled" : ""}>${esc(option)}</button>`).join("")}</div></article>`).join("") : '<div class="empty"><span class="empty-symbol">✓</span><strong>暂无待审批事项</strong></div>'}</div><p class="note approval-list">接受交付仅代表验收通过，不会自动发布或付款。</p></section>`;
}
function spendingHTML(d) {
  return `<div class="cost-grid">${[
    ["today", "今日用量"],
    ["week", "最近 7 天"],
  ]
    .map(([key, title]) => {
      const s = d.spending?.[key];
      return `<section class="panel"><div class="panel-heading"><h2>${title}</h2><span class="muted">已上报</span></div><div class="cost-body"><div class="cost-number">${cost(s)}<small>USD</small></div>${[
        ["执行轮次", s?.rounds],
        ["Token 用量", s?.tokens?.toLocaleString("zh-CN")],
        ["未上报费用的轮次", s?.missingCost],
        ["未上报 Token 的轮次", s?.missingTokens],
      ]
        .map(([k, v]) => `<div class="cost-row"><span>${k}</span><b>${v ?? "—"}</b></div>`)
        .join("")}</div></section>`;
    })
    .join(
      "",
    )}</div><div class="cost-help">每项任务最多派工 <strong>${d.maxAssignments}</strong> 次，返工计入额度。次数限制不包含失败重试和回执修复，也不是金额硬上限。未上报的费用保持未知，上方金额为中台总量。</div><section class="panel tasks-panel"><div class="panel-heading"><h2>最近执行记录</h2></div>${
    d.runs.length
      ? d.runs
          .slice(0, 15)
          .map(
            (r) =>
              `<div class="latest-run"><div>${esc(roleNames[r.agent?.replace("company-", "")] ?? "公司调度")}<small>${esc(r.summary || r.error || "等待结果")}</small></div><span class="muted">${esc({ claimed: "执行中", queued: "待执行", done: "已完成", failed: "失败", cancelled: "已取消", nothing: "无需处理", unknown: "状态待确认" }[r.state] ?? r.state)}</span></div>`,
          )
          .join("")
      : '<div class="empty">还没有执行记录</div>'
  }</section>`;
}
function render() {
  const d = data();
  if (!d) return;
  if (!isDemo) renderedState = signature(d);
  view = location.hash.slice(1) || "businesses";
  if (!labels[view]) view = "overview";
  document.querySelectorAll("[data-view]").forEach((a) => {
    a.classList.toggle("active", a.dataset.view === view);
    if (a.dataset.view === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  $("#company-name").textContent = d.name;
  $("#page-title").textContent = labels[view];
  $("#connection").textContent = isDemo ? "示例预览" : d.connected ? "任务引擎已连接" : "任务引擎离线";
  $("#connection").classList.toggle("offline", !d.connected);
  $("#demo-banner").hidden = !isDemo;
  $("#demo-toggle").innerHTML = isDemo ? "返回我的公司 <span>↗</span>" : "查看示例公司 <span>↗</span>";
  $("#offline-banner").hidden = d.connected;
  $("#offline-banner").textContent = d.connectionError ?? "当前显示已保存的数据，任务引擎离线，提交与审批暂不可用。";
  $("#nav-tasks").textContent = d.tasks.length;
  $("#nav-approvals").textContent = d.cards.filter((c) => c.kind === "ask").length;
  $("#stats").innerHTML = statsHTML(d);
  $("#stats").hidden = view === "departments" || view === "businesses";
  $("#view-content").innerHTML =
    view === "businesses"
      ? businessesHTML(d)
      : view === "overview"
        ? `<div class="dashboard-grid"><div>${departmentHTML(d)}${tasksHTML(d)}</div><div class="right-column">${approvalsHTML(d)}</div></div>`
        : view === "tasks"
          ? tasksHTML(d)
          : view === "approvals"
            ? approvalsHTML(d)
            : view === "departments"
              ? departmentHTML(d)
              : spendingHTML(d);
  $("#new-task").disabled = view !== "businesses" && !d.connected;
  $("#new-task").innerHTML = view === "businesses" ? "＋ 新建业务" : "<span>＋</span> 新建任务";
  $("#last-updated").textContent = (isDemo ? "示例数据 · " : "最后同步 ") + time(d.at) + " · 北京时间";
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    live = await api("/api/overview");
    lastRefresh = Date.now();
    if (!isDemo && !pending && !$("dialog[open]") && document.activeElement?.id !== "search") {
      if (renderedState !== signature(live)) render();
      else $("#last-updated").textContent = "最后同步 " + time(live.at) + " · 北京时间";
    }
  } catch (error) {
    if (live) {
      live.connected = false;
      live.connectionError = "工作台连接中断，当前内容可能已过期。";
      if (!isDemo) render();
    } else {
      $("#connection").textContent = "连接失败";
      $("#offline-banner").hidden = false;
      $("#offline-banner").textContent = error.message;
    }
  } finally {
    refreshing = false;
  }
}
function openForm(template) {
  const d = data();
  if (!d?.connected) return toast("任务引擎离线，暂时无法提交", true);
  const form = $("#task-form");
  form.reset();
  $("#form-error").textContent = "";
  draftId = `TASK-${crypto.randomUUID().replaceAll("-", "")}`;
  if (template) {
    form.elements.kind.value = template;
    form.elements.title.value = {
      software: "制作一个本地周报生成器",
      content: "整理下一周的内容选题",
      support: "制作客户常见问题回复手册",
    }[template];
    form.elements.goal.value = {
      software: "读取人工提供的任务清单，生成 Markdown 周报，不联网、不发送消息。",
      content: "根据工作区内的公司业务资料，准备一周的内容选题与草稿，不发布。",
      support: "根据工作区提供的客户问题与业务资料，整理常见问题和回复草稿，不向客户发送。",
    }[template];
    form.elements.acceptance.value = "交付文件完整，附带使用说明\n列明实际检查依据\n缺少资料时明确标记，不编造事实";
  }
  $("#task-form-dialog").showModal();
}
async function showTask(id) {
  try {
    const d = data();
    const result = isDemo
      ? { task: d.tasks.find((t) => t.id === id), history: [] }
      : await api(`/api/tasks/${encodeURIComponent(id)}`);
    const t = result.task;
    if (!t) throw new Error("任务不存在");
    const flow = routes[t.kind] ?? [];
    $("#detail-content").innerHTML =
      `<div class="dialog-heading"><div><p class="eyebrow">${esc(t.id)} / ${esc(kindNames[t.kind])}</p><h2>${esc(t.title)}</h2></div><button class="close" data-close="detail-dialog" aria-label="关闭">×</button></div>${badge(t.status)}<p class="detail-goal">${esc(t.goal)}</p><div class="detail-section"><h3>验收标准</h3><ul>${t.acceptance.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></div><div class="detail-section"><h3>部门流转 · 已派工 ${t.assignment} / ${d.maxAssignments} 次</h3><p class="muted">${flow.map((r, i) => `${i < t.stage || t.status === "completed" ? "✓ " : i === t.stage ? "● " : ""}${roleNames[r]}`).join("　→　")}　→　负责人审批</p>${t.reason ? `<p class="muted">${esc(t.reason)}</p>` : ""}${["blocked", "rejected"].includes(t.status) ? `<button class="secondary" data-retry="${esc(t.id)}" ${!d.connected ? "disabled" : ""}>重新派工 →</button><p class="note">请先补充缺失资料或修改意见；返工仍计入派工额度。</p>` : ""}</div><div class="detail-section"><h3>部门交付与核验依据</h3>${t.reports.length ? t.reports.map((r) => `<article class="report"><h4>${esc(roleNames[r.role])}部 · ${r.verdict === "pass" ? "通过" : r.verdict === "blocked" ? "受阻" : "未通过"}</h4><p>${esc(r.summary)}</p><ul>${r.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>${r.artifacts.map((path) => `<button class="artifact" data-artifact="${esc(path)}" data-artifact-task="${esc(t.id)}">↗ ${esc(path)}</button>`).join("")}</article>`).join("") : '<p class="muted">暂无交付物</p>'}</div><div class="detail-section"><h3>操作记录</h3>${result.history.length ? result.history.map((h) => `<div class="history-row"><time>${time(h.at)}</time><span>${esc(h.kind === "created" ? "任务已创建" : h.kind === "retried" ? "已重新派工" : h.kind === "completed" ? "负责人已接受" : h.kind === "rejected" ? "负责人已退回" : h.kind === "invalid-report" ? "交付报告不合格" : `${roleNames[h.kind.split(":")[1]] ?? "部门"}已提交报告`)}</span></div>`).join("") : '<p class="muted">暂无操作记录</p>'}</div>`;
    $("#detail-dialog").showModal();
  } catch (error) {
    toast(error.message, true);
  }
}
async function action(button, fn) {
  if (button.disabled) return;
  button.disabled = true;
  pending++;
  try {
    await fn();
  } catch (error) {
    toast(error.message, true);
  } finally {
    pending--;
    button.disabled = false;
  }
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.close) {
    $("#" + button.dataset.close).close();
    return;
  }
  if (businessClick(button)) return;
  if (button.dataset.filter) {
    filter = button.dataset.filter;
    render();
    return;
  }
  if (button.dataset.department) {
    filter = "dept:" + button.dataset.department;
    location.hash = "tasks";
    render();
    return;
  }
  if (button.dataset.task) {
    showTask(button.dataset.task);
    return;
  }
  if (button.dataset.template) {
    openForm(button.dataset.template);
    return;
  }
  if (button.dataset.answer) {
    action(button, async () => {
      const id = Number(button.dataset.answer),
        choice = Number(button.dataset.choice);
      if (isDemo) {
        demo.cards = demo.cards.filter((c) => c.id !== id);
        const t = demo.tasks.find((t) => t.status === "awaiting_approval");
        if (t) t.status = choice === 0 ? "completed" : "rejected";
        toast("示例：审批已处理");
      } else {
        await api(`/api/cards/${id}/answer`, { choice });
        live.cards = live.cards.filter((c) => c.id !== id);
        toast("决定已提交，正在更新任务");
        await refresh();
      }
      render();
    });
    return;
  }
  if (button.dataset.retry) {
    action(button, async () => {
      const id = button.dataset.retry;
      if (isDemo) {
        const t = demo.tasks.find((t) => t.id === id);
        if (t) {
          t.status = "active";
          t.assignment++;
        }
        toast("示例：已重新派工");
      } else {
        button.dataset.requestId ??= crypto.randomUUID();
        await api(`/api/tasks/${encodeURIComponent(id)}/retry`, { requestId: button.dataset.requestId });
        toast("重试已提交");
        await refresh();
      }
      $("#detail-dialog").close();
      render();
    });
    return;
  }
  if (button.dataset.artifact) {
    action(button, async () => {
      const result = isDemo
        ? {
            path: button.dataset.artifact,
            content: "# 示例交付物\n\n这是演示内容，仅用于展示交付物预览。\n真实文件会从本机工作区读取。",
          }
        : await api(
            `/api/tasks/${encodeURIComponent(button.dataset.artifactTask)}/artifact?path=${encodeURIComponent(button.dataset.artifact)}`,
          );
      $("#artifact-title").textContent = result.path;
      $("#artifact-content").textContent = result.content;
      $("#artifact-dialog").showModal();
    });
  }
});
$("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target,
    button = form.querySelector("[type=submit]");
  $("#form-error").textContent = "";
  const acceptance = form.elements.acceptance.value
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  if (acceptance.length > 5 || acceptance.some((a) => a.length > 120)) {
    $("#form-error").textContent = "验收标准最多 5 条，每条不超过 120 字。";
    return;
  }
  const request = {
    id: draftId,
    title: form.elements.title.value.trim(),
    kind: form.elements.kind.value,
    goal: form.elements.goal.value.trim(),
    acceptance,
  };
  button.disabled = true;
  pending++;
  try {
    if (isDemo) {
      demo.tasks.unshift({ ...request, status: "active", stage: 0, assignment: 1, reports: [], reason: "" });
      toast("示例：任务已加入看板");
    } else {
      await api("/api/tasks", request);
      toast("需求已提交，正在安排部门");
      await refresh();
    }
    form.reset();
    $("#task-form-dialog").close();
    filter = "all";
    search = "";
    location.hash = "tasks";
    render();
  } catch (error) {
    $("#form-error").textContent = error.message;
  } finally {
    button.disabled = false;
    pending--;
  }
});
document.addEventListener("input", (event) => {
  if (event.target.id === "search") {
    search = event.target.value;
    $("#task-rows").innerHTML = taskRows(data());
  }
});
$("#new-task").addEventListener("click", () => (view === "businesses" ? openBusinessForm() : openForm()));
$("#refresh").addEventListener("click", async () => {
  await refresh();
  if (!isDemo) render();
  toast(isDemo ? "正在查看示例公司" : "数据已刷新");
});
function toggleDemo(force) {
  isDemo = typeof force === "boolean" ? force : !isDemo;
  if (isDemo && !demo) demo = demoData();
  filter = "all";
  search = "";
  render();
}
$("#demo-toggle").addEventListener("click", () => toggleDemo());
$("#exit-demo").addEventListener("click", () => toggleDemo(false));
window.addEventListener("hashchange", render);
for (const dialog of document.querySelectorAll("dialog"))
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) {
      const box = dialog.getBoundingClientRect();
      if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom)
        dialog.close();
    }
  });
(async () => {
  try {
    csrf = (await api("/api/session")).csrf;
    await refresh();
  } catch (error) {
    toast(error.message, true);
  }
  setInterval(() => {
    if (!document.hidden && !pending && Date.now() - lastRefresh > 4000) refresh();
  }, 5000);
})();

const businessStatus = { draft: "待启动", active: "经营中", paused: "已暂停" };
const businessById = (id) => (data()?.businesses ?? []).find((b) => b.id === id);
const metricNumber = (value) => (value == null ? "未记录" : Number(value).toLocaleString("zh-CN"));
function businessesHTML(d) {
  const businesses = d.businesses ?? [];
  return `<div class="business-intro"><div><b>${businesses.length}</b> 条业务线 <span>· ${businesses.filter((b) => b.status === "active").length} 条经营中</span></div></div>
  <div class="business-grid">${
    businesses
      .map((b) => {
        const metric = b.metrics?.[0],
          tasks = d.tasks.filter((t) => (b.cycles ?? []).some((c) => c.task === t.id));
        return `<article class="panel business-card"><div class="business-card-top"><span class="eyebrow">${b.stage === "operating" ? "现有业务" : "新业务"}</span><span class="badge ${b.status === "active" ? "active" : b.status === "paused" ? "blocked" : ""}">${businessStatus[b.status]}</span></div><h2>${esc(b.name)}</h2><div class="business-objective"><span>当前目标</span><strong>${esc(b.objective)}</strong></div><div class="business-metrics"><div><span>新增用户</span><b>${metricNumber(metric?.newUsers)}</b></div><div><span>活跃用户</span><b>${metricNumber(metric?.activeUsers)}</b></div><div><span>收入 / 元</span><b>${metricNumber(metric?.revenue)}</b></div></div><p class="note">${metric ? "记录日期 " + esc(metric.date) + " · " + esc(metric.source) : "暂无经营数据"}</p><div class="business-routine-strip">${b.routines
          .filter((r) => r.enabled)
          .map((r) => `<span>${r.cadence === "daily" ? "每日" : "每周"} · ${esc(r.title)}</span>`)
          .join(
            "",
          )}</div><div class="business-card-bottom"><span>${tasks.filter((t) => t.status === "active").length} 项执行中 · ${tasks.filter((t) => t.status === "awaiting_approval").length} 项待审批</span><button class="secondary" data-business="${esc(b.id)}">进入业务 →</button></div></article>`;
      })
      .join("") ||
    '<section class="panel empty"><h2>暂无业务</h2><button class="primary" data-business-create="true">新建业务</button></section>'
  }</div><details class="operating-note"><summary>运行说明</summary><p>首轮立即派发，后续按日或周于 09:00 到期，每 15 分钟检查一次。上一轮未完成时不追加任务。</p><p>电脑与引擎须持续运行。发布、投放和业务数据接口未接入；效果手工记录。</p></details>`;
}
function openBusinessForm(id) {
  const form = $("#business-form");
  form.reset();
  $("#business-error").textContent = "";
  const b = id ? businessById(id) : null;
  form.elements.id.value = b?.id ?? "biz-" + crypto.randomUUID().replaceAll("-", "");
  if (b)
    for (const key of ["name", "stage", "description", "audience", "objective", "channels", "url"])
      form.elements[key].value = b[key] ?? "";
  $("#business-form-dialog").showModal();
}
function showBusiness(id) {
  const b = businessById(id),
    d = data();
  if (!b) return;
  const latest = b.metrics?.[0];
  $("#business-content").innerHTML =
    `<div class="dialog-heading"><div><p class="eyebrow">${b.stage === "operating" ? "持续经营" : "新业务验证"} / ${businessStatus[b.status]}</p><h2>${esc(b.name)}</h2></div><button class="close" data-close="business-detail-dialog" aria-label="关闭">×</button></div>
  <p class="detail-goal">${esc(b.objective)}</p><p class="muted">目标用户：${esc(b.audience)}</p><p class="muted">渠道实验：${esc(b.channels || "未设置")}</p>${b.url ? `<p><a class="text-link" href="${esc(b.url)}" target="_blank" rel="noopener noreferrer">打开产品网站 ↗</a></p>` : ""}
  <div class="business-actions"><button class="secondary" data-business-edit="${esc(b.id)}">编辑经营档案</button><button class="secondary" data-metric="${esc(b.id)}">记录效果与反馈</button><button class="primary" data-business-status="${esc(b.id)}" data-status="${b.status === "active" ? "paused" : "active"}" ${b.status !== "active" && !d.connected ? "disabled" : ""}>${b.status === "active" ? "暂停新周期" : b.status === "paused" ? "恢复经营" : "启动经营"}</button></div>
  <p class="note">启动会派发首轮工作并消耗模型额度。暂停仅停止新周期，已派发任务继续执行。</p>
  <section class="detail-section"><h3>周期工作</h3>${b.routines
    .map((r) => {
      const task = d.tasks.find((t) => t.id === r.lastTask);
      const waiting = r.lastTask && task?.status !== "completed";
      return `<div class="routine-row"><div><strong>${esc(r.title)}</strong><p class="note">${!r.enabled ? "已关闭" : b.status !== "active" ? "业务未启动" : waiting ? `等待上一轮：${esc(names[task?.status] ?? "派发中")}` : "下次到期 " + time(r.nextAt)}</p>${task ? `<button class="text-button" data-task="${esc(task.id)}">查看上一轮交付 ↗</button>` : ""}</div><div><select aria-label="${esc(r.title)}频率" data-routine-business="${esc(b.id)}" data-routine="${r.id}"><option value="daily" ${r.cadence === "daily" ? "selected" : ""}>每天</option><option value="weekly" ${r.cadence === "weekly" ? "selected" : ""}>每周</option></select><button class="secondary" data-routine-toggle="${r.id}" data-routine-business="${esc(b.id)}">${r.enabled ? "停用" : "启用"}</button></div></div>`;
    })
    .join("")}</section>
  <section class="detail-section"><h3>实际效果记录</h3>${(b.metrics ?? []).length ? b.metrics.map((m) => `<article class="report"><h4>${esc(m.date)} · ${esc(m.source)}</h4><p>新增用户 ${metricNumber(m.newUsers)} · 活跃用户 ${metricNumber(m.activeUsers)} · 收入 ¥ ${metricNumber(m.revenue)}</p><p>${esc(m.note || "未填写实验记录")}</p></article>`).join("") : '<p class="muted">暂无数据</p>'}</section>
  <section class="detail-section"><h3>业务任务与交付</h3>${
    (b.cycles ?? []).length
      ? b.cycles
          .map((c) => {
            const t = d.tasks.find((t) => t.id === c.task);
            return `<div class="history-row"><time>${time(c.at)}</time><span>${esc(t?.title ?? "等待派发")}</span>${t ? `<button class="text-button" data-task="${esc(t.id)}">${esc(names[t.status])} ↗</button>` : ""}</div>`;
          })
          .join("")
      : '<p class="muted">暂无任务</p>'
  }</section>`;
  if (!$("#business-detail-dialog").open) $("#business-detail-dialog").showModal();
}
function businessClick(button) {
  if (button.dataset.businessCreate) {
    openBusinessForm();
    return true;
  }
  if (button.dataset.business) {
    showBusiness(button.dataset.business);
    return true;
  }
  if (button.dataset.businessEdit) {
    openBusinessForm(button.dataset.businessEdit);
    return true;
  }
  if (button.dataset.metric) {
    const b = businessById(button.dataset.metric),
      form = $("#metric-form");
    form.reset();
    $("#metric-error").textContent = "";
    form.elements.id.value = b.id;
    form.elements.date.value = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    $("#metric-dialog").showModal();
    return true;
  }
  if (button.dataset.businessStatus) {
    action(button, async () => {
      const id = button.dataset.businessStatus,
        status = button.dataset.status;
      if (isDemo) businessById(id).status = status;
      else {
        const result = await api(`/api/businesses/${id}/status`, { status });
        toast(
          result.wakeError ?? (status === "active" ? "经营已启动，团队将按周期接续工作" : "已暂停新周期"),
          !!result.wakeError,
        );
        await refresh();
      }
      render();
      showBusiness(id);
    });
    return true;
  }
  if (button.dataset.routineToggle) {
    action(button, async () => {
      const id = button.dataset.routineBusiness,
        b = businessById(id),
        r = b.routines.find((r) => r.id === button.dataset.routineToggle);
      if (isDemo) r.enabled = !r.enabled;
      else {
        await api(`/api/businesses/${id}/routine`, { routineId: r.id, cadence: r.cadence, enabled: !r.enabled });
        await refresh();
      }
      render();
      showBusiness(id);
    });
    return true;
  }
  return false;
}
document.addEventListener("change", async (event) => {
  const el = event.target;
  if (!el.dataset.routine) return;
  const id = el.dataset.routineBusiness,
    r = businessById(id).routines.find((r) => r.id === el.dataset.routine),
    old = r.cadence;
  try {
    if (isDemo) r.cadence = el.value;
    else {
      await api(`/api/businesses/${id}/routine`, { routineId: r.id, enabled: r.enabled, cadence: el.value });
      await refresh();
    }
    render();
    showBusiness(id);
  } catch (error) {
    el.value = old;
    toast(error.message, true);
  }
});
$("#business-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target,
    button = form.querySelector("[type=submit]");
  button.disabled = true;
  pending++;
  try {
    const request = Object.fromEntries(new FormData(form));
    if (isDemo) {
      demo.businesses ??= [];
      const old = businessById(request.id);
      if (old) Object.assign(old, request);
      else demo.businesses.push({ ...request, status: "draft", routines: [], metrics: [], cycles: [] });
    } else await api("/api/businesses", request);
    await refresh();
    $("#business-form-dialog").close();
    render();
    if ($("#business-detail-dialog").open) showBusiness(request.id);
    toast("经营档案已保存");
  } catch (error) {
    $("#business-error").textContent = error.message;
  } finally {
    button.disabled = false;
    pending--;
  }
});
$("#metric-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target,
    button = form.querySelector("[type=submit]");
  button.disabled = true;
  pending++;
  try {
    const request = Object.fromEntries(new FormData(form));
    for (const k of ["newUsers", "activeUsers", "revenue"]) request[k] = request[k] === "" ? null : Number(request[k]);
    if (isDemo) {
      const b = businessById(request.id);
      b.metrics = [request, ...b.metrics.filter((m) => m.date !== request.date)].sort((a, b) =>
        b.date.localeCompare(a.date),
      );
    } else await api(`/api/businesses/${request.id}/metrics`, request);
    await refresh();
    $("#metric-dialog").close();
    render();
    showBusiness(request.id);
    toast("实际经营结果已记录");
  } catch (error) {
    $("#metric-error").textContent = error.message;
  } finally {
    button.disabled = false;
    pending--;
  }
});
