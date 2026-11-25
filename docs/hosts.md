# Supported hosts: Claude Code and ChatGPT

One trusted local checkout, one agent.config.json, and one .agent-data/history.sqlite. Both clients must connect to this same checkout (not separate plugin copies). Do not expose the state directory or credentials publicly. Do not launch competing live cycles for the same account.

## Setup (owner, local terminal)

```sh
npm ci
npm install --prefix adapters/mcp --ignore-scripts
node scripts/install-skills.mjs
npm test
npm test --prefix adapters/mcp
```

Copy examples/agent.config.json only if no configuration exists. Authenticate ASC and GitHub manually as described in the main README. The adapter pins its direct dependencies; commit a generated adapter lockfile after installation and review. Use Node 22.13+.

## Claude Code

Open the checkout with Claude Code, approve the project MCP configuration, check /mcp and call memory. The project .mcp.json uses CLAUDE_PROJECT_DIR. CLAUDE.md imports AGENTS.md. The installer also exposes the pinned skills under .claude/skills. Project restrictions deny direct shell/editor/subagent use for this operator; perform installation yourself before starting it. Browser automation is optional; separately approve only the dedicated Chrome profile and official Chrome DevTools MCP server. Never give an operator a code-write credential.

## ChatGPT desktop

For a trusted local Codex project open this exact checkout, approve the project MCP configuration, and call memory. If the host does not honor the project-relative executable, register the absolute path to adapters/mcp/server.mjs with the node command in local MCP settings. Verify tools and AGENTS.md load before use. For ordinary ChatGPT conversations, a custom MCP connection requires an eligible account/workspace: use the official Secure MCP Tunnel to this same local stdio command, then Plugins > Add custom MCP server > Tunnel. See https://developers.openai.com/api/docs/guides/secure-mcp-tunnels and https://developers.openai.com/plugins/deploy/connect-chatgpt. No public listener is provided. The owner must configure the tunnel and permissions; a local Codex config does not install a ChatGPT plugin. Use the host's supported browser/computer interface only if it actually sees the authorized session; otherwise import verified metrics.

## Safety and parity

Both hosts expose the same 17 operations plus operator_guide, skill_catalog and read_skill. Start each session with operator_guide; use skill_catalog and read_skill to load relevant pinned skills even if the ChatGPT host has no local skill loader. The external GitHub issue write is intentionally NOT exposed as MCP: show dispatch-preview, then the owner approves and runs the exact dispatch command from a separate trusted terminal with issue-only credentials. External Apple edits, public social posts and paid ads also need exact approval and receipts; draft tools do not execute them. Project prompt instructions are not a substitute for OS-level access isolation. Use read-only source credentials, separate profiles, and never bypass the host sandbox. The operator must not write app code.

Smoke test each host: list tools; memory; cached cycle (or explicit no-data error); scan one approved app; task; dispatch_preview; verify the same task ID in the other host. Test invalid app IDs and reject arbitrary paths. Test actual Apple and social operations only in authorized accounts. MCP Inspector can exercise the stdio protocol with the absolute node path to this adapter. These checks are required before calling a host production-ready.
