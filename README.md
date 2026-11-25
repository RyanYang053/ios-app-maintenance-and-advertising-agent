# iOS App Maintenance & Advertising Agent

一个本地运行的 iOS App 运营 Agent。它先查 App Store Connect 和 Apple Ads，再用 Bundle ID 找到 GitHub 上对应的项目，判断优先处理审核、商店页、获客还是转化。每次运营建议都附带核验数据和衡量指标。

| 工作 | 实现 |
| --- | --- |
| 查产品状态 | App Store Connect App 清单、线上版本、待审核版本、最新上传 build、候选版本验证 |
| 查经营数据 | Sales and Trends 下载单位与开发者预计收益，两段可比时间。Apple Ads Platform API 按 App、账户和币种统计广告支出 |
| 找源代码 | 可配置 GitHub 账户、限定仓库列表或本地目录。检查精确 Bundle ID，记录 Git commit，标记冲突和版本标签 |
| 查上架风险 | 独立调用 `app-store-compliance` 扫描指定 commit，可读定位、风险级别和合规截止日期。配合 ASC Skills 诊断审核和 ASO |
| 运营与推广 | 根据转化漏斗给出行动和目标指标。保存商店页变更稿、分平台推广简报、可归因链接、12 秒竖版 MP4 和实验结果 |
| 浏览器操作 | Claude Code 或 ChatGPT 可通过受权的本地浏览器工具执行同一工作流 |

## 持续运营

`cycle` 扫描当前 Apple 连接可见的 App，查看审核、广告、销售和评论信号，自动创建维护和推广任务，核对待上线版本，并标记到期的效果复查。跨对话的结果、验收和任务历史保存在本地 SQLite；`memory` 会读取实际实验数据供下一轮使用。

```bash
node scripts/operator.mjs cycle
npm run agent -- memory
npm run agent -- task --task 1
```

在 Claude Code 或 ChatGPT Desktop 本地 Codex 中打开同一目录，调用 `ios-app-operator` Skill 和本地 CLI。无需 MCP、远程服务或额外模型 API。普通 Chat 不保证具备本地脚本执行能力；Work 需核验本地执行权限。见 [双宿主安装指南](docs/hosts.md)。运营角色使用受限命令，App 源码仅作证据。外部 issue 由所有者在独立终端批准并执行，开发结果由独立人员验收。

## 开始使用

需要 Node.js 22.13+、Git。自动发现 GitHub 私有仓库需要已登录的 `gh`，远程克隆需要已有的 Git 读取权限。合规扫描需要 Bash 和上游列明的工具。视频需要 Chromium/Chrome、FFmpeg 和 FFprobe。

```bash
npm ci
node scripts/setup-local.mjs
npm test
```

