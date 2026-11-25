import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { attempt, run, writeJson } from './io.mjs';
import { reviewRoutes, storeProof } from './release-routing.mjs';

const DAY = 86_400_000;
const SHA = /^[a-f0-9]{40}$/i;
const CHANNELS = ['tiktok', 'instagram', 'youtube', 'x', 'reddit', 'linkedin'];
const FORMATS = ['demo', 'tutorial', 'announcement', 'comparison', 'community-post'];
const NONNEGATIVE = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const date = (value) => new Date(value).toISOString().slice(0, 10);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const dayStamp = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && date(value) === value;
const https = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch { return null; }
};

const selection = (scan) => {
  const { repo, folder, sha, ref } = scan.source.development;
  return { repo, folder, sha, ref };
};

function profile(config, appId) {
  const row = config.loop?.apps?.[appId] ?? {};
  const result = {
    channels: [...new Set(row.channels ?? [])],
    audienceGroup: row.audienceGroup ?? null, market: row.market ?? null,
    currency: row.currency ?? config.loop?.currency ?? 'CAD',
    hourlyRate: row.hourlyRate ?? config.loop?.hourlyRate ?? null,
    cashCap: row.cashCap ?? 0, maxCpa: row.maxCpa ?? null,
    minimumDownloads: row.minimumDownloads ?? 10, measurementDays: row.measurementDays ?? 7,
  };
  if (result.channels.some((channel) => !CHANNELS.includes(channel)) || !/^[A-Z]{3}$/.test(result.currency) ||
    !NONNEGATIVE(result.cashCap) || [result.hourlyRate, result.maxCpa].some((n) => n !== null && !NONNEGATIVE(n)) ||
    !count(result.minimumDownloads) || result.minimumDownloads < 1 ||
    !count(result.measurementDays) || result.measurementDays < 3 || result.measurementDays > 30 ||
    [result.audienceGroup, result.market].some((part) => part !== null && !text(part))) {
    throw new Error('Invalid loop configuration for App Store ID ' + appId);
  }
  return result;
}

function promotionLearning(appId, policy, items) {
  // Include weak and unsuccessful complete observations in the cost denominator.
  const observations = items.filter((item) => item.kind === 'promotion' && item.status === 'closed' &&
    item.outcome?.learningEligible && item.publication?.mode === 'organic' && item.policy.currency === policy.currency &&
    item.policy.hourlyRate === policy.hourlyRate && item.policy.measurementDays === policy.measurementDays &&
    item.policy.market === policy.market);
  const estimates = [];
  for (const channel of policy.channels) {
    const own = observations.filter((item) => item.appId === appId && item.channel === channel);
    const peers = policy.audienceGroup && policy.market ? observations.filter((item) =>
      item.appId !== appId && item.channel === channel && item.policy.audienceGroup === policy.audienceGroup) : [];
    for (const [scope, pool] of [['same-app', own], ['matched-apps', peers]]) {
      const eligible = pool.filter((item) => item.outcome.totalCost !== null);
      const minimum = scope === 'same-app' ? 2 : 3;
      const downloads = eligible.reduce((sum, item) => sum + item.outcome.downloads, 0);
      if (eligible.length < minimum || downloads < 20 ||
        (scope === 'matched-apps' && new Set(eligible.map((item) => item.appId)).size < 2)) continue;
      const cost = eligible.reduce((sum, item) => sum + item.outcome.totalCost, 0);
      const formats = FORMATS.flatMap((format) => {
        const trials = eligible.filter((item) => item.publication.format === format);
        const firstDownloads = trials.reduce((sum, item) => sum + item.outcome.downloads, 0);
        if (trials.length < 2 || firstDownloads < 20 || (scope === 'matched-apps' &&
          new Set(trials.map((item) => item.appId)).size < 2)) return [];
        return [{ format, observations: trials.length, downloads: firstDownloads,
          costPerDownload: trials.reduce((sum, item) => sum + item.outcome.totalCost, 0) / firstDownloads }];
      }).sort((a, b) => a.costPerDownload - b.costPerDownload);
      estimates.push({ channel, scope, observations: eligible.length, downloads,
        costPerDownload: cost / downloads, currency: policy.currency, formats });
      break;
    }
  }
  return estimates.sort((a, b) => a.costPerDownload - b.costPerDownload);
}

