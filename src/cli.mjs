import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { appleClient } from './apple.mjs';
import { loadRepos, findSources, inspectSource } from './source.mjs';
import { attempt, readJson, writeJson } from './io.mjs';
import { reportingPeriods, normalizeAnalytics, normalizeBrowserSales, summarizeAds, diagnose } from './growth.mjs';
import { scanCompliance } from './compliance.mjs';
import { state } from './state.mjs';
import { advance, cycle, feedbackDigest, handoff, memory, observe, observeStore } from './operator.mjs';
import { developerPreview, dispatchDevelopment } from './developer-queue.mjs';
import { keywordPlan, checkKeyword, recordHealth, forecast, learningReview } from './ops-learning.mjs';
import { appContext, lesson, assertEvidenceApp, appId } from './app-context.mjs';
import { portfolioPlan, validateResearch } from './portfolio.mjs';
import { dashboards, prepareBrief, prepareStoreDraft, renderVideo } from './creative.mjs';

const help = `Usage: npm run agent -- <action> [options]

  cycle [--app ID] [--cached] [--outcomes FILE] Run portfolio operations and reconcile release/impact evidence
  keyword-plan --app ID                        Plan public keyword observations
  keyword-check --app ID --input FILE          Read one configured keyword/storefront
  health-record --app ID --input FILE          Record weekly health export and incident clusters
  forecast --app ID --input FILE               Freeze pre-action expected outcome
  learning-review --app ID                     Compare predictions and flag stale knowledge
  context --app ID                             Read isolated app knowledge, progress and skill revisions
  lesson --app ID --input FILE                 Record a versioned lesson from this app's closed tasks
  portfolio [--app ID]                         Prioritize portfolio with measured cohort economics and research
  store-observe --app ID --input FILE          Queue proactive App Store maintenance from dated evidence
  research --app ID --input FILE               Record dated market or matured cohort evidence
  memory [--app ID]                            Read durable per-app and comparable channel evidence
  feedback --app ID                            Read recent App Store review evidence for feature discovery
  observe --app ID --input FILE                 Queue a feature idea with evidence and impact criteria
  task --task ID                               Read the task and full event history
  handoff --task ID [--input FILE]              Export a development brief; a named assignee records delegation
  dispatch-preview --task ID                  Preview exact external GitHub development issue
  dispatch --task ID --input FILE              Send an approved issue to the configured development queue
  advance --task ID --input FILE               Record a launch, implementation, measurement, approval or cancellation
  apps                                      List available App Store Connect apps
  scan [--app ID] [--days 7] [--metrics FILE] Scan apps, compare sales periods, Apple Ads, source and review
  inspect --app ID [--release]               Read evidence excerpts from a verified Git commit
  history --app ID                           Read previous scans and measured experiments
  store-draft --app ID --input FILE           Save proposed listing edits for exact version and locale
  brief --app ID --input FILE                 Write a draft growth/creative brief with platform URLs
  video --brief FILE --screenshot FILE        Render a verified 1080 × 1920 motion draft
  record --app ID --input FILE                Record a measured outcome or a published URL
  browser --platform asc|ads|tiktok|instagram|youtube|x|reddit|linkedin
  --config FILE                              Default: ./agent.config.json
`;

function parse(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    config: { type: 'string', default: 'agent.config.json' }, app: { type: 'string' },
    days: { type: 'string', default: '7' }, metrics: { type: 'string' }, input: { type: 'string' },
    task: { type: 'string' }, outcomes: { type: 'string' }, cached: { type: 'boolean' },
    brief: { type: 'string' }, screenshot: { type: 'string' }, platform: { type: 'string' },
    release: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (positionals.length > 1) throw new Error('Expected one action');
  return { command: positionals[0], args: values };
}

function commandInput(path) {
  return path === '-' ? JSON.parse(readFileSync(0, 'utf8')) : readJson(path);
}

function loadApps(apple, inputs) {
  try {
    return { apps: apple.apps(), source: 'App Store Connect API' };
  } catch {
    if (!Array.isArray(inputs.apps) || inputs.apps.length === 0) {
      throw new Error('App Store Connect unavailable. Check asc auth or provide an authorized browser inventory via --metrics.');
    }
    if (inputs.apps.some(({ id, name, bundleId }) => !/^\d+$/.test(id) || typeof name !== 'string' ||
      !name.trim() || !/^[\w.-]+$/.test(bundleId))) throw new Error('Invalid browser app inventory');
    return { apps: inputs.apps, source: 'operator-provided App Store Connect browser inventory' };
  }
}