1. 按 [ASC CLI 7.5.0](https://github.com/rorkai/App-Store-Connect-CLI/releases/tag/7.5.0) 的说明安装 `asc`。通过 `asc auth login` 在本地设置 App Store Connect 凭据，填入 `asc.profile` 和 `asc.vendor`。Sales and Trends 需要合适角色的团队 API 密钥。广告用独立的 `asc ads auth login`，填入 `ads.profile` 和适用的 `ads.accounts`。也可用 `ASC_VENDOR_NUMBER` 和 `ASC_ADS_AD_ACCOUNT_ID`。
2. 编辑 `github.repos`，设置远程 `repo`、本地 `path`、相对 `folder` 和可选 `ref`。也可设置 `github.owner` 和 `github.limit` 增加候选仓库。扫描发现多个来源时，在 `bindings` 下用 Bundle ID 指定 `{ "repo": "OWNER/REPO", "folder": "apps/ios", "ref": "refs/heads/main" }`，然后重扫。对于本地仓库，`repo` 使用扫描给出的仓库标签。
3. 要启用合规扫描，先查看 [上游许可证](https://openroots.org/licenses/ora/2.3)，然后运行 `node scripts/install-skills.mjs --with-compliance`，将 `compliance.checkout` 指向其独立安装目录。固定版本和第三方归属见 [upstream.json](upstream.json)。
4. 先扫一个 App，确认数据、源代码和版本匹配，再扫其他 App。

```bash
npm run agent -- apps
npm run agent -- scan --app 1234567890
npm run agent -- inspect --app 1234567890
npm run agent -- inspect --app 1234567890 --release
npm run agent -- history --app 1234567890
```

`scan` 默认比较两个连续的 7 天区间，窗口结束日留出 3 天。Sales and Trends 按 Apple 报告日期，Apple Ads API 使用广告账户时区。不同币种分别列示。Apple Ads 同时保留按币种统计的广告点击归因新下载和每次新下载成本。报告有延迟、隐私阈值、权限问题或分组不完整时，会保留缺口。Apple Ads 成本独立于商店销售和开发者预计收益。银行实收、开发者会员费和其他平台广告支出需要各自的账单或导出。

## 使用已登录的浏览器

使用客户端原生的授权电脑操作能力（如可用）和独立浏览器账号；无需配置浏览器 MCP。用户自行登录。如果客户端不能访问该浏览器，使用授权导出的报告作为输入，不虚构实时数据。

CLI 可以返回对应的官方面板入口。Agent 使用浏览器读取表格或准备平台原生草稿。为这个工作区使用专用浏览器，浏览器所用账号只保留 App Store Connect 和已批准社交平台所需权限。浏览器读到的 App、经营和花费记录可以参照 [metrics.json](examples/metrics.json) 导入。日期要与本次扫描窗口一致。实时 API 不可用时可导入 App Store Connect 确认过的版本状态。App Analytics 漏斗目前走导入流程，参照 `asc-analytics-reports` 或从浏览器取得原始数据。

```bash
npm run agent -- browser --platform asc
npm run agent -- scan --app 1234567890 --metrics verified-metrics.json
```

## 从诊断到实验

先确认当期问题，再确定一项要测的改动。曝光下滑时，先判断哪个国家或来源在降。商品页有稳定流量而下载走弱时，核对来源结构，再考虑测试首屏截图。下载稳定但付费走弱时，用同一批安装用户验证试用或付费转化，再考虑改 onboarding 或付费页。

```bash
npm run agent -- store-draft --app 1234567890 --input store-edits.json
npm run agent -- brief --app 1234567890 --input creative.json
npm run agent -- video --brief APP_ID/brief-EXAMPLE/brief.json --screenshot real-app-screen.png
npm run agent -- record --app 1234567890 --input experiment.json
```

- [store-edits.json](examples/store-edits.json) 接收当前字段和变更稿、App Store 版本 ID、语言区及试验指标。具体可编辑性由 Apple 后台状态决定。
- [creative.json](examples/creative.json) 接收已核实的线上版本、源代码 commit、受众和实际功能证明。每个平台可使用不同的 [Apple campaign link](https://developer.apple.com/help/app-store-connect-analytics/acquisition/campaign-links)。
- 视频输出是可编辑 HTML 和经过 FFprobe 验证的 1080 × 1920 MP4。截图来自操作者，草稿可用 OpenDesign 细化分镜。
- `record` 接收 `hypothesis` 和 `status`，发布时加 `publishedUrl`，测量时加 `outcome` 和 `source`。扫描和实验记录存于本机 SQLite。
- 商店写入、审核提交、社媒发布和付费投放由操作流程逐项确认。公开发布后要核对链接和内容，才算实验开始。

架构选择、开源项目链接与验证边界见 [docs/upstream-research.md](docs/upstream-research.md)。

上述输入 JSON 文件放入配置的 stateDir/imports；视频 brief 相对于 stateDir/drafts，截图相对于 stateDir/assets。示例路径需替换为实际生成文件。所有者专用 CLI 仍为 npm run agent -- dispatch，禁止运营 Agent 直接调用。

## 跨 App 经营决策

`node scripts/operator.mjs portfolio` 汇总各 App 优先级、待处理审核、到期测量、渠道成本和真实成熟安装 cohort 的单位贡献。通过 `research --app ID --input research.json` 持久化竞品、客户、渠道或 cohort 证据。配置组合工时与维护预留，优先使用已有实测成本的有利自然流量任务；缺少证据时保留探索，不自动付费。归因数据不代表因果增量利润。见 [持续运营手册](docs/operating-loop.md)。

### 首次运行自检

`node scripts/operator.mjs doctor` 检查本地配置、Skills、SQLite 与工具；`node scripts/operator.mjs doctor --live` 额外读取 Apple App 清单（只读），列出仍缺少市场或渠道配置的 App ID。安装默认使用空白生产模板，示例不再自动成为运营配置。真实账户、视频渲染、两个客户端及外部开发闭环须分别验收。

### Upstream-derived operations
See [upstream integration](docs/upstream-integration.md) for pinned MIT ports, per-app keyword monitoring, weekly health evidence, forecast review and memory curation. No MCP or new server required. Public iTunes search ordering is not native App Store rank.