function baseTask(scan, kind, key, now, fields) {
  return {
    appId: scan.app.id, appName: scan.app.name, kind, key, status: 'queued',
    createdAt: now, updatedAt: now, basedOnScan: scan.capturedAt, ...fields,
  };
}

function buildAcceptance(evidence) {
  return [
    ...evidence.acceptance.map((criterion, index) => ({ id: 'REQ-' + (index + 1), criterion })),
    { id: 'REGRESSION', criterion: 'Run the app’s relevant existing tests and report the exact commands and results.' },
    { id: 'DEVICE', criterion: 'Verify the specified iOS user path on a device or simulator and provide traceable evidence.' },
  ];
}

function stableLive(scan) {
  if (scan.store?.status !== 'ok' || !scan.store.data?.live || scan.source?.status !== 'matched') return false;
  if (scan.compliance?.status !== 'blocked') return true;
  const releaseSha = scan.source.release?.sha;
  return Boolean(releaseSha && scan.compliance.sha && releaseSha !== scan.compliance.sha);
}

function reconcileRelease(db, task, scan, now) {
  const live = scan.store?.data?.live;
  const release = scan.source?.release;
  if (scan.store?.status !== 'ok' || live?.version !== task.delivery.version ||
    String(live?.buildNumber) !== task.delivery.build || scan.source.releaseStatus !== 'tag-match' ||
    release?.repo !== task.target.repo || release.folder !== task.target.folder) return null;
  const proof = attempt(() => run('git', ['-C', release.path, 'merge-base', '--is-ancestor', task.delivery.commit, release.sha]));
  if (proof.status !== 'ok') return null;
  const deployment = { observedAt: now, version: live.version, build: live.buildNumber, tagCommit: release.sha,
    source: scan.inventorySource, confidence: 'App Store version/build plus Git release-tag ancestry' };
  if (task.kind === 'maintenance') {
    return db.updateOperation(task, { status: 'closed', deployment,
      outcome: { verdict: 'release verified', trace: task.delivery.evidence } }, 'release-verified', now);
  }
  return db.updateOperation(task, { status: 'live', deployment, startedAt: now,
    dueAt: date(Date.parse(date(now)) + (task.impact.days + 1) * DAY) }, 'release-verified', now);
}

export function observe(db, scan, input, now) {
  const { key, problem, proposedChange, userFlow, signals, acceptance, impact } = input;
  if (!/^[a-z0-9-]{3,64}$/.test(key ?? '') || ![problem, proposedChange, userFlow].every(text) ||
    !Array.isArray(signals) || !Array.isArray(acceptance) || acceptance.length < 2 || acceptance.length > 12 ||
    !acceptance.every(text)) throw new Error('Feature intake requires a stable key, user problem, proposed change, user flow, source signals and two or more testable criteria');
  const sources = new Set(['app-review', 'support', 'app-analytics', 'device-test', 'experiment']);
  if (signals.length < 2 || !signals.every((row) => sources.has(row.kind) && text(row.ref) && text(row.observation) &&
    dayStamp(row.date) && row.date <= date(now)) || new Set(signals.map((row) => row.ref)).size !== signals.length) {
    throw new Error('Provide two distinct, dated observations with traceable source references');
  }
  if (!impact || ![impact.metric, impact.scope, impact.source].every(text) ||
    !NONNEGATIVE(impact.baseline) || !NONNEGATIVE(impact.target) ||
    !['higher', 'lower'].includes(impact.direction) ||
    (impact.direction === 'higher' ? impact.target <= impact.baseline : impact.target >= impact.baseline) ||
    !count(impact.days) || impact.days < 7 || impact.days > 90 ||
    !count(impact.minSample) || impact.minSample < 10 || !count(impact.baselineSample) || impact.baselineSample < impact.minSample ||
    !dayStamp(impact.baselineStart) || !dayStamp(impact.baselineEnd) ||
    Date.parse(impact.baselineEnd) - Date.parse(impact.baselineStart) !== (impact.days - 1) * DAY ||
    impact.baselineEnd >= date(now)) {
    throw new Error('Define a comparable dated baseline, direction, target, sample floor and 7–90 day impact window');
  }
  const age = Date.parse(now) - Date.parse(scan.capturedAt);
  if (scan.source?.status !== 'matched' || !Number.isFinite(age) || age < 0 || age > 72 * 3_600_000) {
    throw new Error('Refresh and resolve the app source before queuing a feature');
  }
  return db.enqueue(baseTask(scan, 'feature', 'feature:' + key, now, {
    priority: 3, owner: 'external-development', target: selection(scan), problem, proposedChange, userFlow, signals,
    acceptance: buildAcceptance(input), impact,
  }), now);
}

