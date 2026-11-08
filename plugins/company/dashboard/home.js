// Owner home page: one screen that answers "how is the company doing today, and what needs me?".
// Reuses app.js globals (esc, time, roleNames, planNames, data-answer/data-reply handlers).
const homeDay = (value = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(value));
const homeDate = (value) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
const homeShortDate = (value) =>
  new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", timeZone: "Asia/Shanghai" }).format(
    new Date(value),
  );
const homeClock = (value) =>
  new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
const homeNum = (value) => (value == null ? "—" : Number(value).toLocaleString("zh-CN"));
const homeTitle = (title) => String(title ?? "").replace(/(已审)?(图文)?发布格式转换$/, "") || String(title ?? "");
const homeBusiness = (d, id) => (d.businesses ?? []).find((b) => b.id === id)?.name ?? id;

function homeQuota(d, key) {
  const q = d.home?.quota;
  if (!q) return null;
  const limits = q.limits ?? {};
  if (key === "total") return { used: q.total ?? 0, limit: limits.total ?? null };
  if (key === "ceo") return { used: q.roles?.ceo ?? 0, limit: limits.ceo ?? null };
  return { used: q.employees?.[key] ?? 0, limit: limits.employee ?? limits.growth ?? null };
}
const quotaText = (q) => (q ? (q.limit == null ? `${q.used} 次` : `${q.used} / ${q.limit} 次`) : "—");

function homeSummary(d, asks, growth, stock) {
  const today = homeDay(d.at);
  const working = growth.filter(({ s }) => s.workday?.date === today).length;
  const published = (d.home?.publications ?? []).length;
  const manual = (d.home?.feedback?.manual ?? []).length;
  const ready = Object.values(stock).reduce((n, s) => n + (s?.ready ?? 0), 0);
  const first = !growth.length
    ? "还没有在岗的运营。"
    : working
      ? `今天 ${working} 位运营上了班。`
      : `运营今天还没上班，每天 ${growth[0].p.workday?.after ?? "09:00"} 开工。`;
  const work = [
    (published || manual ? `已发 ${published} 篇帖子` : "还没有发出帖子") +
      (manual ? `（另有你自己发的 ${manual} 篇）` : ""),
    ready ? `手上 ${ready} 篇稿子待发` : "暂无备好的稿子",
  ];
  const you = asks.length ? `${asks.length} 件事等你拍板。` : "没有要你处理的事。";
  return `${first}${work.join("，")}；${you}`;
}

function homeAskFields(text) {
  // Card text: "APP：…\n标题：…\n正文：<multi-line>\n图片数：…\n…\n发布稿件：<key>"
  const t = String(text ?? "");
  const pick = (label) => new RegExp(`^${label}[：:]\\s*(.*)$`, "m").exec(t)?.[1]?.trim();
  const body = /^正文[：:]\s*([\s\S]*?)(?=^(?:图片数|只发布|发布稿件|预计发布时间|一小时内)[：:]?|$(?![\s\S]))/m
    .exec(t)?.[1]
    ?.trim();
  return {
    app: pick("业务") ?? pick("APP"),
    title: pick("标题"),
    body,
    images: pick("图片数"),
    key: /发布稿件[：:]\s*([a-f0-9]{32})/.exec(t)?.[1],
  };
}
const homeClip = (text, n = 110) => {
  const chars = Array.from(String(text ?? "").replace(/\s+/g, " "));
  return chars.length > n ? chars.slice(0, n).join("") + "…" : chars.join("");
};
const draftButton = (key, label = "查看全文和配图") =>
  key ? `<button type="button" class="text-action" data-draft="${esc(key)}">${label}</button>` : "";

