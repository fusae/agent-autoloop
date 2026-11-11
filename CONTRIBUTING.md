# 参与贡献

欢迎提交可复现的问题、文档修正、插件和通用能力改进，中文或英文都可以。

## 去哪里交流

- [Issues](https://github.com/KKKKhazix/agent-autoloop/issues/new/choose)：可以复现的故障和有明确场景的功能建议。
- [使用问答](https://github.com/KKKKhazix/agent-autoloop/discussions/categories/q-a)：安装、规则、Agent 和通道配置。
- [想法交流](https://github.com/KKKKhazix/agent-autoloop/discussions/categories/ideas)：讨论还没形成开发任务的想法。
- [实践分享](https://github.com/KKKKhazix/agent-autoloop/discussions/categories/show-and-tell)：分享插件、场景模板和使用经验。
- 安全问题按 [安全说明](SECURITY.md) 联系维护者，不在公开讨论中披露利用细节。

## 贡献范围

新 Agent、事件插件和通道接在插件层；完整业务流程可以做成场景模板。先看 [插件开发说明](docs/plugins.md) 和 [现有场景](README.md#拿来即用的场景模板)，避免重复实现。

内核保持零运行时依赖，不连接外部产品。总览页、工作流画布和其他界面属于独立客户端，不放进这个仓库。改协议或核心流程前，先说明具体场景和兼容影响；维护约定见 [AGENTS.md](AGENTS.md)，协议见 [docs/protocol.md](docs/protocol.md)。

## 提交改动

1. 从最新的 `main` 创建分支；外部贡献者使用 Fork。Agent 在独立工作树里开发，主目录保留在 `main`。
2. 使用 Node.js 24 或更新版本，运行 `npm ci`。一次 PR 解决一个问题，只更新实际受影响的说明、示例和配置，不机械同步所有文档。
3. 修 bug 先写能复现它的失败测试，测试文件开头说明防止什么失败。纯文档、模板或小范围可逆改动，不补照着实现抄的测试。
4. 日常修复先跑相关测试文件，再跑 `npm run test:fast`（目标60秒内）、`npm run typecheck`；格式检查只需覆盖改动文件。`npm run test:slow` 包含模拟、穷举、端到端、性能和耗时进程集成测试。`npm test` 保持全量，仅在合并前或夜间运行；偶发失败只重跑那个文件，不反复跑全量。扩展强杀和夜间验证继续用 `test:nightly`。
5. 向 `main` 提交 PR，说明问题、改后的行为、验证结果和兼容影响。未完成的工作使用草稿；合并前确认当前提交的两项系统检查通过。

测试使用临时 `AGENT_AUTOLOOP_HOME`、随机端口、本地假 HTTP 和假通知命令。不要连接真实业务数据库、发送消息，或给已在线的飞书应用再开事件监听。真实交付脚本会创建和删除指定测试仓库，只在用户明确要求时运行。

不要提交密钥、带权限的卡片链接、完整配置、数据库、运行输出或同事资料。问题中的日志和截图也要先脱敏。代码按 [MIT 许可证](LICENSE) 提交。

仓库通过 `main` 分发，安装和更新方式见 [INSTALL.md](INSTALL.md)；目前没有独立发布包或长期支持分支。仓库设置中的自动合并保持关闭，交付插件按 [交付协议](docs/protocol.md#交付插件) 完成审查、检查和合并。