export function observeStore(db,scan,input,now) {
  const allowed=new Set(['name','subtitle','description','promotionalText','keywords','screenshots','appPreview','ageRating','category','availability','pricing','subscription','privacy','reviewNotes','reviewResponse']);
  const version=[scan?.store?.data?.live,scan?.store?.data?.candidate].find(v=>v?.id===input.versionId);
  const elapsed=Date.parse(now)-Date.parse(scan?.capturedAt);
  if(scan?.store?.status!=='ok'||!version||!Number.isFinite(elapsed)||elapsed<0||elapsed>72*3600000||
    !allowed.has(input.field)||!text(input.evidence)||!text(input.problem)||!text(input.proposedChange)||
    typeof input.before!=='string'||!text(input.after)||input.before===input.after||
    !text(input.locale)||!dayStamp(input.observedOn)||input.observedOn>date(now)||
    Date.parse(date(now))-Date.parse(input.observedOn)>3*DAY) throw new Error('Use current App Store evidence, exact version, locale, field and approved-change preview');
  if(db.operations(scan.app.id).some(t=>t.kind==='store-maintenance'&&t.storeVersionId===version.id&&!['closed','cancelled'].includes(t.status)))
    throw new Error('Existing maintenance task for this version; review and resolve it before opening a new one');
  const key='store-proactive:'+version.id+':'+input.field+':'+input.locale+':'+input.observedOn;
  return db.enqueue(baseTask(scan,'store-maintenance',key,now,{priority:2,owner:'app-store-operator',
    storeVersionId:version.id,problem:input.problem,proposedChange:input.proposedChange,
    plannedStoreChange:{field:input.field,locale:input.locale,before:input.before,after:input.after,observedOn:input.observedOn,evidence:input.evidence}}),now);
}

