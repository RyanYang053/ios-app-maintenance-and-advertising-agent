# 上游选型

| 上游 | 在项目中的用途 | 边界 |
| --- | --- | --- |
| [ASC CLI](https://github.com/rorkai/App-Store-Connect-CLI) 和 [ASC Skills](https://github.com/rudrankriyam/asc-skills) | 读取 App、版本、build、Sales and Trends 和广告报告。安装 submission health、ASO audit、Analytics 三个 Skills | App Store Connect 团队密钥和 Apple Ads 凭据是两套权限。App Analytics 漏斗可以通过可追溯导入补充 |
| [App Store Compliance](https://github.com/mjmirza/app-store-compliance) | 在临时 Git 快照调用 standalone guard，并记录扫描版本、范围、风险及输出 | 当前版本采用 [ORA 2.3](https://openroots.org/licenses/ora/2.3)。作为可选外部依赖。规则命中需要核实，平台后台、设备行为及最终审核仍需验证 |
| [OpenDesign](https://github.com/nexu-io/open-design) | 固定 `design-brief`、`motion-design`、`video-hyperframes`，覆盖受众、节奏、分镜和视觉方向 | OpenDesign 的分镜模板是创意输入。可直接渲染的轨道由本仓模板生成 |
| [HyperFrames](https://github.com/heygen-com/hyperframes) | 默认代码视频引擎。固定 CLI 版本运行 HTML → MP4，视频时间轴使用 GSAP | CLI 渲染时关闭遥测。GSAP 包遵循上游许可。真实截图由用户提供 |
| [Remotion Skills](https://github.com/remotion-dev/skills) | React 视频和更复杂动效的备选，可在已有 Remotion 项目下使用 | 独立于本仓默认渲染器，适用 [Remotion 许可证](https://www.remotion.dev/docs/license) |
| [Marketing Skills](https://github.com/coreyhaines31/marketingskills) | 安装 social、launch、analytics、aso、attribution、customer-research、competitor-profiling、marketing-loops、pricing，供 Agent 规划内容、发布和指标 | App 功能来自当前线上版本的证据。目标平台、账号、文案和发布日期由操作者确认 |
| [Postiz](https://github.com/gitroomhq/postiz-app) | 未来的自托管社媒平台适配候选 | 当前使用平台原生编辑器，还未接 Postiz 调度 |

Apple 已把旧版 [Campaign Management API](https://developer.apple.com/documentation/apple_ads/calling-the-apple-search-ads-api) 标为弃用，并公布 2027 年 1 月 26 日停用。当前接入新版 [Apple Ads Platform API campaigns report](https://developer.apple.com/documentation/apple-ads-platform-api/get-app-campaign-reports)，按 `promotedObjectId` 连接 ASC ID，使用 `localSpend` 保留账户币种和范围。

`npm test` 覆盖 GitHub 来源歧义、线上与开发版本、金额与币种、多窗口可比性和 CLI 工作流。测试用数据模拟账号授权和报告响应。真实 Apple、GitHub 私有项目及社交帐号需要在操作者授权环境单独验收。

不额外部署 Mem0、Graphiti、LangGraph 或多 Agent 框架：现有 SQLite 和状态机是低成本权威账本。Postiz 与备用视频引擎保留为可选参考，不声称已部署。双宿主使用同一 checkout 与 stateDir。

宿主适配采用 Agent Skills 文件与受限 Node CLI，无 MCP 或常驻服务。浏览器操作只使用客户端原生能力或授权报告导入。
