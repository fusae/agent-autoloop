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
  overview: ["COMPANY OVERVIEW", "公司的每一步，都在这里。", "看进展、处理决策，让团队继续向前。"],
  tasks: ["MISSION BOARD", "从一个目标，到一次交付。", "所有任务的负责人、进展与结果，放在一张看板上。"],
  approvals: ["YOUR DECISIONS", "关键的一步，等你拍板。", "核对交付结果，再决定接受还是退回修改。"],
  departments: ["YOUR TEAM", "六个部门，朝同一个目标。", "每个部门各司其职，交接有依据，结果可追溯。"],
  spending: ["USAGE & COST", "让每一次投入，都有记录。", "查看已上报用量与费用，掌握公司的运行情况。"],
};
let live = null,
  demo = null,
  isDemo = false,
  csrf = "",
  filter = "all",
  search = "",
  view = "overview",
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
      label: "等你拍板",
      icon: "◇",
      value: approvals,
      unit: "项决策",
      foot: approvals ? "你的决定，会让团队继续前进" : "暂无待处理审批",
      alert: approvals > 0,
    },
    {
      label: "需要关注",
      icon: "⊙",
      value: blocked,
      unit: "项阻塞",
      foot: blocked ? "补充资料或调整后，可重新派工" : "所有任务都在正常推进",
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
  return `<section class="panel ${view === "departments" ? "full-dept" : ""}"><div class="panel-heading"><h2>部门协作 <small>各司其职，协同推进</small></h2>${view === "overview" ? '<a class="text-link" href="#departments">全部部门 ↗</a>' : '<span class="muted">六个专业角色</span>'}</div><div class="dept-grid">${Object.entries(
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
    return `<tr><td colspan="4"><div class="empty"><span class="empty-symbol">▧</span><strong>${d.tasks.length ? "没有匹配的任务" : "你的第一项任务，从这里开始。"}</strong>${d.tasks.length ? "调整筛选条件，再看看。" : "描述一个目标，团队就有了前进的方向。"}</div></td></tr>`;
  return tasks
    .map((t) => {
      const flow = routes[t.kind] ?? [];
      return `<tr><td><button class="task-title" data-task="${esc(t.id)}">${esc(t.title)}</button><span class="task-code">${esc(t.id)}</span></td><td>${badge(t.status)}</td><td><span class="stage">${flow.map((r, i) => `<i class="${i <= t.stage ? "done" : ""}" title="${roleNames[r]}"></i>`).join("")} ${t.status === "completed" ? "已归档" : t.status === "awaiting_approval" ? "负责人" : esc(roleNames[flow[t.stage]] ?? "等待派工")}</span></td><td><button class="text-link" data-task="${esc(t.id)}">查看 ↗</button></td></tr>`;
    })
    .join("");
}
function tasksHTML(d) {
  return `<section class="panel ${view === "overview" ? "tasks-panel" : ""}"><div class="panel-heading"><h2>任务看板 <small>${d.tasks.length} 项任务</small></h2>${view === "overview" ? '<a class="text-link" href="#tasks">查看全部 ↗</a>' : '<span class="text-link">每 5 秒自动同步</span>'}</div><div class="panel-toolbar"><div class="filters">${[
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
    )}${filter.startsWith("dept:") ? `<button class="filter active" data-filter="all">${esc(roleNames[filter.slice(5)])}部 ×</button>` : ""}</div><label class="search"><span>⌕</span><input id="search" aria-label="搜索任务" placeholder="搜索任务…" value="${esc(search)}"></label></div><div class="task-list"><table class="task-table"><thead><tr><th>任务名称</th><th>当前状态</th><th>流转阶段</th><th></th></tr></thead><tbody id="task-rows">${taskRows(d)}</tbody></table></div>${!d.tasks.length ? `<div class="onboarding"><h3>试试给团队这些目标</h3><p>从一件具体的小事开始，写清楚你期望的结果。</p><div class="suggestions"><button class="suggestion" data-template="software">做一个周报工具 ↗</button><button class="suggestion" data-template="content">整理一周内容选题 ↗</button><button class="suggestion" data-template="support">制作客户回复手册 ↗</button></div></div>` : ""}</section>`;
}
function approvalsHTML(d) {
  const cards = d.cards.filter((c) => c.kind === "ask");
  return `<section class="panel approval-panel ${view === "approvals" ? "full-approvals" : ""}"><div class="panel-heading"><h2>待你拍板</h2><span class="count-badge">${cards.length}</span></div><div class="approval-list">${cards.length ? cards.map((c) => `<article class="approval-card"><span class="meta">DECISION / ${String(c.id).padStart(3, "0")}</span><h3>${esc(c.title)}</h3><p>${esc(c.text)}</p><div class="approval-actions">${c.options.map((option, i) => `<button class="small-button ${i ? "ghost" : ""}" data-answer="${c.id}" data-choice="${i}" ${!d.connected ? "disabled" : ""}>${esc(option)}</button>`).join("")}</div></article>`).join("") : '<div class="empty"><span class="empty-symbol">✓</span><strong>暂时没有需要你的决定</strong>团队完成验收后，审批会出现在这里。</div>'}</div><p class="note approval-list">接受交付仅代表验收通过，不会自动发布或付款。</p></section>`;
}
function workflowHTML() {
  return `<section class="workflow-panel"><h3>一个目标，如何变成结果？</h3>${[
    ["下达目标", "明确需求与验收标准"],
    ["部门协作", "按业务流程接力处理"],
    ["独立验收", "检查交付物与实际依据"],
    ["你来拍板", "接受交付，或退回修改"],
  ]
    .map(
      ([title, text], i) =>
        `<div class="flow-step"><span class="flow-number">${String(i + 1).padStart(2, "0")}</span><div><strong>${title}</strong><small>${text}</small></div></div>`,
    )
    .join(
      "",
    )}</section><div class="bottom-note"><span>◈</span><span>审批等待期间不调用模型。<br>你的每一次决定，都会留下记录。</span></div>`;
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
  view = location.hash.slice(1) || "overview";
  if (!labels[view]) view = "overview";
  document.querySelectorAll("[data-view]").forEach((a) => {
    a.classList.toggle("active", a.dataset.view === view);
    if (a.dataset.view === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  $("#company-name").textContent = d.name;
  $("#eyebrow").textContent = labels[view][0];
  $("#page-title").textContent = labels[view][1];
  $("#page-subtitle").textContent = labels[view][2];
  $("#connection").textContent = isDemo ? "示例预览" : d.connected ? "任务引擎已连接" : "任务引擎离线";
  $("#connection").classList.toggle("offline", !d.connected);
  $("#demo-banner").hidden = !isDemo;
  $("#demo-toggle").innerHTML = isDemo ? "返回我的公司 <span>↗</span>" : "查看示例公司 <span>↗</span>";
  $("#offline-banner").hidden = d.connected;
  $("#offline-banner").textContent = d.connectionError ?? "当前显示已保存的数据，任务引擎离线，提交与审批暂不可用。";
  $("#nav-tasks").textContent = d.tasks.length;
  $("#nav-approvals").textContent = d.cards.filter((c) => c.kind === "ask").length;
  $("#stats").innerHTML = statsHTML(d);
  $("#stats").hidden = view === "departments";
  $("#view-content").innerHTML =
    view === "overview"
      ? `<div class="dashboard-grid"><div>${departmentHTML(d)}${tasksHTML(d)}</div><div class="right-column">${approvalsHTML(d)}${workflowHTML()}</div></div>`
      : view === "tasks"
        ? tasksHTML(d)
        : view === "approvals"
          ? approvalsHTML(d)
          : view === "departments"
            ? departmentHTML(d)
            : spendingHTML(d);
  $("#new-task").disabled = !d.connected;
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
      `<div class="dialog-heading"><div><p class="eyebrow">${esc(t.id)} / ${esc(kindNames[t.kind])}</p><h2>${esc(t.title)}</h2></div><button class="close" data-close="detail-dialog" aria-label="关闭">×</button></div>${badge(t.status)}<p class="detail-goal">${esc(t.goal)}</p><div class="detail-section"><h3>验收标准</h3><ul>${t.acceptance.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></div><div class="detail-section"><h3>部门流转 · 已派工 ${t.assignment} / ${d.maxAssignments} 次</h3><p class="muted">${flow.map((r, i) => `${i < t.stage || t.status === "completed" ? "✓ " : i === t.stage ? "● " : ""}${roleNames[r]}`).join("　→　")}　→　你来拍板</p>${t.reason ? `<p class="muted">${esc(t.reason)}</p>` : ""}${["blocked", "rejected"].includes(t.status) ? `<button class="secondary" data-retry="${esc(t.id)}" ${!d.connected ? "disabled" : ""}>重新派工 →</button><p class="note">请先补充缺失资料或修改意见；返工仍计入派工额度。</p>` : ""}</div><div class="detail-section"><h3>部门交付与核验依据</h3>${t.reports.length ? t.reports.map((r) => `<article class="report"><h4>${esc(roleNames[r.role])}部 · ${r.verdict === "pass" ? "通过" : r.verdict === "blocked" ? "受阻" : "未通过"}</h4><p>${esc(r.summary)}</p><ul>${r.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>${r.artifacts.map((path) => `<button class="artifact" data-artifact="${esc(path)}" data-artifact-task="${esc(t.id)}">↗ ${esc(path)}</button>`).join("")}</article>`).join("") : '<p class="muted">部门提交结果后，交付物和检查依据会出现在这里。</p>'}</div><div class="detail-section"><h3>操作记录</h3>${result.history.length ? result.history.map((h) => `<div class="history-row"><time>${time(h.at)}</time><span>${esc(h.kind === "created" ? "任务已创建" : h.kind === "retried" ? "已重新派工" : h.kind === "completed" ? "负责人已接受" : h.kind === "rejected" ? "负责人已退回" : h.kind === "invalid-report" ? "交付报告不合格" : `${roleNames[h.kind.split(":")[1]] ?? "部门"}已提交报告`)}</span></div>`).join("") : '<p class="muted">暂无操作记录</p>'}</div>`;
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
$("#new-task").addEventListener("click", () => openForm());
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