export function cycle(db, scans, config, now) {
  const results = [];
  for (const scan of scans) {
    const appId = scan.app.id;
    const policy = profile(config, appId);
    const items = db.operations(appId);
    const created = [];
    const updated = [];
    const waiting = [];
    const scanAge = Date.parse(now) - Date.parse(scan.capturedAt);
    if (!Number.isFinite(scanAge) || scanAge > 72 * 3_600_000 || scanAge < 0) {
      results.push({ appId, appName: scan.app.name, status: 'stale scan', next: 'Refresh Apple and GitHub evidence' });
      continue;
    }
    for (const task of items.filter((item) => item.kind === 'promotion' && item.status === 'queued')) {
      if (scan.store?.data?.live && scan.store.data.live.version !== task.expectedVersion) {
        const cancelled = db.updateOperation(task, { status: 'cancelled', reason: 'Apple live version changed before this test launched' }, 'cancelled', now);
        task.status = cancelled.status;
        updated.push(task.id);
      }
    }
    for (const task of items.filter((item) => item.status === 'implemented')) {
      const next = reconcileRelease(db, task, scan, now);
      if (next) updated.push(next.id);
      else waiting.push({ id: task.id, reason: 'Expected Apple live version/build and Git release commit have not all been verified' });
    }
    for (const task of items.filter((item) => item.status === 'live' && item.dueAt <= date(now))) {
      waiting.push({ id: task.id, reason: 'Impact measurement due', dueAt: task.dueAt });
    }
    const { candidate, store, code, triage } = reviewRoutes(scan);
    const open = (kind) => items.some((item) => item.kind === kind && !['closed', 'cancelled'].includes(item.status));
    const releaseKey = candidate?.id ?? candidate?.version ?? scan.store?.data?.live?.version ?? 'unknown';
    const enqueue = (kind, details) => {
      if (open(kind)) return;
      const previous = items.find((item) => item.kind === kind);
      const task = db.enqueue(baseTask(scan, kind, kind + ':' + releaseKey + ':' + (previous?.id ?? 0), now, details), now);
      if (task) created.push(task.id);
    };
    if (store.length) enqueue('store-maintenance', {
      priority: 1, owner: 'app-store-operator', storeVersionId: candidate.id, storeChecks: store,
      problem: 'App Store Connect listing, submission, or account check needs attention.',
      proposedChange: 'Confirm affected fields, prepare the exact change for approval, and recheck Apple after the change.',
    });
    if (triage) enqueue('review-triage', {
      priority: 1, owner: 'app-store-operator', storeVersionId: candidate?.id,
      problem: 'The exact cause of an Apple review blocker needs confirmation.',
      proposedChange: 'Read the App Review message, record the observed cause, and route a verified code issue to development.',
    });
    if (code && scan.source?.status === 'matched') enqueue('maintenance', {
      priority: 1, owner: 'external-development', target: selection(scan),
      problem: 'The static App Store compliance scan reported a blocking issue.',
      proposedChange: 'Reproduce the source-level blocker and fix the smallest confirmed issue.',
      userFlow: 'Verify the affected iOS device or review flow and regressions.',
      signals: [{ kind: 'scan', ref: scan.capturedAt, observation: scan.compliance.findings }],
      acceptance: [
        { id: 'BLOCKERS', criterion: 'Re-run the original compliance check and document the behavior or evidence that resolves the blocker.' },
        { id: 'REGRESSION', criterion: 'Provide relevant existing test commands and results plus device or simulator evidence.' },
      ],
    });
    const learning = promotionLearning(appId, policy, db.operations());
    const active = items.some((item) => item.kind === 'promotion' && !['closed', 'cancelled'].includes(item.status));
    if (stableLive(scan) && !active && policy.channels.length) {
      const channels = policy.channels.filter((channel) => !items.some((item) => item.kind === 'promotion' &&
        item.channel === channel && item.status === 'closed' && Date.parse(now) - Date.parse(item.updatedAt) < 14 * DAY));
      const own = learning.find((row) => row.scope === 'same-app' && channels.includes(row.channel) &&
        (policy.maxCpa === null || row.costPerDownload <= policy.maxCpa));
      const transferable = learning.find((row) => row.scope === 'matched-apps' && channels.includes(row.channel) &&
        !learning.some((existing) => existing.channel === row.channel && existing.scope === 'same-app') &&
        (policy.maxCpa === null || row.costPerDownload <= policy.maxCpa));
      const unexplored = channels.find((c) => !items.some((item) => item.kind === 'promotion' && item.channel === c &&
        item.status === 'closed' && item.policy.market === policy.market));
      const replication = channels.find((channel) => {
        if (learning.some((item) => item.channel === channel && item.scope === 'same-app')) return false;
        const prior = items.filter((item) => item.kind === 'promotion' && item.status === 'closed' &&
          item.channel === channel && item.policy.currency === policy.currency && item.policy.market === policy.market &&
          item.outcome?.learningEligible && item.publication?.mode === 'organic');
        return prior.length > 0 && prior.length < 3 && prior.some((item) => item.outcome.downloads > 0 && item.outcome.totalCost !== null);
      });
      const pick = own ?? transferable;
      const channel = pick?.channel ?? unexplored ?? replication;
      if (channel) {
        const live = scan.store.data.live;
        const task = db.enqueue(baseTask(scan, 'promotion', 'promotion:' + channel + ':' + live.version + ':' + scan.periods.current.end, now, {
          priority: 4, channel, policy, expectedVersion: live.version, target: selection(scan),
          hypothesis: pick ? 'Repeat a measured channel play in a comparable market.' :
            'Test a single organic, evidence-backed demo with an App Store campaign link.',
          basis: pick ?? (unexplored ? { scope: 'unmeasured', note: 'Start with an organic experiment and record time and cash.' } :
            { scope: 'replication', note: 'Collect one more comparable organic observation before ranking cost.' }),
          approvedCashLimit: 0,
        }), now);
        if (task) created.push(task.id);
      } else waiting.push({ reason: channels.length ? 'No channel has qualified cost evidence or a new test opportunity' : 'Channels are in the experiment cooldown period' });
    } else if (stableLive(scan) && !policy.channels.length) {
      waiting.push({ reason: 'Configure the app’s allowed promotion channels and measurement market' });
    }
    results.push({ appId, appName: scan.app.name, status: stableLive(scan) ? 'operational' : 'maintenance or verification needed',
      latestScan: scan.capturedAt, recommendation: scan.decision.recommendation, feedback: scan.feedback, created, updated, due: waiting, learning });
  }
  return { checkedAt: now, apps: results, queue: db.operations().filter((item) => !['closed', 'cancelled'].includes(item.status))
    .map(({ id, appId, kind, status, priority, dueAt }) => ({ id, appId, kind, status, priority, dueAt }))
    .sort((a, b) => a.priority - b.priority || a.id - b.id) };
}