function homeAsk(d, c) {
  const disabled = d.connected ? "" : "disabled";
  const f = homeAskFields(c.text);
  const body =
    f.title || f.app
      ? `<dl class="ask-fields">${f.app ? `<div><dt>业务</dt><dd>${esc(f.app)}</dd></div>` : ""}${f.title ? `<div><dt>标题</dt><dd class="ask-headline">${esc(f.title)}</dd></div>` : ""}${f.body ? `<div><dt>正文开头</dt><dd>${esc(homeClip(f.body))}</dd></div>` : ""}${f.images ? `<div><dt>配图</dt><dd>${esc(f.images)} 张</dd></div>` : ""}</dl>${f.key ? `<p class="ask-more">${draftButton(f.key)}</p>` : ""}`
      : `<p class="ask-text">${esc(c.text)}</p>`;
  return `<article class="ask">
    <h3>${esc(c.title)}</h3>
    ${body}
    <div class="ask-actions">${c.options.map((o, i) => `<button class="${i === 0 ? "primary" : "secondary"}" data-answer="${c.id}" data-choice="${i}" ${disabled}>${esc(o)}</button>`).join("")}</div>
    <details class="ask-reply"><summary>写几句再回复</summary>
      <label class="sr-only" for="reply-${c.id}">你的回复</label>
      <textarea id="reply-${c.id}" rows="3" maxlength="4000" placeholder="比如：标题再口语一点，明天再发" ${disabled}></textarea>
      <button class="secondary" data-reply="${c.id}" ${disabled}>发送回复</button>
    </details>
  </article>`;
}

async function openDraft(key) {
  const box = $("#draft-content");
  $("#draft-title").textContent = "稿件全文";
  box.innerHTML = '<p class="empty-line">正在读取稿件…</p>';
  $("#draft-dialog").showModal();
  try {
    const draft = await api(`/api/publications/${encodeURIComponent(key)}`);
    $("#draft-title").textContent = draft.title;
    box.innerHTML = `<p class="draft-meta">${esc(homeBusiness(data() ?? {}, draft.business))}，正文 ${Array.from(draft.content).length} 字，配图 ${draft.images} 张</p>
      <div class="draft-body">${esc(draft.content)}</div>
      ${draft.images ? `<div class="draft-images">${Array.from({ length: draft.images }, (_, i) => `<a href="api/publications/${esc(key)}/image/${i}" target="_blank" rel="noopener"><img src="api/publications/${esc(key)}/image/${i}" alt="第 ${i + 1} 张配图" loading="lazy" /></a>`).join("")}</div>` : '<p class="empty-line">这份稿件没有配图。</p>'}`;
  } catch (error) {
    box.innerHTML = `<p class="empty-line">${esc(error.message)}</p>`;
  }
}
if (typeof document !== "undefined")
  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-draft]");
    if (button) openDraft(button.dataset.draft);
  });

function homeGoal(stock) {
  if (!stock || stock.target == null) return '<span class="goal-none">本周还没定发帖目标</span>';
  const dots = Array.from({ length: Math.max(stock.target, stock.published + stock.ready) }, (_, i) =>
    i < stock.published ? "done" : i < stock.published + stock.ready ? "ready" : "todo",
  );
  return `<span class="goal-dots" role="img" aria-label="本周目标 ${stock.target} 篇，已发 ${stock.published} 篇，备稿 ${stock.ready} 篇">${dots.map((k) => `<i class="dot ${k}"></i>`).join("")}</span><span class="goal-text">已发 ${stock.published}，备稿 ${stock.ready}，目标 ${stock.target} 篇</span>`;
}

