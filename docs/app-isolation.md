# App isolation and learning

One local SQLite database, logically partitioned by exact App Store ID. All scans, experiments, research, tasks and lesson revisions have an app_id; existing history is preserved. Task events belong to a task whose app is checked. The normal bounded runner requires app ID for task reads and writes. This is application-level isolation, not a separate OS security boundary. The trusted owner CLI retains maintenance access to the ledger. For hostile tenants use separate OS users, checkouts, credentials and databases.

Portfolio summaries are for scheduling. Start a new app-specific conversation in either host and run:
```sh
node scripts/operator.mjs context --app 1234567890
node scripts/operator.mjs task --app 1234567890 --task 1
node scripts/operator.mjs lesson --app 1234567890 --input lesson.json
```
Use actual IDs. The context returns only that app's latest scan, research, history, tasks, progress counts and skill learning evidence. In a portfolio scan or cycle the bounded runner omits raw source and review details. Both hosts share the same app-scoped ledger. Do not use a multi-app conversation to generate app-specific creative or development briefs.

App-scoped files are under stateDir/imports/ID, assets/ID, drafts/ID, handoffs/ID and videos/ID. Rerun setup after configuring new apps. Existing shared imports/assets are left intact; manually copy only verified files to the correct app. Mutation JSON must contain matching appId; outcome batches are imported one app at a time. Existing draft paths already use app IDs. Video output and new handoffs are now app scoped. Symlink aliasing and traversal are rejected by the bounded file reader.

The 25 base skills are read-only references. Each app independently accumulates closed-task evidence in nine skill domains. A lesson is a versioned, evidence-backed hypothesis, not a script or prompt instruction. Required: appId, domain, key, rule, limitations, taskIds (closed outcomes of the same app with a compatible task kind), expectedRevision (0 for new key, current revision for an update). A single outcome is a hypothesis, repeated observations are not causal proof. Append corrections as a new revision; prior versions remain available. After each closed task, the agent should compare actual result against target and record a lesson where justified. No self-modification of base skills, and no automatic claim that the model became more capable.

Cross-app transfer defaults OFF. Set shareAggregateLearning:true on each source and receiveAggregateLearning:true on the recipient only if appropriate. Only organic aggregate estimates with compatible markets, currency, labor, audience, sample size and observation windows can transfer; revoking sharing prevents future transfers (previously queued task bases remain historical evidence). Raw user reviews, private research, product facts, source, task data, assets, and lesson text never transfer via this mechanism. Portfolio owners can see aggregated metrics across apps, but do not use these as product facts.