const POST_HOSTS = {
  tiktok: ['tiktok.com'], instagram: ['instagram.com'], youtube: ['youtube.com', 'youtu.be'],
  x: ['x.com', 'twitter.com'], reddit: ['reddit.com', 'redd.it'], linkedin: ['linkedin.com'],
};

function publishedProof(task, input, scan, now) {
  const posting = https(input.publishedUrl);
  const link = https(input.campaignLink);
  const mode = input.mode ?? 'organic';
  if (!['organic', 'paid'].includes(mode) || (mode === 'paid' && task.approvedCashLimit <= 0) ||
    (input.format !== undefined && !FORMATS.includes(input.format)) ||
    (input.angle !== undefined && (!text(input.angle) || input.angle.length > 200)) || !posting || !POST_HOSTS[task.channel].some((host) =>
    posting.hostname === host || posting.hostname.endsWith('.' + host)) || posting.pathname === '/' ||
    !link || link.origin !== 'https://apps.apple.com' || !link.pathname.endsWith('/id' + task.appId) ||
    !link.searchParams.get('pt') || !link.searchParams.get('ct') ||
    !text(input.publishedAt) || !Number.isFinite(Date.parse(input.publishedAt)) ||
    Date.parse(input.publishedAt) > Date.parse(now) || Date.parse(input.publishedAt) < Date.parse(task.createdAt) ||
    (input.currency !== task.policy.currency) || !NONNEGATIVE(input.expectedCashCost) ||
    input.expectedCashCost > task.approvedCashLimit) {
    throw new Error('Provide the observed channel post and exact App Store campaign links, timestamp and approved cash amount');
  }
  if (!stableLive(scan) || scan.store.data.live.version !== task.expectedVersion ||
    Date.parse(now) - Date.parse(scan.capturedAt) > 72 * 3_600_000) {
    throw new Error('Refresh and confirm the App Store live version before recording a launch');
  }
  return {
    publishedUrl: posting.href, campaignLink: link.href, campaignToken: link.searchParams.get('ct'), mode, format: input.format, angle: input.angle,
    expectedCashCost: input.expectedCashCost, currency: input.currency,
  };
}

export function canHandoff(task) {
  return task.kind === 'feature' || (task.kind === 'maintenance' &&
    (task.owner === 'external-development' || task.status === 'delegated'));
}

export function handoff(db, task, dir, now, input = {}) {
  if (!canHandoff(task) || !['queued', 'delegated'].includes(task.status)) {
    throw new Error('Only queued or delegated development operations can generate a handoff');
  }
  if (input.assignee !== undefined && (!text(input.assignee) || input.assignee.length > 120)) {
    throw new Error('Use a named development agent or owner');
  }
  const packet = {
    taskId: task.id, appId: task.appId, appName: task.appName, kind: task.kind,
    target: task.target, problem: task.problem, proposedChange: task.proposedChange,
    userFlow: task.userFlow, signals: task.signals, acceptance: task.acceptance,
    impact: task.impact,
    owner: 'external-development',
    scope: 'Start from the provided commit in a separate branch. Keep changes inside the approved app and report dependencies or scope changes before editing unrelated code.',
    delivery: 'Return the commit, optional pull request, version and build expected to ship, and PASS/FAIL/BLOCKED for each exact acceptance ID with actual evidence. The operator records reviewer verification and the loop checks Apple release status.',
  };
  const output = join(dir, 'handoffs', String(task.id));
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const path = join(output, 'task.json');
  writeJson(path, packet);
  if (input.assignee && task.status === 'queued') {
    db.updateOperation(task, { status: 'delegated', assignee: input.assignee }, 'delegated', now);
  }
  return { path, packet, deliveryFormat: 'Use the implemented action with a named verifier and evidence for all acceptance IDs.' };
}