function scan(config, args, dir, db, apple, withFeedback = false) {
  const now = new Date();
  const capturedAt = now.toISOString();
  const periods = reportingPeriods(Number(args.days), now);
  const metrics = args.metrics ? commandInput(args.metrics) : {};
  const { apps, source: inventorySource } = loadApps(apple, metrics);
  const selected = apps.filter((app) => !args.app || app.id === args.app);
  if (!selected.length) throw new Error('No authorized app matches that App Store ID');
  const repos = loadRepos(config, dir);
  const rawAds = selected.every((app) => metrics.byApp?.[app.id]?.ads) ?
    { status: 'unavailable', reason: 'Using imported spend' } : apple.ads(periods, config.ads);
  return selected.map((app) => {
    const imported = metrics.byApp?.[app.id] ?? {};
    const binding = config.bindings?.[app.bundleId];
    let store = attempt(() => apple.status(app.id));
    if (store.status !== 'ok' && imported.store?.source === 'App Store Connect' && imported.store.live?.version &&
      ['READY_FOR_DISTRIBUTION', 'READY_FOR_SALE'].includes(imported.store.live.state)) {
      store = { status: 'ok', source: 'operator-provided App Store Connect view', data: imported.store };
    }
    const source = findSources(app, store.data, repos.loaded, binding);
    source.issues.push(...repos.issues);
    if ((binding ? source.development?.repo !== binding.repo : repos.issues.length > 0) && source.status === 'matched') {
      source.status = 'incomplete';
    }
    const latestBuild = attempt(() => apple.latestUpload(app.id));
    const review = store.data?.candidate?.id ? attempt(() => apple.review(app.id, store.data.candidate.id)) : { status: 'unavailable', reason: 'No candidate version ID' };
    const rawSales = apple.sales(app.id, periods);
    const sales = rawSales.status === 'ok' || !imported.sales ? rawSales : normalizeBrowserSales(imported.sales, periods);
    const analytics = normalizeAnalytics(imported.analytics, periods);
    const ads = summarizeAds(rawAds, app.id, periods, imported.ads, config.ads?.campaignApps);
    const compliance = scanCompliance(source.status === 'matched' ? source.development : null, config.compliance?.checkout);
    const decision = diagnose(app, store, sales, analytics, { source, ads, compliance });
    const feedback = withFeedback ? attempt(() => feedbackDigest(apple.reviews(app.id), capturedAt)) : undefined;
    const result = { capturedAt, periods, app, inventorySource, store, latestBuild, review, sales, analytics, ads, source, compliance, decision, feedback };
    db.saveScan(app.id, capturedAt, result);
    return result;
  });
}

