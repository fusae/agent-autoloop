> 公司网页升级须同步部署服务端与 dashboard 静态文件并重新载入页面；按需接口不兼容旧网页的完整 overview，详见[网页按需读取](docs/company.md#网页按需读取)。

> **公司 fork：** 使用 [公司版说明](examples/recipes/company/README.md) 的 `npm run company -- start "$HOME/.agent-company"`，打开 `http://127.0.0.1:3361`。它创建独立配置，并为已有公司补齐经营巡检规则与员工检查协议；新业务默认待启动，不安装常驻服务；下文是原版安装流程，在线脚本仍指向上游。

# 安装说明（写给 Agent）

用户请你装好 Agent 自动化中台。先安装，再走一遍提问和继续处理；能自己做的直接做。

## 安装

支持 macOS、Linux，暂不支持 Windows。需要 Node.js 24 或更新、Git、curl，以及一个已经登录的命令行 Agent。

先检查 `node --version`。Homebrew 的 `node@24` 默认不进 PATH，装好后还要运行 `export PATH="$(brew --prefix node@24)/bin:$PATH"`；需要长期生效时再写入用户的 shell 配置。不要替用户登录，也不要读取或复制登录凭据。

本仓库已公开，安装脚本和代码都可匿名下载，不需要 GitHub 账号、登录或 GitHub CLI（`gh`）。下面的命令安装并启用登录后常驻服务：

```bash
curl -fsSL https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.sh | sh
```

GitHub Issue 轮询和 PR 交付等功能另需已登录的 `gh`，按对应场景说明配置；运行 Agent 也仍需该 Agent 自己的登录或授权。

用户指定本地仓库时，用该目录的安装脚本，并把 `AGENT_AUTOLOOP_REPO` 设成它的绝对路径。不要下载 GitHub 的旧脚本，也不要用未提交的文件冒充已安装版本；安装器克隆的是本地仓库的 HEAD。

下面以 `/path/to/agent-autoloop` 为例，使用已经登录的 Codex：

```bash
AGENT_AUTOLOOP_REPO=/path/to/agent-autoloop sh /path/to/agent-autoloop/install.sh --agent codex
```

`--agent claude` 选择 Claude Code；只有其他 CLI 时加 `--command 'hermes chat -q {prompt}'`。不指定时会检测本机安装的 Agent，第一种作为试跑对象。

程序装进 `~/.agent-autoloop/app`，配置和记录留在 `~/.agent-autoloop`。默认打开桌面通知；没有图形会话时安静跳过，问题仍能用 `agent-autoloop status` 查看。命令优先放在 PATH 中的 `~/.local/bin`，否则选 PATH 里第一个可写目录，不用 sudo、不覆盖其他程序；没有位置时使用安装器打印的完整路径。

安装器和中台启动时都会把数据目录设为 `0700`，包括已有目录，阻止其他系统用户读取数据库、事件和运行输出。升级后同步重启中台与接单程序；新版 `status` 使用中台提供的费用汇总。

升级时若投影格式有变化，会自动从旧日志逐条重建，历史多时首次启动需要等待；之后正常启动直接复用投影。原日志和已有卡片链接保留，不需要手动迁移。

## 临时 HOME、CI 或没有服务管理器

使用临时 HOME 时不要装系统服务，不改真实用户的 shell 配置和 Agent 配置。保留调用者给定的 `AGENT_AUTOLOOP_HOME`；用真实 `CODEX_HOME` 只为了沿用已经完成的 Codex 登录。

在临时环境中选一个空闲端口，运行本地安装脚本，随后启动中台：

```bash
port=$(node -e 'const s=require("node:net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
AGENT_AUTOLOOP_REPO=/path/to/agent-autoloop sh /path/to/agent-autoloop/install.sh --agent codex --no-service --port "$port"
agent-autoloop up
```

`up` 会一直运行。在 Agent 的命令工具里保留它返回的运行中会话，再用另一条命令完成验证；不要用 `nohup … &` 代替，命令工具可能在退出时清理后台进程。看到监听地址后再运行验证命令；启动失败就先处理该会话里的错误。

PATH 没有命令时，把 `agent-autoloop` 换成安装器打印的完整路径。临时测试使用假的 `osascript`、`notify-send`，不要发送真实消息；不要给已在线的飞书应用再开监听。

## 验证

先查看安装和连接情况，再用真实 Agent 跑完整问答：

```bash
agent-autoloop --version
agent-autoloop doctor
agent-autoloop try
```

`try` 会使用用户的模型额度。在非交互终端，它打印问题和 `agent-autoloop answer` 命令后退出；这是正常等待，不是失败。把问题转给用户，按他的选择回答，再运行 `agent-autoloop status`，看到“试跑通过”才算接通。仅为安装验证时，可以选择第二项绿色完成试跑。

Claude 要委托 Codex 处理网页时，可用[浏览器交接模板](examples/recipes/browser-handoff/README.md)，先配置现成入口，再验收首次调用与原会话续办。模板不安装浏览器驱动、不自动放宽 Claude 命令权限。

任务还需要网页操作时，另按[浏览器接入](docs/plugins.md#浏览器接入)用同一后台启动方式核实实际页面和会话接续。`try` 只证明问答流程；中台不自动提供浏览器连接或修改 Agent 的工具配置。需要本人恢复连接、登录或验证时，保留待验收项并交 `ask`，不要反复重跑已完成的业务。

没有安装系统服务时，`doctor` 会显示服务未运行；检查中台、Agent 和桌面通道是否在线即可，不要为了消除这条提示安装真实服务。

## 写第一条规则

安装验证完成后，按用户希望自动处理的事从 [README 的场景模板](README.md#拿来即用的场景模板)选一个，再照[配置手册](skills/agent-autoloop/SKILL.md)写规则；用户还没指定用途时再问。用 `agent-autoloop check` 检查；改动几秒内生效。

国内业务可从反馈处理、网站巡检、飞书周报与业务摘要三套模板开始。它们默认飞书本人私聊；替换占位符后，配置和业务资料留在私有目录，不提交到仓库。模板不替用户新建凭据或扩大飞书权限。

桌面通知只在这台电脑上显示。需要别的通道时，先确认接收位置，再按配置手册接入。不要直接测试发信或发群消息。`access` 的含义见[插件说明](docs/plugins.md#access-实际能做什么)，不要替用户扩大权限。

## 卸载

卸载程序，默认保留规则、密钥和记录：

```bash
agent-autoloop uninstall
```

终端里确认后才执行；非交互运行时加 `--yes` 跳过确认，数据同样保留。它只停自己的服务和进程、删除指向自身的命令及 Skill 链接，以及安装目录里的 `app`。其他同名文件不动；数据目录不删除。

临时安装验证完，用 `agent-autoloop uninstall --yes` 停掉本次进程，再清掉自己创建的临时目录。不要卸载用户已经在用的中台。

## 文档

- [配置手册](skills/agent-autoloop/SKILL.md)：接事件插件、通道、多台电脑和交付流水线。
- [协议](docs/protocol.md)：HTTP、回执、事实日志和故障恢复。
- [插件](docs/plugins.md)：三个可运行的最小例子。
- [安全边界](SECURITY.md)：密钥、执行权限和交付审查。

开发检查用 `npm test`、`npm run typecheck`、`npm run format:check`，完整故障与性能检查用 `npm run test:nightly`。备份同时保留 `hub.db` 和 `master.key`；后者权限应为 0600。

公司 fork 的 CEO 模式：`npm run company -- ceo "$HOME/.agent-company"`；配置已授权机器人的本人私聊：`npm run company -- feishu "$HOME/.agent-company" ou_本人编号`，之后重启服务。需要 CLI 的机器人发消息、读取本人会话权限；不需要新增事件监听。[公司说明](docs/company.md#ceo-管理与飞书决策)。

公司持续运行：前台 `start` 不自动安装服务。关闭终端后仍需运行时，为公司独立 hub 配置系统用户服务，另以 `agent-company web <目录> 3361` 运行网页服务；两者设置登录启动与异常重启。可信 `sources.json` 支持每小时只读同步，格式见[数据连接](docs/company.md#数据连接)。

服务器常驻运行与带认证的 HTTPS 网页部署见[服务器部署](docs/company.md#服务器部署)；迁移时先停本机副本，保留任务账本和飞书问答。

公司飞书通知按具体事项显示，答复只确认一次，过滤内部巡检完成消息；回复格式为 `#编号 答复`，兼容旧 C 编号。

飞书可直接向 CEO 提问业务进展、员工工作或阻塞原因，无需待办编号。CEO 每轮只读查询最新业务账本、职责计划、负责人答复、交付记录和带采集时间的数据汇总；最近问答用于追问，缺失资料明确标注。普通对话既能查询，也能安排内部工作、设定目标和审核员工提案；CEO 自行判断并复用现有员工、验收和复查流程，落账后反馈具体安排。缺少关键信息时追问；对外发布、付款和生产变更仍未接入，编号审批继续可用。

公司调度默认不按项目或 CEO 的每日任务次数停工；并发、去重、有限修复与单任务派工上限保留。相同 CEO 待办复查两次仍无进展时记录管理停滞，新资料恢复。产品负责项目协作，网页员工列表显示当前责任与下一步；见[公司运行检查](docs/company-audit-2026-11-05.md)。

CEO 审核及失败重试读取当前交付，结论带版本；过期结论作废重审，待审孤儿自动补派。公司 CEO 模式：内部成果交 CEO 审核，退回会自动派修改任务；发布需配置工作区外的 `publishing.json` 固定渠道与适配程序。没有配置时由 CEO 处理并上报具体缺口，不会自动选择账号或虚构发布；详见公司文档“成果审核与发布”。

升级后 CEO 管理轮与对话轮均加载“负责人答复落账协议 v1”；普通聊天补充答案通过现有中台事件账本核对并同步原问题，无需新增飞书监听或权限。

公司升级会自动建立专用调度 worker（容量2），保留原模型 worker 和密钥；宿主配置的 workers 数组保存附加 worker。重启服务加载新配置，运行中旧任务由原 worker 接管。

公司可在私有 `company.json` 配置在岗岗位、关闭巡检、仅按事件唤醒 CEO 及每日模型次数上限；默认保持旧行为，见[模型调用控制](docs/company.md#模型调用控制)。达到额度的工作次日继续，负责人消息仍处理并计数。

跨机小红书发布需独立 `company-publisher` 账号、无参数 sudoers、受来源限制的 SSH 强制命令及固定主机指纹；模型实际沙箱的 sudo、旧机网络及私钥读取探测必须失败。私有渠道配置与共用日额度、前五篇确认见[小红书发布](docs/xiaohongshu.md#跨机发布窄通道)。安装保持 connector.enabled=false，不运行真实发布验收。

公司文字配图需另装 Chrome for Testing chrome-headless-shell 与 Noto CJK/Emoji 系统字体，并以员工实际身份、沙箱验收；知识模板部署到 workspace/knowledge，见[文字配图](docs/xiaohongshu.md#内容质量与文字配图)。

Claude Code 需 2.1.317 或更新版本；Linux 安装 `bubblewrap`、`socat`。服务 OAuth 仅放在 root:root 0600 的环境文件，通过 systemd `EnvironmentFile` 加载，不与 `ANTHROPIC_API_KEY` 共存。切换公司模型前必须以实际 worker 身份验证 sudo、旧机网络、私钥/环境文件读取及目录外写入均被拒绝，并确认正常认证调用成功；未通过就保持 Codex。详见[权限边界](docs/plugins.md#access-实际能做什么)。

公司额度升级需同步公司模型包装器、模型适配器与 `worker/agents.ts`；当天已登记日报/周报不受额度阻挡，确认未开始模型工作的失败自动冲回，旧启动账目不改写，详见[模型调用控制](docs/company.md#模型调用控制)。

公司 rabbitrun 业务、root 发布入口及飞书手动发布确认的安装边界见 [海外运营配置](examples/recipes/company/rabbitrun.md)；不要用真实发布验证安装。

公司等待校验升级须同步 executive、operations、waiting 和 setup 插件并运行既有规则刷新；无需修改内核或手改业务数据库。

公司程序巡检在私有 `company.json` 中启用 `health:{"enabled":true}`，同步本次公司插件及后台文件并刷新可信规则。独立看门狗使用仓库 `plugins/company/watchdog.service` 与 `.timer`，按实际安装路径检查后分别安装为 `agent-company-watchdog.service` / `.timer`；私有公司目录的 `watchdog.json` 只写 `{"callbackUrl":"http://127.0.0.1:3362/"}`（按实际回调端口设置），收件人和飞书CLI复用私有通道配置。先以假服务/假CLI验收，再在真实服务健康时启用timer；不发测试消息。升级前确认没有运行模型、备份业务库与规则、仅同步改动文件；引擎和后台需重启，回调服务无需重启。详见[独立看门狗](docs/company.md#独立看门狗)。

公司周复盘在私有 company.json 启用 `reporting:{"enabled":true,"weekly":true}`，同步公司插件与后台、刷新规则后，调用 `Operations.initializeNotes()` 从既有资料初始化；不触发经营轮次。笔记在私有 operations.db，先备份且无运行模型才部署；见[工作笔记与周五复盘](docs/company.md#工作笔记与周五复盘)。

公司选题会为可选配置，部署步骤和兼容边界见[选题会](docs/company.md#选题会与账号人设)。升级前确认没有运行中模型轮次、备份私有公司数据，只同步改动文件；启用 `topics.startAt` 时同步公司程序、规范、飞书通道和网页。共享指南副本及员工笔记只写私有工作区，回调服务无需重启，也不新开飞书监听。

拍板修复需同步公司模型包装器、协调器和通道，并刷新既有规则与手册；卡片执行结果保存在私有公司账本，原消息就地更新。备份且确认无运行模型后只同步改动文件、重启公司引擎；回调服务不需重启。

币安人工回执修复须同步部署公司发布入口、经营程序、通道和工作台；无链接人工回执不兼容旧校验器。只读核对已有结果或真实异常卡答复，禁止以重新发布验证修复。

公司可在私有配置启用 `delegation.source`：CEO 按手册评分拍板选题并决定发布，普通问题交后台维护清单；董事长仅收日报、X 待发及支出/本人验证/宕机通知，不再周五索要数据。每日发布限额、合规与回执核验保持，旧配置兼容；见[CEO 授权](docs/company.md#ceo-授权与维护清单)。