function delivery(task, input) {
  if (!SHA.test(input.commit ?? '') || input.commit === task.target.sha || !/^\d+(?:\.\d+){0,3}$/.test(input.version ?? '') ||
    !/^[\w.]+$/.test(input.build ?? '') || !text(input.verifier) ||
    input.verifier.trim().toLowerCase() === task.assignee.trim().toLowerCase() ||
    !text(input.evidence) || !Array.isArray(input.acceptance) || input.acceptance.length !== task.acceptance.length) {
    throw new Error('Provide a changed Git commit, expected Apple version/build, independent verifier, evidence and all acceptance results');
  }
  for (const { id } of task.acceptance) {
    const rows = input.acceptance.filter((row) => row.id === id);
    if (rows.length !== 1 || !['PASS', 'FAIL', 'BLOCKED'].includes(rows[0].status) || !text(rows[0].evidence)) {
      throw new Error('Return PASS, FAIL or BLOCKED with evidence for acceptance ID ' + id);
    }
  }
  const pr = input.pullRequest ? https(input.pullRequest) : null;
  if (input.pullRequest && (!pr || pr.origin !== 'https://github.com' || !/^\/[^/]+\/[^/]+\/pull\/\d+$/.test(pr.pathname) ||
    (task.target.repo.includes('/') && !pr.pathname.toLowerCase().startsWith('/' + task.target.repo.toLowerCase() + '/pull/')))) {
    throw new Error('Use the pull request URL for this repository');
  }
  if (input.acceptance.some((row) => row.status !== 'PASS')) {
    return { status: 'delegated', failedAcceptance: input.acceptance, reviewEvidence: input.evidence };
  }
  return { status: 'implemented', delivery: {
    commit: input.commit, version: input.version, build: String(input.build), verifier: input.verifier,
    evidence: input.evidence, pullRequest: pr?.href, acceptance: input.acceptance,
  } };
}

function measurement(task, input, now) {
  const { start, end, source, evidence } = input;
  if (!dayStamp(start) || !dayStamp(end) || end >= date(now) ||
    !text(source) || !text(evidence) || input.reportComplete !== true) {
    throw new Error('Use complete, dated reporting with evidence after launch and before today');
  }
  const days = task.kind === 'promotion' ? task.policy.measurementDays : task.impact.days;
  if (start !== date(Date.parse(date(task.startedAt)) + DAY) ||
    Date.parse(end) - Date.parse(start) !== (days - 1) * DAY) {
    throw new Error('Use the original observation window of ' + days + ' full days after launch');
  }
  const trace = { start, end, source, evidence, caveats: text(input.caveats) ? input.caveats : null };
  if (task.kind === 'promotion') {
    if (input.campaignToken !== task.publication.campaignToken || source !== 'App Store Connect Campaign Links' ||
      input.currency !== task.policy.currency || !count(input.downloads) ||
      !NONNEGATIVE(input.cash) || !NONNEGATIVE(input.hours)) {
      throw new Error('Provide the matching Apple campaign token, currency, first-time downloads, cash and labor hours');
    }
    const totalCost = task.policy.hourlyRate === null && input.hours > 0 ? null :
      input.cash + input.hours * (task.policy.hourlyRate ?? 0);
    const cpa = totalCost !== null && input.downloads > 0 ? totalCost / input.downloads : null;
    const budgetBreach = input.cash > task.approvedCashLimit;
    return { ...trace, downloads: input.downloads, cash: input.cash, hours: input.hours,
      totalCost, costPerDownload: cpa, budgetBreach,
      verdict: budgetBreach ? 'cash over approved limit' :
        input.downloads < task.policy.minimumDownloads ? 'below download floor' :
        cpa === null ? 'labor not priced' :
        task.policy.maxCpa !== null && cpa > task.policy.maxCpa ? 'cost above ceiling' : 'met configured targets',
      learningEligible: !budgetBreach,
      interpretation: 'Campaign attribution and observed cost per download. Incremental lift is unproven.',
    };
  }
  const goal = task.impact;
  if (source !== goal.source || input.metric !== goal.metric || input.scope !== goal.scope ||
    !NONNEGATIVE(input.value) || !count(input.sample) || input.sample < goal.minSample) {
    throw new Error('Provide the comparable predeclared feature metric, source, scope and sample floor');
  }
  const met = goal.direction === 'higher' ? input.value >= goal.target : input.value <= goal.target;
  return { ...trace, metric: goal.metric, scope: goal.scope, baseline: goal.baseline, value: input.value,
    change: input.value - goal.baseline, target: goal.target, sample: input.sample,
    verdict: met ? 'met target' : 'target missed',
    interpretation: 'Before/after observation. Check traffic mix, version adoption and concurrent changes before inferring cause.',
  };
}

