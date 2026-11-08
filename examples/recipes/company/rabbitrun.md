# rabbitrun 币圈内容

`rabbitrun` 经营个人内容账号（X `@rabbitrun_eth`、币安广场 `rabbitrun_eth`），不推广 App；在岗员工为 growth 岗的“海外运营”。CEO 每周定 7 篇目标，每日最多 1 篇；上班时间沿用公司 workday 规则，09:00 后正常调度。每日额度：CEO 20、每位运营 20，运营合计 60、公司 80。

## 内容和确认

海外运营必读 `workspace/knowledge/crypto-content-guide.md`，CEO 按“合规红线”和“CEO 审核清单”审，红线一票否决。原始指南 SHA-256 为 `50193b87ed7d30176a49631882966550ae7980cb966253dbd2d8b24a48cdaed9`；仓库版在校验成功后追加了从本机 Chrome 读到的首篇原文。

交付 `tasks/<任务>/rabbitrun.json`：`{title, content, images:[{mime, base64}]}`，0–4 张 PNG/JPEG/WebP，总文件不超过 1MB；建议正文 300–800 字。发布程序将标题放在正文第一行；两平台使用完全相同的长帖，不拆串。来源和审核说明另存文件，不进入发布包。

私有 `company.json` 增加 `publishPolicies.rabbitrun: {dailyLimit:1, alwaysConfirm:true}`。此项永久逐篇确认，不随成功篇数关闭，不走一小时自动发布预告。CEO 审核通过后飞书卡显示标题、全文、图片数、两个目标平台；董事长退回意见沿原计划交员工修改，新稿重新审核确认。记住、今朝的确认规则和 `content-guide.md` 保持不变。

## 币安窄通道

实现依据：[官方 square-post 文档](https://github.com/binance/binance-skills-hub/blob/main/skills/binance/square-post/SKILL.md)、[官方请求实现](https://github.com/binance/binance-skills-hub/blob/main/skills/binance/square-post/scripts/lib.mjs)。纯文字和最多 4 张图片；不设置文章标题栏，标题在 `bodyTextOnly` 第一行。

- `POST /bapi/composite/v1/public/pgc/openApi/content/add`，`contentType=1`、`bodyTextOnly`、可选 `imageList`。
- 图片走 v2 `image/presignedUrl` → PUT → `image/imageStatus`，最多轮询 10 次，与官方流程一致；上传请求不携带发布 Key。
- Key 是 `/etc/agent-company/binance-square.env` 中的原始单行密钥，root:root 0600；不 source、不放环境、命令行、输出或版本库。该文件后缀只是部署约定。
- root 所有的固定 `/usr/local/libexec/company-rabbitrun-publish` 禁止参数，清空环境后调用 `cli/company-rabbitrun-publish.ts publish`。sudo 白名单仅授权该固定命令，CEO/员工不能读取 Key。
- 程序重新读取冻结稿、经营日志中的逐篇确认及内核确认卡，不能凭 stdin 中的文案或批准声明发帖。只在官方响应含可核验帖子 ID 时记成功。
- 请求前持久化意图，响应丢失、504、未知结果不算成功且不重发；需要人工核对。根目录状态 `/var/lib/agent-company-publisher/rabbitrun`，后台投影是 `publications/<key>-result.json`。

## X 在 Mac 上交互执行

2026-11-09 实测：launchd 启动的 `codex exec` 能列出 computer use 工具，但实际 Chrome 浏览器接口失败，原生 Chrome 操作未获工具授权；因此**没有安装自动发帖定时任务**。队列在后台和飞书中显示“X 待发，需要在 Mac 上执行”。这与桌面会话可以读取已登录 Chrome 是不同的执行条件。

在 Mac 终端执行一条命令：

```sh
rabbitrun-x
```

该本机入口从 `ssh company-server` 的固定 `company-rabbitrun-x` 命令领取已确认且币安已发的稿件，打开交互 Codex，使用本机 computer use 新标签页发送长帖并上传已审图片。需要桌面权限时由本人在交互会话处理；登录、验证码、风控必须停下，不绕过验证。非交互调用被拒绝，不会从 launchd 误启动发帖。

`rabbitrun-x list` 只列待处理状态；只有一个已领取的 X 任务可以处理，每日最多一篇，不自动重试。点击发布后结果未知，先人工核对原帖，禁止再次发送。真实链接可由交互会话通过 `rabbitrun-x complete <审核编号> https://x.com/rabbitrun_eth/status/<帖子ID>` 回写；失败用 `rabbitrun-x fail <审核编号> login|verification|risk|failed|unknown`。回写断网时，本机私有 `~/.local/state/agent-company/rabbitrun/result.json` 保留已验证链接，下次先同步，不重复发帖。待发文案与图片只保存在该私有目录，不进仓库。

第一阶段只记录币安和 X 发布回执，不抓取互动或账号数据；币安回执登记不会冒充 X 已发，也不会触发小红书采集或新增效果复盘任务。飞书状态提示由既有经营轮次通过幂等通知发送，不直接调用飞书或另开监听。

## 部署

先确认没有 running 模型轮次，备份配置及数据库，通过 stdin 安全传输 Key，仅核对前 5 后 4 位。只同步变更文件，固定入口及代码由 root 所有，sudoers 用 `visudo -cf` 校验；用 `setupRabbitrun` 注册业务、员工和配置，不调用 `plan`，不发事件或触发模型。重启引擎和网页前后核对状态。不得用真实账号做测试发布。
