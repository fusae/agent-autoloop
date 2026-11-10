# rabbitrun 币圈内容

`rabbitrun` 经营个人内容账号（X `@rabbitrun_eth`、币安广场 `rabbitrun_eth`），不推广 App；在岗员工为 growth 岗的“海外运营”。CEO 每周定 7 篇目标，每日最多 1 篇；上班时间沿用公司 workday 规则，09:00 后正常调度。每日额度：CEO 40、每位运营 20，运营合计 60、公司 100；主动经营与普通CEO轮次共用额度。

## 内容和确认

海外运营必读 `workspace/knowledge/crypto-content-guide.md`，CEO 按“合规红线”和“CEO 审核清单”审，红线一票否决。原始指南 SHA-256 为 `50193b87ed7d30176a49631882966550ae7980cb966253dbd2d8b24a48cdaed9`；仓库版在校验成功后追加了从本机 Chrome 读到的首篇原文。

交付 `tasks/<任务>/rabbitrun.json`：`{title, content, images:[{mime, base64}]}`，0–4 张 PNG/JPEG/WebP，总文件不超过 1MB；建议正文 300–800 字。发布程序将标题放在正文第一行；两平台使用完全相同的长帖，不拆串。来源和审核说明另存文件，不进入发布包。

私有 `company.json` 增加 `publishPolicies.rabbitrun: {dailyLimit:1, alwaysConfirm:true}`。未启用 `delegation.source` 时此项逐篇确认，不随成功篇数关闭，不走一小时自动发布预告。CEO 审核通过后飞书卡显示标题、全文、图片数、两个目标平台；董事长退回意见沿原计划交员工修改，新稿重新审核确认。记住、今朝的确认规则和 `content-guide.md` 保持不变。

## 币安窄通道

实现依据：[官方 square-post 文档](https://github.com/binance/binance-skills-hub/blob/main/skills/binance/square-post/SKILL.md)、[官方请求实现](https://github.com/binance/binance-skills-hub/blob/main/skills/binance/square-post/scripts/lib.mjs)。纯文字和最多 4 张图片；不设置文章标题栏，标题在 `bodyTextOnly` 第一行。

- `POST /bapi/composite/v1/public/pgc/openApi/content/add`，`contentType=1`、`bodyTextOnly`、可选 `imageList`。
- 图片走 v2 `image/presignedUrl` → PUT → `image/imageStatus`，最多轮询 10 次，与官方流程一致；上传请求不携带发布 Key。
- Key 是 `/etc/agent-company/binance-square.env` 中的原始单行密钥，root:root 0600；不 source、不放环境、命令行、输出或版本库。该文件后缀只是部署约定。
- root 所有的固定 `/usr/local/libexec/company-rabbitrun-publish` 禁止参数，清空环境后调用 `cli/company-rabbitrun-publish.ts publish`。sudo 白名单仅授权该固定命令，CEO/员工不能读取 Key。
- 程序重新读取冻结稿和经营日志；授权模式核对该版本CEO发布决定，旧模式核对逐篇确认及内核确认卡，不能凭 stdin 中的文案或批准声明发帖。官方响应含精确帖子 ID 或匹配的币安帖子链接时记 API 成功；JSON 大整数按原值解析。
- 请求前持久化意图，响应丢失、504、未知结果先只读核对，不自动记成功、不重发。保留脱敏错误类别、HTTP 状态、数字错误码和字段类型，不能恢复旧版未保存的原始响应。根目录状态 `/var/lib/agent-company-publisher/rabbitrun`，后台投影是 `publications/<key>-result.json`。

发布异常卡的本人按钮或编号文字答复如“币安已发出”“已发出”，可附币安帖子链接。固定入口重新核对异常卡及冻结稿，登记 `confirmation`（来源 chairman、原卡编号、答复事件和时间）；没有链接则编号与链接为空，明确显示“董事长确认已发，链接待补”。公司任务及计划通过各自日志补账、解除阻塞，原卡按真实回执更新；不会派模型或再发帖子。普通聊天、发布前批准和 CEO 自述均不作为此回执。只读核实后可由维护人员补链接，不覆盖已有链接或代确认 X。

## X 手动发布

CEO授权模式审稿决定后（旧模式为董事长确认稿件后），服务器通过 API 发币安广场；经营周期以每篇固定去重键发一次“X 待发，请手动发布”飞书卡片。卡片从冻结稿读取标题和完整正文，保留换行，不受内核通知文字长度限制；复用飞书图片上传展示配图，另提供后台全文和配图链接，图片上传失败仍可查看。公司飞书通道配置 `dashboardUrl` 为后台 HTTPS 地址。

`/v1/tell` 的初始通知在内核是 closed/version=1，通道依据 X 回执把它显示为待发操作卡；不能把这个初始状态当作用户关闭。旧版空回执的漏送卡会原编号补送，X 确认后原卡更新；用户主动关闭的后续版本不重开。

卡片仅一个确认按钮“我已在 X 发布”，不要求链接。回调复用 `/feishu/card-callback` 的 Verification Token 校验、持久去重，以及通道中的董事长身份、原消息、卡片版本和动作核验；调用服务器固定 `/usr/local/libexec/company-rabbitrun-x` 回写后关闭通知，不生成事件或模型轮次。sudo 白名单将回写入口授权给公司通道的系统用户（撤销原 Mac SSH 用户的专用授权）。此无参数 root 入口仅接受标准输入 `list` / `complete`，不再提供领取或自动发送；`complete` 可选 `url`，必须是本人账号真实帖子链接。先持久化回执再关闭通知，响应丢失重放不会发帖或丢结果。

后台首页显示“X 待发”、复制全文、全文和配图查看/下载；确认后显示“X 已发”，有链接则展示链接。未确认不单独重复提醒，从北京时间次日日报起汇总一句待发篇数，确认后移除。历史 claimed/failed 仍按待手动核对展示；published 无链接表示本人确认，不宣称抓取验证。

Mac 不安装程序、Node 副本或 launchd 发布任务。原本机交互入口已删除；服务器保留待发队列与回写接口。部署验证只读状态，不发飞书测试消息、不触发轮次、不发布帖子。

启用 `delegation.source` 后逐篇确认和发前预告均取消；CEO 按 rabbitrun 手册评分选题、审稿决定发布并记录理由。所有合规、限额与回执护栏保持，X仍手动发且不催；见[授权约定](../../../docs/company.md#ceo-授权与维护清单)。