export function advance(db, task, input, scan, now) {
  if (input.action === 'cancel' && !['closed', 'cancelled'].includes(task.status) && text(input.reason)) {
    return db.updateOperation(task, { status: 'cancelled', reason: input.reason }, 'cancelled', now);
  }
  if ((task.kind === 'review-triage' || (task.kind === 'maintenance' && !task.owner)) &&
    task.status === 'queued' && input.action === 'route-review') {
    const candidate = scan.store?.data?.candidate;
    const recent = Date.parse(now) - Date.parse(scan.capturedAt);
    if (scan.store?.status !== 'ok' || !candidate?.id || input.versionId !== candidate.id ||
      (task.storeVersionId && task.storeVersionId !== candidate.id) || !Number.isFinite(recent) ||
      recent < 0 || recent > 72 * 3_600_000 ||
      !text(input.problem) || !text(input.evidence) || !['store', 'developer'].includes(input.destination)) {
      throw new Error('Record a fresh, version-specific review diagnosis and traceable evidence');
    }
    if (input.destination === 'store') {
      const existing = db.operations(task.appId).find((row) => row.kind === 'store-maintenance' &&
        row.storeVersionId === candidate.id && !['closed', 'cancelled'].includes(row.status));
      if (existing) {
        const diagnosis = { problem: input.problem, evidence: input.evidence, triageTaskId: task.id };
        db.updateOperation(existing, { relatedDiagnoses: [...(existing.relatedDiagnoses ?? []), diagnosis] },
          'review-diagnosis-linked', now);
        return db.updateOperation(task, { status: 'closed',
          outcome: { verdict: 'linked to App Store Connect maintenance', taskId: existing.id, ...diagnosis } },
        'review-routed', now);
      }
      return db.updateOperation(task, { kind: 'store-maintenance', owner: 'app-store-operator',
        storeVersionId: candidate.id, problem: input.problem, diagnosis: input.evidence }, 'review-routed', now);
    }
    if (scan.source?.status !== 'matched' || !text(input.userFlow) || !text(input.proposedChange) ||
      !Array.isArray(input.acceptance) || input.acceptance.length < 2 || input.acceptance.length > 12 ||
      !input.acceptance.every(text)) throw new Error('A confirmed code issue requires a matched source, user flow and testable acceptance criteria');
    return db.updateOperation(task, { kind: 'maintenance', owner: 'external-development', target: selection(scan),
      storeVersionId: candidate.id, problem: input.problem, proposedChange: input.proposedChange,
      userFlow: input.userFlow, signals: [{ kind: 'app-review-diagnosis', ref: candidate.id, observation: input.evidence }],
      acceptance: buildAcceptance(input) }, 'review-routed', now);
  }
  if (task.kind === 'store-maintenance' && task.status === 'queued' && input.action === 'store-resolved') {
    const proof = storeProof(task, scan, input, now);
    return db.updateOperation(task, { status: 'closed',
      outcome: { verdict: 'App Store Connect change verified', ...proof } }, 'store-verified', now);
  }
  if (task.kind === 'promotion' && task.status === 'queued' && input.action === 'authorize-cost') {
    if (input.currency !== task.policy.currency || !NONNEGATIVE(input.amount) || input.amount > task.policy.cashCap ||
      !text(input.approvalReference)) throw new Error('A specific operator approval and an amount within the per-experiment cash cap are required');
    return db.updateOperation(task, { approvedCashLimit: input.amount, approvalReference: input.approvalReference },
      'budget-recorded', now);
  }
  if (task.kind === 'promotion' && task.status === 'queued' && input.action === 'published') {
    const publication = publishedProof(task, input, scan, now);
    if (db.operations(task.appId).some((other) => other.id !== task.id &&
      other.publication?.campaignToken === publication.campaignToken)) throw new Error('Use a fresh campaign token for each experiment');
    return db.updateOperation(task, { status: 'live', publication, startedAt: input.publishedAt,
      dueAt: date(Date.parse(date(input.publishedAt)) + (task.policy.measurementDays + 1) * DAY) }, 'published', now);
  }
  if (canHandoff(task) && task.status === 'delegated' && input.action === 'implemented') {
    const result = delivery(task, input);
    if (result.status === 'implemented' && scan.store?.data?.live?.version === result.delivery.version &&
      String(scan.store.data.live.buildNumber) === result.delivery.build) {
      throw new Error('Provide the expected new release rather than the currently live build');
    }
    return db.updateOperation(task, result, result.status === 'implemented' ? 'acceptance-passed' : 'acceptance-open', now);
  }
  if (task.status === 'live' && input.action === 'measure') {
    const outcome = measurement(task, input, now);
    return db.updateOperation(task, { status: 'closed', outcome }, 'measured', now);
  }
  throw new Error('This action is not valid for the task kind and current status');
}

