# 安全

发现安全问题，请用 GitHub 的 [Security Advisories](https://github.com/KKKKhazix/agent-autoloop/security/advisories/new) 私下告诉我，不要开公开的 issue。

私密漏洞报告入口需要仓库公开并启用该功能。入口不可用时，只在 Issue 中说明“需要私密联系维护者报告安全问题”，等维护者安排私密渠道；不要贴漏洞细节、密钥或业务资料。

私密报告请提供受影响的提交版本、运行环境、最少复现步骤和可能影响，日志与截图先脱敏。目前在最新 `main` 上验证和修复安全问题，没有单独维护的长期支持分支，也不承诺固定响应时间。

## 边界

- 中台默认只听本机。要对外，前面放一个做 HTTPS 的反向代理。
- 安装器和中台启动时把数据目录设为 `0700`，已有目录也会修正；数据库、事件正文和运行输出因此不向其他系统用户开放。这不隔离同一系统账号下的进程。
- 事件决定不了交给谁、在哪个目录、用哪个 Skill、给什么权限，这些只由 `rules.json` 决定。别人写的标题和正文不进提示词，只放进标明“是资料”的文件；提示词里只有校验过字符的类型、编号和链接。这挡不住所有提示注入：Agent 还是会读到别人写的话。所以默认权限是 `edit`，给 `full` 之前想清楚这个 Agent 能碰到什么，有副作用的事走 `askFirst`。
- `access` 由专用 Agent 插件映射到 CLI 权限；`command` 不替任意程序限制权限。普通 Agent 的 `read` 不等于读不到这台电脑上的密钥。要隔离密钥，用单独的系统账号或容器。
- 普通访问密钥只存 SHA-256，另有本机 `master.key` 推导轮次和卡片链接的 token。接单程序不通过提示词、资料或环境变量传递中台凭据；同一系统账号下能读哪些文件仍由 Agent 沙箱决定。回执能影响的范围见 `docs/protocol.md`。
- 卡片链接谁拿到谁就能回答这一张卡片，7 天内有效，只发给配了 `"links": true` 的通道。
- 本项目只启动你自己安装、自己登录的官方命令行工具，不接触、不保存、不中转它们的登录凭据。
- 浏览器能力由 Agent 自己的工具配置提供；专用入口只从可信规则或 Skill 取得，不从事件正文取命令。中台不自动授予浏览器权限或接管桌面会话。需本人恢复的连接或验证用 `ask` 交回，保留未验收项。

## 插件与交付

插件是安装者信任的本地代码，安装目录的同名插件优先；`agent-autoloop add` 只克隆，不运行安装脚本，但之后加载入口就会执行它。事件不能指定插件、仓库、命令或权限。

ACP 的授权依赖 Agent 遵守协议。桥接只按结构化工具种类、编辑路径与一次性选项作决定，不提供文件或终端服务。MCP 使用本机已有身份，只提供协议列出的七种操作。撤销密钥立即终止其长轮询和日志订阅；轮次 token 独立。

交付只接受规则指定仓库内的分支到 main。项目设置、审查要求、替换审查命令均读 main；PR 只下载 Git 对象，生成文字差异，不检出、不运行 PR 的代码、测试、配置或 hooks。默认 Codex 禁用用户配置与记忆，只读隔离的快照。自定义审查命令由项目管理者负责提供同等权限约束。

审查成功状态只在同一提交的完整检查通过后写入；合并前再次核对提交、标签和 main，等待检查期间新增 `deliver-review` 也会阻止合并。项目仍需在 GitHub 配好自身合并规则，插件不能代替平台权限。已合并的 PR 只继续核实 Ship 与健康版本，不重复合并。健康 URL 默认要求 HTTPS，只有显式测试开关允许 HTTP 127.0.0.1；跳转和不合格的版本不能证明上线。

桌面通知的正文包含 Agent 写的卡片标题，只作为参数传给 `osascript` 或 `notify-send`，放在 `--` 之后，不拼进脚本。Webhook 模板没有外部幂等保证；发送成功但报告丢失可能重复。链接回答是持有即授权，不能把链接发到公开位置。飞书应用只能保留一个卡片事件监听；本仓库测试只使用假 CLI。

## 场景资料

公开模板只包含虚构数据、示例域名和占位标识。反馈内容、网页响应与飞书资料都不能指定命令、目录、权限或收件人；反馈的现状与决定从可信业务接口重新读取。飞书汇报和表格用本人身份读取，不能换成机器人身份补齐看不到的数据。摘要输入保存在本人私有目录，完整读取后才替换，通知不携带敏感正文。

通道接收人属于整个中台，规则不能单独挑收件人。处理私人反馈和汇报的中台应只连接本人可见的通道；不要把它们接到共享群。新增接入沿用用户自己的身份与授权，不复制内部部署配置、密钥或业务日志。

浏览器交接模板的命令数组、目标网址和允许操作来自本人的可信配置，按参数传递，不把任务文字交给 shell 解释。允许操作是给 Agent 的任务范围，不是额外的系统沙箱；实际工具和账号权限仍由既有运行环境决定。会话编号只用入口实际返回的值；中断或结果不明先核实，不盲目重复有副作用的网页操作。模板不修改应用内部状态、不自动启动新的账号授权，也不打包某台电脑的浏览器修复脚本。

## 日志与恢复

门的权限、通道回答人和原消息、轮次 token 的范围、重复回执与卡片回答都有行为和一致性检查。`sim/invariants.ts` 是模拟与穷举共用的不变量；夜间检查另外对真实 SQLite 进程做 SIGKILL。范围是进程崩溃和有限场景，不等同于断电恢复证明或完整安全审计。

`kernel/` 不读时钟、不取随机数。判断、事实追加和 `evolve` 更新投影在同一 WAL + FULL 事务里完成，提交后才应答。正常启动复用带游标和编号高水位的投影；格式指纹变化时从日志逐条重建，不改变旧事实。`agent-autoloop why 42` 查一轮的事件、规则和回执；`GET /v1/stream?after=42` 供本人客户端按序号续读。备份要一起保留 `hub.db` 和权限为 0600 的 `master.key`；后者推导轮次和卡片链接的 token。普通访问密钥只保存哈希；卡片链接查找索引也只保存 token 的哈希。

## 公司协作扩展

公司插件固定部门来源、阶段和派工编号，老板审批只从中台验证后的回答读取。它提供流程边界，不提供多租户隔离；模型依然以本机用户运行，权限含义沿用上文。公司工作区禁止自动发布、付款、发送外部消息，接受交付只归档。真实隔离需操作系统或容器权限。

公司目录包含 `hub/config.json` 凭据、业务资料和 SQLite 数据库，必须留在仓库外，不提交 Git。单任务最大派工次数和并发约束仍保留；默认不设每日次数上限；可在私有 company.json 配置 dailyModelRuns，它限制模型派出次数，不构成服务商金额上限。

公司网页仅监听 127.0.0.1，严格校验 Host；写入额外要求同源 Origin 与随机 CSRF token。本人/来源密钥仅在服务端使用，不返回浏览器。文本交付物仅可读取账本登记且真实路径在 workspace 内的文件。默认工作台信任本机用户，不提供多用户权限。服务器部署必须由前置 HTTPS 代理对全部页面、静态资源及 API 认证；仅将可信服务环境变量 `AGENT_COMPANY_PUBLIC_ORIGIN` 设为精确 HTTPS 来源，代理保留真实 Origin、将 Host 固定为回环上游。不要直接暴露 3360/3361，也不要把来源改写成可信值以绕过 CSRF。

经营档案和指标保存在私有 `business.db` 与工作区资料中，不写入公开源码；经营巡检是固定程序，沿用中台 cron 与事件授权。启动经营授权周期模型工作，不授权发帖、广告付费或线上变更。暂停不撤销已派发的任务，未完成周期不会继续堆叠。

员工责任档案、计划、信号和调度记录保存在私有 `operations.db`。结构化检查仅能提出四种内部工作类型，不能指定执行目录、权限或外部操作；调度器验证编号、限额和字段后走既有部门规则。内部任务的自动归档仅省去普通交付确认，不省去独立 QA，不授予发布或付款权限。重复工作由输入指纹、稳定编号和有界重试约束；相同 CEO 待办最多额外复查两次，不限制有新事实的合法工作。职责说明为模型工作约束，不是操作系统隔离。

公司 CEO 飞书通道使用机器人身份，只读取配置本人的私聊，以明确的 # 待办编号匹配答复（兼容旧 C 编号）；同时验证本人 open_id、卡片状态及原消息引用。普通聊天由 CEO 理解后提交受约束的内部决策，不自动批准已有卡片；其他人的消息不进入此入口。机器人凭据由 lark-cli 保存，通道密钥、消息状态及问答保存在私有公司目录。CEO 的解答和负责人的原话均为业务资料，不能改变可信规则、执行权限或收件人。发送/接收测试只用假 CLI。

公司数据连接只从本地可信 `sources.json` 读取 URL、主机、仓库文件和聚合查询，模型输出不能改变这些配置。SSH 使用非交互认证和现有 sudo 权限，SQL 仅 SELECT 且连接只读；这限制本插件查询，不缩减本机账号原有权限。配置者须选择不含用户标识与反馈原文的汇总查询。快照与配置留在私有公司目录；连接失败保留旧值及原成功时间。每条查询最多 25 行并标注截断，不能将部分结果当作完整统计。自动恢复不绕过模型权限、业务暂停、单任务派工上限或中台跳数限制。

服务器只读数据库可配置固定绝对路径 `localDatabase.helper`。该程序由部署者维护，不能来自模型输出；生产数据库无需复制或向员工开放权限。使用 sudo 时只放行 root 拥有、固定查询且不接受参数的读取程序，不授权 shell、通用 Python 或任意 SQL。

公司飞书通知的静默过滤仅影响展示，不改变中台事件和回答权限；静默版本仍确认投递，保留原消息引用。未发送过消息且静默处理的事项允许空引用，但不能用于接受飞书答复。

CEO 普通问答只接受配置本人的文本；固定来源密钥从私有 inboxFile 读取，内容仅作事件资料，不决定规则或权限。对话规则仅能以固定 company-ceo 来源发出 company.ceo.decision，协调器复用管理轮的字段与项目校验，在同一事务内记录决定及去重键、创建内部计划和回执。不能指定任意 Agent、目录、命令或发布/支付类型。非法决定不部分执行，失败不伪装成成功；对外操作未接入。CEO 模型仍使用只读文件权限，业务写入由固定协调器完成。实时简报只输出选定业务字段和数据汇总，不输出配置密钥、卡片令牌或原始个人信息。数据库使用只读连接；模型运行身份的文件读取边界仍由现有 OS/沙箱控制，不把只读简报误当作凭据隔离。

Company publishing uses an operator-owned `publishing.json` outside the model workspace. Only a CEO-reviewed, frozen subset of registered deliverable files can reach the fixed command; model text never supplies executable paths or arguments. The adapter must implement stable-key idempotency and authoritative platform lookup. Unknown platform results block execution, and observation requires a verified receipt plus QA. Keep credentials inside the trusted adapter, not in event data or deliverables.

Company owner-reply decisions reference authenticated inbox event IDs, never model-written owner quotations. The coordinator checks source, message completeness and chronology against its read-only hub ledger, records the original text, and answers only the question’s matching card through the authenticated hub API. Duplicate or invalid references cannot partially apply a decision.

Co-located workers persist their worker identity with each execution and must not settle, cancel or count another worker’s entries. Only the original primary worker adopts legacy unnamed entries; extra workers use separate scoped credentials.

公司模型控制与计数仅在插件层实现，不修改内核。模型包装保留既有模型、目录和权限；负责人对话的额度例外依据可信规则名称，不依据事件正文；日报/周报例外仅认经营账本登记的当天任务。额度冲回只认适配器原始输出与退出证据或进程启动失败，不认业务文字，未知仍计数。取代关闭只接受独立 company-owner 来源，不授予普通部门该事件来源；只能关闭暂停任务，不伪造发布或负责人答复。

公司发布护栏在插件固定程序内执行：同渠道事务预留、北京时间日额度、冻结稿件的本人一次性确认及发布入口复核。跨机私钥由独立系统账号持有，sudoers 仅授权无参数固定转发程序，SSH 限来源、禁转发、固定强制命令并严格核验主机；必须实测模型沙箱不可 sudo、不可连接旧机、不可读私钥。未知发布预留不能自动跨日释放；回滚先撤销通道，不能用旧代码绕过待决确认。详见[窄通道](docs/xiaohongshu.md#跨机发布窄通道)。

文字配图仅把转义后的本地内容交给系统浏览器，员工保持原沙箱，固定代渲染服务使用独立用户、无外网命名空间、只读系统及隐藏公司凭据，不授予发布或提权能力；查重资料只读工作区内登记的交付文件，拒绝越界路径和符号链接。知识文字是资料，不改变可信提示词或权限。

Claude 适配器每轮用不含凭据的内联 settings 强制自身沙箱：不允许不可用时继续、无沙箱回退或弱隔离；停用用户/项目设置、hooks 和外部 MCP，限制工具集合、目录外写入及敏感路径读取。OAuth 只透传给 Claude 模型入口，并从沙箱 shell 环境移除；同时配置 API key 即拒绝启动。内置文件工具不是 OS 沙箱，分别受权限规则约束；更高优先级管理策略仍需部署时核验，不能用参数测试替代真实隔离验收。