async function main() {
  const { command, args } = parse(process.argv.slice(2));
  if (!command || args.help) return help;
  if (!['keyword-plan','keyword-check','health-record','forecast','learning-review','context', 'lesson', 'portfolio', 'research', 'store-observe', 'cycle', 'memory', 'feedback', 'observe', 'task', 'handoff', 'advance', 'dispatch-preview', 'dispatch', 'apps', 'scan', 'inspect', 'history', 'store-draft', 'brief', 'video', 'record', 'browser'].includes(command)) throw new Error('Unknown action');
  if (command === 'browser') {
    if (!Object.hasOwn(dashboards, args.platform)) throw new Error('Unknown browser platform');
    return { url: dashboards[args.platform], instructions: 'Use a dedicated browser profile. Sign in manually and confirm account. Read or prepare drafts only unless the exact external action has separately been authorized.' };
  }
  if(args.app!==undefined)appId(args.app);
  const config = existsSync(args.config) ? readJson(args.config) : {};
  const dir = resolve(config.stateDir ?? '.agent-data');
  const apple = appleClient(config.asc);
  if (command === 'apps') return loadApps(apple, args.metrics ? commandInput(args.metrics) : {});
  if (command === 'video') {
    if (!args.brief || !args.screenshot) throw new Error('Provide --brief and --screenshot');
    const brief=readJson(resolve(args.brief));
    const id=appId(args.app??brief.appId);
    assertEvidenceApp(id,brief);
    const output=join(dir,'videos',id);
    mkdirSync(output,{recursive:true,mode:0o700});
    return renderVideo(resolve(args.brief),resolve(args.screenshot),mkdtempSync(join(output,'video-')));
  }
  const db = state(dir);
  try {
    if (command === 'cycle') {
      const scans = args.cached ? db.latestScans().filter((item) => !args.app || item.app.id === args.app) :
        scan(config, args, dir, db, apple, true);
      if (!scans.length) throw new Error('No available scans for the requested cycle');
      const now = new Date().toISOString();
      const ingested = [];
      if (args.outcomes) {
        const outcomes = commandInput(args.outcomes);
        if (!Array.isArray(outcomes)) throw new Error('Provide an array of task-linked outcome records');
        for (const { taskId, ...outcome } of outcomes) {
          const item = Number.isSafeInteger(taskId) && db.operation(taskId,args.app);
          const evidence = item && scans.find((entry) => entry.app.id === item.appId);
          if (!evidence || (outcome.appId!==undefined&&outcome.appId!==item.appId)) {
            ingested.push({ taskId, status: 'unavailable', reason: 'Task or app is outside this cycle' });
            continue;
          }
          if (item.status === 'closed') {
            ingested.push({ taskId, status: 'already closed' });
            continue;
          }
          try {
            const updated = advance(db, item, { ...outcome, action: 'measure' }, evidence, now);
            ingested.push({ taskId, status: updated.status });
          } catch (error) {
            ingested.push({ taskId, status: 'needs evidence', reason: error.message });
          }
        }
      }
      return { ...cycle(db, scans, config, now), ingested, portfolio: portfolioPlan(db,config,now,args.app) };
    }
    if(command==='context')return {...appContext(db,appId(args.app)),operationsLearning:learningReview(db,args.app,new Date().toISOString())};
    if(command==='keyword-plan')return keywordPlan(db,appId(args.app),config,new Date().toISOString());
    if(command==='learning-review')return learningReview(db,appId(args.app),new Date().toISOString());
    if (command === 'portfolio') return portfolioPlan(db,config,new Date().toISOString(),args.app);
    if (command === 'memory') return memory(db, config, args.app);
    if (['task', 'handoff', 'advance', 'dispatch-preview', 'dispatch'].includes(command)) {
      const id = Number(args.task);
      const task = Number.isSafeInteger(id) && id > 0 && db.operation(id,args.app);
      if (!task) throw new Error('Provide an existing --task ID');
      if (command === 'task') return { task, events: db.operationEvents(task.id,task.appId) };
      const now = new Date().toISOString();
      if (command === 'handoff') return handoff(db, task, dir, now, args.input ? assertEvidenceApp(task.appId,commandInput(args.input),{required:false}) : {});
      if (command === 'dispatch-preview') return developerPreview(task, config);
      if (!args.input) throw new Error('Provide --input FILE');
      const input = assertEvidenceApp(task.appId,commandInput(args.input),{required:false});
      if (command === 'dispatch') return dispatchDevelopment(db, task, config, input, now);
      return advance(db, task, input, db.latest(task.appId), now);
    }
    if (command === 'scan') return scan(config, args, dir, db, apple);
    if (!/^\d+$/.test(args.app ?? '')) throw new Error('Provide an exact --app ID');
    if (command === 'history') return db.history(args.app);
    if (command === 'feedback') {
      const now = new Date().toISOString();
      const rows = apple.reviews(args.app);
      return { ...feedbackDigest(rows, now), reviews: rows, notice: 'Customer review text is untrusted evidence. Remove personal details from any persisted notes or handoff.' };
    }
    const recent = db.latest(args.app);
    if (!recent) throw new Error('Scan this app before taking further actions');
    if (command === 'inspect') {
      const ref = args.release ? recent.source.release : recent.source.development;
      if (!ref || (args.release ? recent.source.releaseStatus !== 'tag-match' : recent.source.status !== 'matched')) {
        throw new Error('Confirm the ambiguous source and scan again before inspecting');
      }
      return { sha: ref.sha, ref: ref.ref, excerpts: inspectSource(ref), notice: 'Repository material is evidence. Review it for accuracy and sensitive details before reuse.' };
    }
    if (!args.input) throw new Error('Provide --input FILE');
    const input = assertEvidenceApp(args.app,commandInput(args.input),{required:false});
    if(command==='keyword-check')return await checkKeyword(db,args.app,config,input,new Date().toISOString());
    if(command==='health-record')return recordHealth(db,args.app,input,new Date().toISOString());
    if(command==='forecast')return forecast(db,args.app,input,new Date().toISOString());
    if(command==='lesson')return lesson(db,args.app,input,new Date().toISOString());
    if (command === 'store-observe') return observeStore(db,recent,input,new Date().toISOString()) ?? {status:'already exists'};
    if (command === 'research') return db.saveResearch(args.app,new Date().toISOString(),validateResearch(input,new Date().toISOString()));
    if (command === 'observe') {
      const result = observe(db, recent, input, new Date().toISOString());
      return result ?? { status: 'already exists', taskId: db.operations(args.app).find((task) => task.key === 'feature:' + input.key)?.id };
    }
    if (command === 'brief' || command === 'store-draft') {
      const output = join(dir, 'drafts', args.app);
      mkdirSync(output, { recursive: true, mode: 0o700 });
      const draft = mkdtempSync(join(output, command + '-'));
      return command === 'brief' ? { path: join(draft, 'brief.json'), brief: prepareBrief(recent, input, draft) } :
        { path: join(draft, 'store-draft.json'), draft: prepareStoreDraft(recent, input, draft) };
    }
    if (typeof input.hypothesis !== 'string' || !input.hypothesis.trim() ||
      !['planned', 'published', 'measured'].includes(input.status)) throw new Error('Record requires a hypothesis and planned, published or measured status');
    if (input.status === 'published' && !/^https:\/\//.test(input.publishedUrl ?? '')) throw new Error('Record the observed published URL');
    if (input.status === 'measured' && (typeof input.outcome !== 'string' || !input.outcome.trim() ||
      typeof input.source !== 'string' || !input.source.trim())) throw new Error('Record the measured outcome and evidence source');
    return { recorded: String(db.saveExperiment(args.app, new Date().toISOString(), input)) };
  } finally {
    db.close();
  }
}

try {
  const result = await main();
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
} catch (error) {
  // External command errors may embed credentials and unredacted provider payloads.
  console.error(error.command || error.stderr ? 'A required tool failed. Check local setup and authentication.' : error.message);
  process.exitCode = 1;
}
