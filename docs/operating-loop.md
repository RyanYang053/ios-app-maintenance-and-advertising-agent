# 持续运营手册

每次运行使用两类资料。App Store Connect 和 GitHub 给出当前事实，SQLite 保存以前做过什么、实际成本、结果、批准记录和任务事件。继续复用同一 `stateDir` 就能跨重启和对话使用记忆。保留该目录的备份。现有 `scan`、`history`、`record` 数据仍可读取。旧版自由文本实验不会参与成本比较，结构化结果通过新流程记录。

## 每轮怎么跑

| 阶段 | Agent 执行的工作 |
| --- | --- |
| 观察 | `cycle` 查全部当前团队授权的 App。用线上版本、审核阻塞、GitHub 来源、销售和广告数据决定优先级。抓取最近 60 条、90 天内的 App Store 评论，汇总至少两条不同反馈重复出现的主题。 |
| 选动作 | 优先处理审核或合规阻塞。商店资料缺陷由运营处理，不明确的拒审先核对 Apple 原文，确认是代码问题才交给开发。结合原始评论、应用实际行为和用户授权的支持或数据证据，提出下一项值得做的功能。有稳定上线版本的 App 可进入推广轮。 |
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

Claude Code 和 ChatGPT Desktop 本地 Codex 使用同一受限本地 runner：node scripts/operator.mjs。runner 不提供任意命令或直接派发 issue；owner 在独立终端执行已批准的 dispatch。参见 [双宿主指南](hosts.md)。该工具使用启动目录的受信 `agent.config.json`。视频的截图来自 `stateDir/assets`，简报来自 `stateDir/drafts`。跨宿主运行相同 CLI 时，运行账号也应仅有 App 仓库读取权限，开发 Agent 使用独立工作区和凭据。无人值守的 CLI 轮次自动观测、选动作、排队并核对证据。模型推导具体功能方案需要运行 Agent 宿主。账号确认、发帖、App Store 写操作和广告购买沿用项目审批规则。

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

## App Store Connect 维护如何验收

| 队列 | 归属与关闭条件 |
| --- | --- |
| `store-maintenance` | 运营负责商店文案、截图、年龄评级、可用性、订阅价格或审核资料中的已确认操作项。核对团队、App ID、版本 ID、语言区和字段，保存旧值与拟改值，获批并写入后重新读取 Apple。带自动检查 ID 的任务需要同版本的最新校验结果证明原检查已消失。 |
| `review-triage` | 运营查看 Resolution Center 中的具体说明。用 `advance` 的 `route-review` 记录 `versionId`、`problem`、`evidence` 和 `destination`。确定是代码问题时，还要提供 `proposedChange`、`userFlow` 和至少两个验收项。 |
| `maintenance` / `feature` | 外部开发流程负责实际代码。运营负责复现证据、精确目标、入队、跟进验收和核对上线。旧版尚未分派的泛化维护任务先重新分类。 |

商店任务完成后，用 `advance` 的 `store-resolved` 记录 `versionId`、`field`、`before`、`after`、`observedAt`、`approvalReference` 和 `evidence`。审核演示账号、密码和密钥只在 Apple 后台设置，工单中仅记已添加或已验证的状态。准备回复时保留对应评论 ID、版本和可以核验的事实。评论回复、审核提交、发布和商店改动使用对应账户授权。

## 把问题送到外部开发 Agent

本地 `handoff` 可导出完整交接包。对接 GitHub 时，在 App 的 `developmentQueue` 配置同一已核实 GitHub 仓库和实际接单的账号。开发 Agent 需要在自己的环境订阅该队列或收到该工单。配置 GitHub CLI，使其有权在指定仓库创建 Issue。账户只需要队列写入权限和仓库读取权限。

```bash
npm run agent -- dispatch-preview --task 2
npm run agent -- dispatch --task 2 --input /path/to/approved-issue.json
```

批准 JSON 包含从预览得到的 `fingerprint` 和 `approvalReference`。先确认外部可见性、收件账号，以及标题、正文或证据引用里是否含内部信息。创建成功会保存 Issue URL 和分派事件。如果结果不明确，检查仓库后用 `recoverIssue` 填写找到的原 Issue URL，系统会核对标识与接单人。外部 Agent 回传实际代码 commit 和验收结果，运营继续跟进 App Store 状态。