function homeStaff(d, growth, stock) {
  const today = homeDay(d.at);
  const c = d.home?.leadership ?? d.leadership ?? {};
  const ceoRun =
    d.home?.ceoRun ??
    (d.runs ?? [])
      .filter((r) => r.agent === "company-ceo" && r.summary)
      .sort((a, b) => String(b.finishedAt ?? b.createdAt).localeCompare(String(a.finishedAt ?? a.createdAt)))[0];
  const openIssues = c.openIssues ?? (c.issues ?? []).filter((i) => i.state === "open").length;
  const reportAt = growth[0]?.p.reporting?.ceoAt;
  const ceo = `<li class="person">
    <div class="person-name"><strong>CEO</strong><span>管全公司，向你汇报</span></div>
    <div class="person-now"><span class="state ${c.enabled ? "on" : ""}">${c.enabled ? (ceoRun?.state === "claimed" ? "正在处理" : "在岗") : "未启用"}</span>
      <p>${esc(ceoRun?.summary ?? "还没有处理记录")}</p>
      ${ceoRun ? `<small>${homeClock(ceoRun.finishedAt ?? ceoRun.createdAt)} 的处理结果${openIssues ? `，还有 ${openIssues} 个员工问题在处理` : ""}</small>` : ""}</div>
    <div class="person-goal">${reportAt ? `<span class="goal-text">下次日报 ${homeShortDate(reportAt)} ${homeClock(reportAt)}</span>` : ""}</div>
    <div class="person-quota"><span>今天调用</span><b>${quotaText(homeQuota(d, "ceo"))}</b></div>
  </li>`;
  const rows = growth.map(({ p, s }) => {
    const worked = s.workday?.date === today;
    const focus = s.daily?.date === today ? s.daily.focus : s.nextAction;
    const blocked = /受阻/.test(s.workStatus ?? "");
    return `<li class="person">
      <div class="person-name"><strong>${esc(s.name ?? "运营")}</strong><span>${esc(homeBusiness(d, p.business))}</span></div>
      <div class="person-now"><span class="state ${blocked ? "bad" : worked ? "on" : ""}">${esc(s.workStatus ?? "")}${worked ? "，今天已上班" : ""}</span>
        <p>${esc(focus ?? "今天还没有安排")}</p>
        ${s.nextWorkdayAt ? `<small>下次上班 ${homeShortDate(s.nextWorkdayAt)} ${homeClock(s.nextWorkdayAt)}</small>` : ""}</div>
      <div class="person-goal">${homeGoal(stock[p.business])}</div>
      <div class="person-quota"><span>今天调用</span><b>${quotaText(homeQuota(d, `${p.business}:growth`))}</b></div>
    </li>`;
  });
  const total = homeQuota(d, "total");
  const pct = total?.limit ? Math.min(100, Math.round((total.used / total.limit) * 100)) : 0;
  return `<section class="home-block" aria-labelledby="staff-title">
    <div class="block-head"><h2 id="staff-title">员工今天在做什么</h2>
      ${total ? `<div class="meter" title="今天全公司模型调用"><span>全公司今天 ${quotaText(total)}</span><div class="meter-bar"><i style="width:${pct}%"></i></div></div>` : ""}</div>
    <ul class="people">${ceo}${rows.join("")}</ul>
    <p class="block-note">圆点是本周发帖进度：实心是已发，描边是备好的稿子，空心是还差的。</p>
  </section>`;
}

