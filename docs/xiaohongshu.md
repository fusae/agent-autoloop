# 小红书发布

使用 [xpzouying/xiaohongshu-mcp v2.7.2](https://github.com/xpzouying/xiaohongshu-mcp/releases/tag/v2.7.2) 作为独立浏览器服务，不是小红书官方发布 API。公司内核和 Node 项目不增加运行时依赖。服务仅监听 `127.0.0.1:18060`，设置独立 Bearer token；cookies、配置、图片、发布记录在公司工作区和 Git 仓库之外。服务器上扫码登录，账号失效由 CEO 请求重新扫码。

## 登录与账号

私有配置 `connector.json`：

```json
{"endpoint":"http://127.0.0.1:18060","token":"私有服务密钥","accountId":"","enabled":false}
```

运行（Node 24）：

```sh
node plugins/xiaohongshu/manage.ts login /private/connector.json /private/login.png
node plugins/xiaohongshu/manage.ts status /private/connector.json
node plugins/xiaohongshu/manage.ts preflight /private/connector.json
node plugins/xiaohongshu/manage.ts bind /private/connector.json
```

用户用目标小红书账号扫码后，`bind` 固定平台返回的账号编号；不凭昵称猜账号。绑定仍保持 `enabled:false`，由操作者核实账号范围、登录状态及负责人的发布授权后再设置为 `true`。不用提供密码。二维码和 cookies 不进入员工资料。

`status` 只看普通账号；`preflight` 只读核对启用状态、绑定账号和创作者发布页，返回 `{"loggedIn":true,"canPublish":true}` 表示当前登录检查通过，不代表稿件已审核、平台已接收或允许绕过日额度。它只调用 GET，不上传图片、不点发布、不创建二维码、不改 cookies。

### 创作者登录检查补丁

v2.7.2 的 `xiaohongshu/creator_session.go:ensureCreatorSession` 原先只检查 `galaxy_creator_session_id`；缺失时打开首页等待15秒，仍没有就报登录失效。图文和视频发布都调用此处。固定发布入口另外用 `/api/v1/login/status`、`/api/v1/user/me` 核验普通账号，不能发现这个误判。

2026-11-11只读排查：现有 cookies.json 与 Rod user-data 的 cookie 名称、域和有效期一致；含 `web_session`、`id_token`，均无旧 cookie。仅加载 cookies.json 的新浏览器能打开创作者首页和发布页，看到图文标签与上传控件，无登录跳转或二维码。说明旧名不是当前登录的必要条件；没有证据证明平台将它重命名成了哪个字段，不用替换、伪造或补造 cookie。

补丁放在 `plugins/xiaohongshu/upstream/`，仅用于独立 Go 服务，不增加 Node 运行时依赖。发布检查和新增的鉴权 GET `/api/v1/login/creator-status` 共用真实页面判定：发布页地址、可见上传区、图文标签及文件控件都存在，且没有登录/二维码/验证提示才通过。登录明确出现才返回未登录；空白、超时、陌生页面和平台验证返回未知/需检查，不把网络故障变成董事长扫码任务。不点击、隐藏或移除平台验证元素。

从上游 `539d296f5623ab1a359065d8dc74dccfb237b05a`（v2.7.2）准备独立源码目录，保留其 Apache-2.0 许可；使用 Go 1.27.3：

```sh
node plugins/xiaohongshu/prepare-upstream.ts /private/xhs-source
cd /private/xhs-source
XHS_TEST_BROWSER=/absolute/test-chrome go test ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w -X main.version=v2.7.2-creator-page' -o server .
```

准备程序校验被替换上游文件的 SHA-256，版本不符则停止；浏览器回归拦截全部页面请求，仅返回本地固定 HTML，不访问小红书。`npm test` 还执行同一页面判定及只读预检的回归。部署先确认无运行轮次或发布请求，备份服务二进制和私有会话，仅替换该服务及改动的维护命令，重启小红书服务；上线以 `preflight` 验证。旧发布接口、错误字符串和历史发布记录保持兼容，新 `preflight` 必须配合补丁服务使用。没有待发稿时只结清登录阻塞，不能恢复或重发历史尝试。

## 图文交付

运营交付标题、正文及 1–9 张 PNG/JPEG/WebP 图片；当前冻结协议限制最终 JSON 总大小 1MB，图片应先压缩。标题最多20字符、正文最多1000字符；初版不做视频、定时发布、评论、私信或带货。标题和正文之外不自动插入文案、标签或追踪标记。

正文 JSON：`{"title":"标题","content":"最终正文"}`。将实际图片封装进审核稿：

```sh
node plugins/xiaohongshu/manage.ts pack post.json tasks/原任务/xiaohongshu.json cover.png page2.jpg
```

交付 `xiaohongshu.json` 并登记对应原图供审核。CEO 审核真实正文和图片，发布时明确选择已交付的 `xiaohongshu.json`；其中图片已转为 base64，与文本一并冻结，审核后改动原图不会改变发布内容。旧 Markdown 草稿不能直接发小红书，应沿原计划退回运营补成图文稿，不重复建立同名计划。不允许稿件指定网址、本机图片路径或发布命令。

私有 `publishing.json` 按已确认账号范围配置项目：

```json
{"projects":{"jizhu":{"channel":"小红书·账号名","timeoutMs":600000,"command":["/absolute/node24","/absolute/app/plugins/xiaohongshu/publish-run.ts","/private/connector.json"]}}}
```

## 核验与故障

每次操作先确认登录和绑定账号，查询本人笔记；提交前写入并刷盘原发布编号、稿件指纹和开始时间。超时、断连、审核中、查不到笔记均保留原任务，不盲目重发。进程级锁防止同账号并发发布；异常退出遗留锁必须先核对平台再清理。

上游返回“发布完成”没有笔记编号，不能当作成功。本适配器再查本人笔记和详情，核对账号、唯一标题、正文、图片数量、笔记编号和平台时间，才返回真实 HTTPS 链接交给配置指定的核验入口。图片数量核验不等于图片像素一致性或业务效果验收；缺省QA仍查看实际帖子；program模式由独立只读程序回读核对。列表未展示、同名歧义或正文经平台改写时保留待核验，不能编造链接或再次提交。

固定发布入口遇到超时、断连或未知回执后，用既有 later 在15分钟、再1小时后只读核对原冻结编号；每轮立即结束，不占模型额度，不重新提交。两次仍未知才保留阻塞交维护者，名额不释放；过期任务的复查不影响新派工。

普通账号登录正常不代表创作者中心仍登录。上游明确返回创作者中心登录失效时，适配器保存本人验证阻塞，后续 lookup 保留该原因，不重复提交、不自动扫码，也不暴露原始接口详情。本人扫码后由维护者先只读核实，再恢复原任务；确认未提交才可归档失败尝试、释放预留，未知仍保留。旧记录没有阻塞字段时继续按未知处理。

排查浏览器卡死须同时检查服务 TasksCurrent/TasksMax、memory.events 和未结束的浏览器请求；健康接口正常不能证明浏览器可用。只在确认无运行中的发布后备份并重启服务，依据实测资源峰值调整本机限制，不以增加请求超时掩盖资源耗尽。

账号未绑定、图文未交付和登录过期给 CEO 返回具体原因。外部发布只有在平台可读回后才记完成；模拟测试不代表生产发布验证完成。

## 跨机发布窄通道

发布服务、登录态和 `connector.json` 留在国内旧机；公司新机不保管小红书 cookies 或服务 token。新机使用独立、无密码、`nologin` 的 `company-publisher` 系统账号保管 SSH 私钥（0600，home 和 `.ssh` 0700）；root 拥有的 `/usr/local/libexec/company-xhs-publish` 不接受参数，只转发 stdin 并返回适配器 stdout。sudoers 的命令末尾必须写 `""`，禁止 agentcompany 添加参数；脚本使用固定 `/usr/bin/ssh`、空环境、`-F /dev/null`、固定私钥和 known_hosts，严格校验旧机主机公钥，不允许转发。

旧机仍使用运行服务的账号；`authorized_keys` 必须限制新机公网来源，并设置 `restrict,command="/absolute/node24 /absolute/app/plugins/xiaohongshu/publish-run.ts /private/connector.json"`。适配器仅接受 `lookup`、`publish`，不执行 SSH 请求中的任意命令，也不提供登录、评论、私信或读取任意文件的入口。主机公钥经已有可信运维连接取得，不能以未经核验的扫描结果替代。

两个 APP 共用账号时，`publishing.json` 的两个项目必须使用完全相同的 `channel`：

```json
{"projects":{"jizhu":{"channel":"小红书·负责人个人账号","command":["sudo","-n","-u","company-publisher","/usr/local/libexec/company-xhs-publish"],"timeoutMs":600000},"jinzhao":{"channel":"小红书·负责人个人账号","command":["sudo","-n","-u","company-publisher","/usr/local/libexec/company-xhs-publish"],"timeoutMs":600000}}}
```

`sudo` 是唯一允许省略绝对路径的入口名，固定解析为 `/usr/bin/sudo`，不通过 PATH 查找。私有 `company.json` 设置 `"publishDailyLimit":1,"publishApproval":{"confirmFirst":5}`，具体计数、卡片与延期语义见[发布护栏](company.md#发布护栏)。通道安装不等于授权开帖；`enabled` 保持 false，首次真实发布前由负责人确认稿件、核实登录及绑定账号后再开启。

上线必须用员工实际 Codex 身份、工作目录和沙箱模式执行只读探测：sudo 不可提权、旧机网络不可达、发布私钥不可读；任一绕过即停止启用。另在固定程序所在宿主环境仅发送 `lookup` 验证链路。模型沙箱与系统账号是边界，岗位提示词不是权限控制。


## 效果只读窄通道

第3批另设 `company-reader` 系统账号、独立SSH密钥、known_hosts和root拥有的 `/usr/local/libexec/company-xhs-read`；不复用发布账号或发布sudo权限。sudoers只允许无参数的该命令，SSH固定主机、密钥、空环境、禁转发并校验主机公钥。旧机授权行使用来源IP限制和 `restrict,command="/absolute/node /absolute/app/plugins/xiaohongshu/read-run.ts /private/connector.json"`，固定入口忽略请求的远程命令，只解析最多10KB JSON。

输入只能是 `{"action":"read","notes":["24位笔记id"]}`，禁止额外字段或publish。服务只调用只读登录状态（用于缺少账号id的旧版profile）、`/api/v1/user/me` 和 `/api/v1/feeds/detail`；详情固定 `load_all_comments:false`，不翻评论、不搜索。账号必须匹配绑定id，笔记必须属于本人；列表token私有缓存用于读取旧笔记，不向模型暴露。与原发布程序共用同账号锁，防止浏览器并发。响应仅含核验文字、图片数、时间和互动指标，没有cookies、token或任意文件读取。

先以宿主身份实读首篇和本人资料，再开启 `publishVerification:"program"` 与 `feedback.json.enabled:true`；员工模型沙箱须不能提权执行通道、读取私钥或直连旧机。成功响应可新增 `others:[{id,title,likes}]`，包含本人列表中不在本次 `notes` 请求里的卡片；标题取 `noteCard.displayTitle`，点赞取 `noteCard.interactInfo.likedCount`，按既有精确计数规则解析，缺失或缩写记 `null`。这些条目不调用详情、不额外翻页，是否系统发布由公司插件对照所有发布回执判定；旧响应缺少 `others` 仍兼容。每天09:35一次采集，阻塞暂停与恢复规则见[效果数据回流](company.md#效果数据回流)。发布核验未知时15分钟、再1小时有限复查，不调用QA模型。部署验证只走read，不走真实publish，不发送测试飞书消息。

## 内容质量与文字配图

公司运营和 CEO 共读 `knowledge/content-guide.md`（模板见 `examples/recipes/company/`）。运营写稿、改稿前读取 feedback 的全部系统帖与 manual 手动帖、各项目 operations 资料中的 contentDrafts 和原稿；交付说明列最近10篇切入角度并解释新稿差异，不足10篇列全部。CEO 按规范第五节逐项审核，任一项失败或与其他稿件角度重复即退回。旧备稿下次审稿适用新规范，不自动修改业务记录。

`feedback.posts` 新增可选 `title`、`excerpt`（冻结正文前100字），`operations/*.json` 与 `ceo.json` 项目资料新增 `contentDrafts`，保留在制且未打包稿件的标题及缺失说明；不把原图 base64 复制进知识。手动帖仍仅有标题及采集时间，不推断发布时间；已关闭、已发布稿不计备稿。均为兼容的资料字段，内核协议不变。

```sh
node plugins/xiaohongshu/manage.ts cards spec.json outdir
```

`spec.json` 为 `{"title":"封面【高亮短语】","pages":["正文页"]}`；生成1080×1440 PNG，最多封面加8页，主题由标题稳定选择，也可指定 paper/lemon/sky/blush。内容规范推荐0–3张内页。文字转义后排版，配图禁止 imagegen 或自绘；交付保留 spec、命令及 PNG 供 CEO 核验，再以 pack 打包。

渲染器是独立系统工具 Chrome for Testing 的稳定版 linux64 chrome-headless-shell，默认位于 `/opt/agent-company/tools/chrome-headless-shell/chrome-headless-shell`（本地可用 XHS_CARDS_BROWSER 指定），安装所需系统库、fonts-noto-cjk、fonts-noto-color-emoji 后运行 fc-cache -f。员工沙箱禁止 Chromium 所需的 shutdown 和 connect 系统调用时，使用固定代渲染服务，不能放宽模型权限；上线必须以实际员工身份和 workspace-write 沙箱测试 cards，不调用模型、不发布。

固定服务模板为 `plugins/xiaohongshu/cards.service`，安装为 `agent-company-cards.service`。先建立 root:agentcompany、0770 的 `workspace/.cards-renderer`。服务以 DynamicUser、共享组 agentcompany 运行，只将该目录绑定为 `/work`，隐藏公司状态与凭据，系统目录只读，独立临时目录和网络命名空间。员工通过本地 JSON 文件请求，服务只收 title/pages/theme，拒绝 HTML、路径或命令字段；只输出图片或错误，无发布能力。目录存在时 cards 自动代渲染；每张最多60秒，命令最多等待550秒，超时报告原任务。新进程不重试业务，不触发模型轮次。测试可用 `XHS_CARDS_SPOOL` 指定临时目录。
