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

用户用目标小红书账号扫码后，`bind` 固定平台返回的账号编号；不凭昵称猜账号。绑定仍保持 `enabled:false`，由操作者完成账号范围和真实发布验证后再设置为 `true`。不用提供密码。二维码和 cookies 不进入员工资料。

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

上游返回“发布完成”没有笔记编号，不能当作成功。本适配器再查本人笔记和详情，核对账号、唯一标题、正文、图片数量、笔记编号和平台时间，才返回真实 HTTPS 链接交给 QA。图片数量核验不等于图片像素一致性或业务效果验收；QA 还需查看实际帖子。列表未展示、同名歧义或正文经平台改写时保留待核验，不能编造链接或再次提交。

账号未绑定、图文未交付和登录过期给 CEO 返回具体原因。外部发布只有在平台可读回后才记完成；模拟测试不代表生产发布验证完成。
