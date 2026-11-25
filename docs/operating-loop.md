# 持续运营手册

每次运行使用两类资料。App Store Connect 和 GitHub 给出当前事实，SQLite 保存以前做过什么、实际成本、结果、批准记录和任务事件。继续复用同一 `stateDir` 就能跨重启和对话使用记忆。保留该目录的备份。现有 `scan`、`history`、`record` 数据仍可读取。旧版自由文本实验不会参与成本比较，结构化结果通过新流程记录。

## 每轮怎么跑

| 阶段 | Agent 执行的工作 |
| --- | --- |
| 观察 | `cycle` 查全部当前团队授权的 App。用线上版本、审核阻塞、GitHub 来源、销售和广告数据决定优先级。抓取最近 60 条、90 天内的 App Store 评论，汇总至少两条不同反馈重复出现的主题。 |
| 选动作 | 优先处理审核或合规阻塞。结合原始评论、应用实际行为和用户授权的支持或数据证据，提出下一项值得做的功能。有稳定上线版本的 App 可进入推广轮。 |
| 执行 | 推广优先用自然流量，记录投放前预算、素材形式、角度、链接。开发任务生成具体 Repo、文件夹、基准 SHA、用户流程、需求和验收标准交给开发 Agent。 |
| 核验 | 开发任务由另一名审查者核对所有验收项。随后循环检查 App Store 上线版本、build 和 Git 发布标签是否包含该 commit。 |
| 学习 | 对功能使用预先规定的同口径指标、基线和样本量。推广记录 Apple 归因的新下载、现金、人工和完整观察窗口。好坏结果都持久化。 |

```bash
npm run agent -- cycle
npm run agent -- feedback --app 1234567890
npm run agent -- memory --app 1234567890
npm run agent -- task --task 1
```

`cycle` 可由本地定时器定期运行。按 App 扫描可加 `--app`。有已授权的数据但 API 无法访问时，沿用 `--metrics` 输入。测试和排查可用 `--cached`，超过 72 小时的快照会要求重新采集。每个配置指定一个 Apple API 授权范围。不同开发者团队可以单独配置 ASC profile 和数据库目录。

`ios-business-operator` 是 OpenCode 入口。Agent 可以在每轮查看原始评论、拟定变更、保存任务并通过自己的项目工具完成授权交接。背后也能由 Codex 或 Claude Code 执行相同 CLI。无人值守的 CLI 轮次自动观测、选动作、排队并核对证据。模型推导具体功能方案需要运行 Agent 宿主。账号确认、发帖、App Store 写操作和广告购买沿用项目审批规则。

## 学什么

推广配置见 [agent.config.json](../examples/agent.config.json) 的 `loop.apps`。每个 App 可以选渠道、市场、受众分组、币种、人工小时成本、最低下载数和每次安装成本目标。现金上限默认为 0。上限大于 0 时，每个付费任务仍要单独记录具体授权。

渠道成本使用 `(现金 + 工时 × 小时成本) ÷ Apple 归因的首次下载`。工时有消耗但未配置人工价格时会保留工时和现金，完整成本留空。结果保留市场、币种和观察窗口。当前轮优先使用同一 App 的自然流量证据。跨 App 模式至少要有三个实验、两个其他 App，且受众、市场、币种、人工费率和测量窗口相同。渠道排名至少累计 20 次可归因下载。不足时做小规模复测，避免频繁换价、换素材或多次重复相同试验。付费实验保留独立记录。结果是归因观察，判断增量还需对照实验或其他因果证据。

### 推广闭环

`cycle` 产生任务后，在用户授权的浏览器里准备、预览，并在授权后记录实际上线地址。每个实验使用新的 Apple Campaign Link。下面字段在 [推广记录样例](../examples/loop-publication.json) 里：

```bash
npm run agent -- advance --task 1 --input examples/loop-publication.json
npm run agent -- cycle --outcomes /path/to/verified-outcomes.json
npm run agent -- memory --app 1234567890
```

`--outcomes` 为 JSON 数组，每项带 `taskId`。可参考 [归因记录样例](../examples/loop-outcomes.json)。窗口从发布次日起开始，取事先配置的完整天数。若报表延迟或压制，先保留开放状态，等对应窗口完整。费用包含这次实验的素材、工具或分发支出。付费授权记录动作是 `authorize-cost`，字段为 `amount`、`currency`、`approvalReference`。CLI 只记录批准额度和结果，直接在浏览器花钱需要另外完成实际授权步骤。

### 功能与维护闭环

核对评论是否指同一个真实问题，再用最小可行改动和验收标准提交。样例输入见 [功能建议](../examples/loop-feature.json)。

```bash
npm run agent -- observe --app 1234567890 --input examples/loop-feature.json
npm run agent -- handoff --task 2 --input /path/to/assignment.json
npm run agent -- advance --task 2 --input /path/to/reviewed-delivery.json
npm run agent -- cycle
npm run agent -- cycle --outcomes /path/to/feature-outcomes.json
```

交接时可用 `{"assignee":"ios-feature-builder"}` 记录分工。交付 JSON 使用 `action: "implemented"`，包括变更 `commit`、预定上架的 `version` 和 `build`、独立 `verifier`、`evidence`、可选 `pullRequest`，以及每个验收 ID 的 `status: "PASS" | "FAIL" | "BLOCKED"` 和证据。由真实审查者或独立 Agent 提供记录。仍有失败会保留任务待修复。全部通过后，等下轮实际查到 Apple 版本和 build，并确认同版本的 Git 标签包含已验收 commit。Git 标签检查证明代码从属关系，精确确认编译产物来源仍依赖 CI 的构建证明。维护任务核验上线后结束，功能任务上线后进入约定的指标观察窗口。

任务状态和事件账本保留到下一轮。取消只关闭该任务，理由也会保留。无真实评论和指标支撑的想法可以讨论，取得证据后再进入开发队列。
