# 小红书图文

运营负责完整图文，CEO 审稿，固定程序发布；累计前 5 篇成功发布须董事长逐篇确认，共用账号每天合计 1 篇。模型不能自行发布、登录或改发布配置；审核通过不等于发布成功。

写稿和改稿前先读 `knowledge/content-guide.md`、`knowledge/feedback.json`、`knowledge/feedback.md`（包括 `manual` 手动帖），以及全部 `knowledge/operations/*.json` 的 `contentDrafts` 和备稿原文。已发标题与正文前 100 字在 `feedback.posts`；手动帖只有标题，不编造正文或发布时间。手动帖不计员工指标，但必须查重。最近 10 篇切入角度与新稿差异写进 handoff/facts，不足 10 篇列全部；查重覆盖全部已发和其他备稿。

配图只用固定文字工具，禁止 imagegen、自绘或其他图片生成模型：

```sh
node /opt/agent-company/app/plugins/xiaohongshu/manage.ts cards 配图.json 输出目录
node /opt/agent-company/app/plugins/xiaohongshu/manage.ts pack 正文.json tasks/原任务/xiaohongshu.json 输出目录/card-1.png 输出目录/card-2.png
```

配图 JSON：`{"title":"封面只突出【一个短语】","pages":["每页一个意思"]}`。保存 JSON、命令与 PNG 路径；打开全部图片检查文字。帖子标题不超过 20 字；封面可不同；最终 `xiaohongshu.json` 不超过 1MB。交付登记该文件、PNG 和 handoff/facts。

CEO 按 `content-guide.md` 第五节逐条审核，任一项不合格就 `deliveries.verdict=revise`，写清哪条、改哪里；角度重复必须退回。旧备稿在下次审核时同样执行，不能证明图片来自新工具就退回，不直接改稿或改库。
