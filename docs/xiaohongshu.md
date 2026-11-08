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
node plugins/xiaohongshu/manage.ts bind /private/connector.json
```

用户用目标小红书账号扫码后，`bind` 固定平台返回的账号编号；不凭昵称猜账号。绑定仍保持 `enabled:false`，由操作者核实账号范围、登录状态及负责人的发布授权后再设置为 `true`。不用提供密码。二维码和 cookies 不进入员工资料。

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

先以宿主身份实读首篇和本人资料，再开启 `publishVerification:"program"` 与 `feedback.json.enabled:true`；员工模型沙箱须不能提权执行通道、读取私钥或直连旧机。每天09:35一次采集，阻塞暂停与恢复规则见[效果数据回流](company.md#效果数据回流)。发布核验未知时15分钟、再1小时有限复查，不调用QA模型。部署验证只走read，不走真实publish，不发送测试飞书消息。