function homePosts(d) {
  const fb = d.home?.feedback;
  const results = d.home?.publications ?? [];
  const posts = fb?.posts ?? [];
  const manual = fb?.manual ?? [];
  const followers = fb?.followers?.at?.(-1);
  const compare = (m, label) => {
    if (!m || m.baseline == null) return `<div class="compare"><span>${label}</span><b>暂无数据</b></div>`;
    if (m.result == null)
      return `<div class="compare"><span>${label}</span><b>发帖前 3 天 ${homeNum(m.baseline)}</b><small>发帖后 3 天还在观察，${m.after?.length ? homeShortDate(Date.parse(m.after.at(-1) + "T12:00:00+08:00") + 86400000) : "过几天"}出结果</small></div>`;
    const sign = m.change > 0 ? "+" : "";
    return `<div class="compare"><span>${label}</span><b>${homeNum(m.baseline)} → ${homeNum(m.result)}</b><small class="${m.change > 0 ? "up" : m.change < 0 ? "down" : ""}">${sign}${homeNum(m.change)}${m.percent != null ? `（${sign}${Math.round(m.percent)}%）` : ""}</small></div>`;
  };
  const cards = posts.filter((post) => !results.find((r) => r.key === (post.key ?? post.publication))?.x)
    .slice()
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
    .map((post) => {
      const last = post.samples?.at?.(-1) ?? {};
      const reads = post.reads?.at?.(-1)?.reads;
      const proof =
        results.find((r) => r.key && (r.key === post.key || r.key === post.publication)) ??
        results.find((r) => r.publishedAt && Date.parse(r.publishedAt) === Date.parse(post.publishedAt));
      const title = esc(last.title ?? "（标题未读到）");
      return `<li class="post">
        <div class="post-title"><h3>${proof?.url ? `<a href="${esc(proof.url)}" target="_blank" rel="noopener noreferrer">${title}</a>` : title} <span class="muted">系统发布</span></h3>
          <span>${esc(homeBusiness(d, post.business))}，${homeShortDate(post.publishedAt)} ${homeClock(post.publishedAt)} 发布</span>${proof?.key ? " " + draftButton(proof.key, "看全文") : ""}</div>
        <dl class="post-stats">
          <div><dt>阅读</dt><dd>${reads == null ? '<em title="在飞书告诉 CEO 就会记上">待你告知</em>' : homeNum(reads)}</dd></div>
          <div><dt>点赞</dt><dd>${homeNum(last.likes)}</dd></div>
          <div><dt>收藏</dt><dd>${homeNum(last.collects)}</dd></div>
          <div><dt>评论</dt><dd>${homeNum(last.comments)}</dd></div>
        </dl>
        <div class="post-effect">${compare(post.product?.growth, post.product?.label ?? "新增用户")}${post.product?.downloads ? compare(post.product.downloads, "官网下载点击") : ""}</div>
        ${last.at ? `<small class="post-note">互动数 ${homeShortDate(last.at)} ${homeClock(last.at)} 读取。前后对比只看时间先后，不代表一定是这篇带来的。</small>` : ""}
      </li>`;
    });
  for (const proof of results.filter((r) => r.x)) {
    const x = proof.x;
    const label = x.state === "published" ? "X 已发" : x.state === "failed" ? "X 发布失败，需要在 Mac 上核对" : x.state === "claimed" ? "X 已领取，待核对结果" : "X 待发，需要在 Mac 上执行";
    cards.push(`<li class="post"><div class="post-title"><h3>rabbitrun 币圈内容</h3><span>${homeShortDate(proof.publishedAt)} ${homeClock(proof.publishedAt)}</span> ${draftButton(proof.key, "看全文")}</div><p><a href="${esc(proof.url)}" target="_blank" rel="noopener noreferrer">币安广场</a> · ${x.state === "published" ? `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">X</a>` : esc(label)}</p>${x.state !== "published" ? '<p class="post-note">Mac 触发命令：rabbitrun-x</p>' : ""}<p class="post-note">只记录发布结果，暂不采集互动数据。</p></li>`);
  }
  const waiting = (d.home?.operations ?? d.operations ?? []).flatMap((p) =>
    (p.plans ?? [])
      .filter((a) => a.owner === "growth" && ["publishing", "delivered", "working", "planned"].includes(a.status))
      .map((a) => ({ p, a })),
  );
  const waitLabel = (a) =>
    a.status === "publishing" && a.publishApproval?.state === "pending"
      ? "等你确认发布"
      : a.status === "publishing"
        ? "排队发布"
        : (planNames[a.status] ?? a.status);
  return `<section class="home-block" aria-labelledby="posts-title">
    <div class="block-head"><h2 id="posts-title">推广效果</h2>
      ${followers ? `<p class="followers">账号粉丝 <b>${homeNum(followers.count)}</b>${followers.change ? `<small class="${followers.change > 0 ? "up" : "down"}">${followers.change > 0 ? "+" : ""}${followers.change}</small>` : ""}</p>` : ""}</div>
    ${cards.length ? `<ul class="posts">${cards.join("")}</ul>` : `<p class="empty-line">还没有发出去的帖子。${fb?.status ? esc(fb.status) + "。" : ""}</p>`}
    ${manual.length ? `<h3 class="sub-head">你自己发的</h3><ul class="queue">${manual.map((p) => `<li><span class="queue-app">首次看到 ${homeShortDate(p.firstSeen)}</span><span class="queue-title"><a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.title)}</a></span><span class="queue-state">点赞 ${homeNum(p.samples?.at?.(-1)?.likes)}</span></li>`).join("")}</ul>` : ""}
    ${waiting.length ? `<h3 class="sub-head">还没发的稿子</h3><ul class="queue">${waiting.map(({ p, a }) => `<li><span class="queue-app">${esc(homeBusiness(d, p.business))}</span><span class="queue-title">${esc(homeTitle(a.title))}${a.publicationKey ? " " + draftButton(a.publicationKey, "看全文") : ""}</span><span class="queue-state ${waitLabel(a) === "等你确认发布" ? "mark" : ""}">${esc(waitLabel(a))}</span></li>`).join("")}</ul>` : ""}
    ${fb?.status ? `<p class="block-note">互动数据${esc(fb.status)}。</p>` : ""}
  </section>`;
}

function homeReports(d, growth) {
  const today = homeDay(d.at);
  const c = d.home?.leadership ?? d.leadership ?? {};
  const last = d.home?.ceoReport ?? (c.eveningReports ?? []).slice().sort((a, b) => b.date.localeCompare(a.date))[0];
  const task = last && d.tasks?.find((t) => t.id === last.task);
  const text = last?.summary ?? task?.reports?.at?.(-1)?.summary;
  const ceoAt = growth[0]?.p.reporting?.ceoAt;
  const staff = growth
    .map(({ p, s }) => {
      const r = (s.reports ?? []).find((r) => r.date === today);
      const entry = r?.entries?.at?.(-1)?.report;
      if (!entry) return "";
      return `<details class="staff-report"><summary>${esc(s.name ?? "运营")} · ${esc(homeBusiness(d, p.business))} 的今日日报</summary>
        <dl><div><dt>做了什么</dt><dd>${esc(entry.done)}</dd></div><div><dt>结果</dt><dd>${esc(entry.result)}</dd></div><div><dt>卡点</dt><dd>${esc(entry.blockers)}</dd></div><div><dt>明天</dt><dd>${esc(entry.tomorrow)}</dd></div></dl></details>`;
    })
    .join("");
  return `<section class="home-block" aria-labelledby="report-title">
    <div class="block-head"><h2 id="report-title">日报</h2></div>
    ${
      text
        ? `<article class="ceo-report"><p class="report-date">CEO 日报 · ${esc(last.date)}</p><p class="report-body">${esc(text)}</p></article>`
        : `<p class="empty-line">${last ? "CEO 正在写日报，写好会显示在这里。" : `第一份 CEO 日报${ceoAt ? `会在 ${homeShortDate(ceoAt)} ${homeClock(ceoAt)}` : "会在晚上"}发到飞书，也会显示在这里。`}</p>`
    }
    ${staff}
  </section>`;
}

function homeHTML(d) {
  const asks = (d.cards ?? []).filter((c) => c.kind === "ask");
  const growth = (d.home?.operations ?? d.operations ?? []).flatMap((p) =>
    (p.staff ?? []).filter((s) => s.role === "growth" && s.onDuty !== false).map((s) => ({ p, s })),
  );
  const stock = d.home?.stock ?? {};
  return `<div class="home">
    <section class="today">
      <p class="today-date">${homeDate(d.at)}</p>
      <p class="today-summary">${esc(homeSummary(d, asks, growth, stock))}</p>
      <p class="today-sync">${d.updating ? "更新中，暂时显示上次的数据" : d.connected ? "数据每 30 秒自动更新" : "公司服务暂时连不上，下面是最后一次的数据"}，最后同步 ${homeClock(d.at)}</p>
    </section>
    ${
      asks.length
        ? `<section class="home-block needs" aria-labelledby="needs-title"><div class="block-head"><h2 id="needs-title">等你处理</h2></div><div class="asks">${asks.map((c) => homeAsk(d, c)).join("")}</div></section>`
        : ""
    }
    ${homeStaff(d, growth, stock)}
    ${homePosts(d)}
    ${homeReports(d, growth)}
  </div>`;
}