export function memory(db, config, appId) {
  const items = db.operations();
  return db.latestScans().filter((scan) => !appId || scan.app.id === appId).map((scan) => {
    const id = scan.app.id;
    const own = items.filter((item) => item.appId === id);
    return {
      appId: id, appName: scan.app.name,
      promotionEvidence: promotionLearning(id, profile(config, id), items),
      recentOutcomes: own.filter((item) => item.outcome).slice(0, 12).map(({ id, kind, channel, deployment, publication, outcome }) =>
        ({ id, kind, channel, deployment, publication, outcome })),
      open: own.filter((item) => !['closed', 'cancelled'].includes(item.status))
        .map(({ id, kind, status, dueAt, priority }) => ({ id, kind, status, dueAt, priority })),
    };
  });
}

const REVIEW_THEMES = [
  ['crash', /\b(crash(?:es|ed|ing)?|freeze[sd]?|froze|unresponsive)\b|闪退|卡死|崩溃/i],
  ['onboarding and sign-in', /\b(sign[ -]?up|log[ -]?in|onboarding|sign[ -]?in|forgot password)\b|登录|注册/i],
  ['price and billing', /\b(subscription|paywall|charged|billing|too expensive)\b|订阅|收费|扣费/i],
  ['accessibility and localization', /\b(voiceover|accessibility|translation|dark mode|font size)\b|无障碍|翻译|字体/i],
  ['data and sync', /\b(sync(?:ing)?|backup|export|lost data|restore)\b|同步|备份|导出/i],
  ['feature requests', /\b(could you add|please add|wish (?:it|you)|would love (?:to|a)|missing feature)\b|希望增加|希望添加|建议增加/i],
];

export function feedbackDigest(rows, now) {
  const cutoff = date(Date.parse(now) - 90 * DAY);
  const reviews = [...new Map(rows.filter((row) => dayStamp(row.date) && row.date >= cutoff && row.date <= date(now) && text(row.id))
    .map((row) => [row.id, row])).values()];
  return {
    source: 'App Store Connect, latest 60 reviews, last 90 days', count: reviews.length,
    themes: REVIEW_THEMES.flatMap(([theme, pattern]) => {
      const seen = new Set();
      const confirmed = reviews.filter((row) => {
        const body = [row.title, row.body].filter(text).join(' ').trim().toLowerCase();
        if (seen.has(body) || !pattern.test(body)) return false;
        seen.add(body);
        return true;
      });
      return confirmed.length >= 2 ? [{ theme, observations: confirmed.length, reviewIds: confirmed.map(({ id }) => id) }] : [];
    }),
    interpretation: 'Signals from self-selected reviewers. Verify complaint or request intent, app version and size of the affected cohort before scoping work.',
  };
}
