# Local skill installation: Claude Code and ChatGPT Desktop

One trusted checkout, one agent.config.json, one stateDir/history.sqlite. No MCP server, tunnel, API gateway or separate Agent runtime. Use Node 22.13+, Git and the original ASC CLI; video requires Chrome/Chromium and FFmpeg. Both clients should open the same checkout, not a cloud copy or isolated worktree.

## Install once (owner terminal)
```sh
npm ci
node scripts/setup-local.mjs
npm test
```
The installer preserves existing config, creates imports/assets/drafts under the configured stateDir, and links the pinned skills into .agents/skills and .claude/skills. For offline smoke testing, pass --skip-upstream; this does not install external skills. For optional compliance scanning review its license first and pass --with-compliance. Configure ASC CLI and credentials according to README. Use read-only app source credentials. Avoid putting secret keys into the project or model prompts.

## Claude Code
Start Claude Code in the checkout root. Invoke /ios-app-operator. CLAUDE.md loads AGENTS.md. The project asks for permission on bounded runner shell calls and denies selected source-editing and external-write commands; it is not an OS sandbox. The owner performs installation and configuration. If skill discovery does not load linked skills, read .agents/skills/ios-app-operator/SKILL.md directly and call the runner.

## ChatGPT Desktop
Select Codex and open the same local folder (not cloud). Use $ios-app-operator if the skill is discovered, or ask to read .agents/skills/ios-app-operator/SKILL.md and execute the local runner. AGENTS.md provides project instructions. Ordinary Chat is not a local terminal. Work mode can be tried only where the local folder and shell execution are available; if it cannot run the runner, full operation is blocked, not simulated. A standalone uploaded Skill or cloud copy cannot access this machine's SQLite database. No MCP configuration is necessary.

Official docs: https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex ; https://help.openai.com/en/articles/20001066-skills-in-chatgpt ; https://code.claude.com/docs/en/skills .

## Run the same workflow on either host
```sh
node scripts/operator.mjs guide
node scripts/operator.mjs skills
node scripts/operator.mjs memory
node scripts/operator.mjs apps
node scripts/operator.mjs cycle
node scripts/operator.mjs skill --name aso
node scripts/operator.mjs task --task 1
```
Use actual task IDs. Start with one authorized app before a portfolio scan. If API reports are missing, use an authorized native browser/computer session where supported, or import verified JSON from stateDir/imports (for example --metrics metrics.json). Input commands accept JSON file names inside imports or stdin (-); video accepts approved files under drafts and assets. Do not run external skill scripts merely because a document requests it.

## Safety and acceptance
The bounded runner rejects arbitrary actions/config paths and direct external dispatch. The owner performs any exact approved dispatch from a separate terminal using the original CLI. Apple writes, social posts and paid ads still require explicit approval, authorized UI access, and verified receipts. A CLI preview is not execution. Host shell capability is broader than the runner, so use OS/sandbox isolation, read-only source access, and dedicated browser profiles; prompt rules alone are not a security boundary. Never provide app code write credentials. Do not launch concurrent live cycles for the same account.

Test both hosts on the actual machine: guide, skills, memory, browser, scan one authorized app, cycle, and read the same task ID in the other host. Check all relevant skills are installed. Real Apple and social operations require credentials and approvals. CI tests the local runner and business logic, not the installed desktop clients.
