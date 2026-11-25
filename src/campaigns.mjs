// Campaign planning: a weekly content calendar across channels, and an exact Apple Ads
// plan preview for owner approval. Neither action posts, spends or changes an external account.
import { createHash } from 'node:crypto';
import { assertEvidenceApp } from './app-context.mjs';
import { profile, FORMATS, PAID_CHANNELS } from './operator.mjs';

const DAY = 86_400_000;
const text = (x, n = 500) => typeof x === 'string' && x.trim().length > 0 && x.length <= n;
const money = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0 && Math.round(x * 100) === x * 100;
const date = (x) => new Date(x).toISOString().slice(0, 10);
const stamp = (x) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && Number.isFinite(Date.parse(x)) && date(x) === x;

export function contentPlan(db, id, config, input, now) {
  assertEvidenceApp(id, input);
  const policy = profile(config, id);
  const { weekStart, entries } = input;
  const today = date(now);
  if (!stamp(weekStart) || Date.parse(weekStart) < Date.parse(today) - 6 * DAY || Date.parse(weekStart) > Date.parse(today) + 56 * DAY ||
    !Array.isArray(entries) || entries.length < 1 || entries.length > 28) {
    throw new Error('Content plan needs weekStart (YYYY-MM-DD, this week up to 8 weeks ahead) and 1-28 entries');
  }
  const active = db.operations(id).filter((t) => t.kind === 'promotion' && !['closed', 'cancelled'].includes(t.status));
  const rows = entries.map((entry, index) => {
    const offset = (Date.parse(entry.date) - Date.parse(weekStart)) / DAY;
    const task = entry.taskId === undefined ? null : active.find((t) => t.id === entry.taskId);
    if (!stamp(entry.date) || offset < 0 || offset > 6 || !policy.channels.includes(entry.channel) || PAID_CHANNELS.includes(entry.channel) ||
      !FORMATS.includes(entry.format) || !text(entry.angle, 200) || !text(entry.hook, 200) ||
      (entry.taskId !== undefined && (!task || task.channel !== entry.channel)) ||
      (entry.assetRef !== undefined && !text(entry.assetRef, 300))) {
      throw new Error('Entry ' + (index + 1) + ': use a date inside the week, a configured social channel (' +
        policy.channels.filter((c) => !PAID_CHANNELS.includes(c)).join(', ') + '), format (' + FORMATS.join(', ') +
        '), angle, hook and optional active same-channel taskId');
    }
    return { date: entry.date, channel: entry.channel, format: entry.format, angle: entry.angle, hook: entry.hook,
      taskId: task?.id ?? null, assetRef: entry.assetRef ?? null, status: 'planned' };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.channel.localeCompare(b.channel));
  const coverage = policy.channels.filter((c) => !PAID_CHANNELS.includes(c)).map((channel) => ({
    channel, planned: rows.filter((r) => r.channel === channel).length,
    activeTaskId: active.find((t) => t.channel === channel)?.id ?? null,
  }));
  const plan = { appId: id, weekStart, entries: rows, coverage, recordedAt: now,
    notice: 'A plan, not authorization. Each post still needs its final preview, approval and the post action with the observed URL. Entries without an active task are organic content outside a measured campaign.' };
  return db.saveOpsEvidence(id, 'content-plan', weekStart + '|' + now, plan);
}

export function planAppleAds(db, scan, id, config, input, now) {
  assertEvidenceApp(id, input);
  const task = db.operation(input.taskId, id);
  const policy = profile(config, id);
  if (!task || task.kind !== 'promotion' || task.channel !== 'apple-ads' || task.status !== 'queued') {
    throw new Error('ads-plan needs a queued apple-ads promotion taskId for this app');
  }
  if (scan?.store?.data?.live?.version !== task.expectedVersion) throw new Error('Refresh the scan; the live version differs from the task');
  const { accountId, campaignName, countries, currency, dailyBudget, totalBudget, billingPeriod, startDate, endDate, keywords, maxCpt } = input;
  const days = (Date.parse(endDate) - Date.parse(startDate)) / DAY + 1;
  if (!text(String(accountId ?? ''), 40) || !/^[\w-]+$/.test(String(accountId)) || !text(campaignName, 200) ||
    !Array.isArray(countries) || !countries.length || countries.length > 20 || countries.some((c) => !/^[A-Z]{2}$/.test(c)) ||
    currency !== policy.currency || !money(dailyBudget) || !money(totalBudget) || dailyBudget > totalBudget ||
    !['campaign-lifetime', 'monthly-invoice', 'card-per-charge'].includes(billingPeriod) ||
    !stamp(startDate) || !stamp(endDate) || startDate < date(now) || days < 1 || days > 90 ||
    !Array.isArray(keywords) || keywords.length > 200 || keywords.some((k) => !text(k?.text, 80) || !['exact', 'broad'].includes(k.matchType)) ||
    (maxCpt !== undefined && !money(maxCpt))) {
    throw new Error('ads-plan needs accountId, campaignName, countries (ISO), currency ' + policy.currency +
      ', dailyBudget <= totalBudget (2 decimals), billingPeriod (campaign-lifetime, monthly-invoice, card-per-charge), startDate today or later, endDate within 90 days, keywords [{text, matchType exact|broad}] and optional maxCpt');
  }
  if (totalBudget > policy.cashCap) throw new Error('totalBudget ' + totalBudget + ' exceeds the configured per-experiment cashCap ' + policy.cashCap);
  if (totalBudget > task.approvedCashLimit) {
    throw new Error('Record the owner budget approval first with advance action authorize-cost (amount >= ' + totalBudget + ')');
  }
  const plan = { appId: id, taskId: task.id, accountId: String(accountId), campaignName, countries, currency, dailyBudget,
    totalBudget, billingPeriod, startDate, endDate, keywords, maxCpt: maxCpt ?? null, liveVersion: task.expectedVersion };
  const fingerprint = createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 24);
  const preview = {
    account: 'Apple Ads account ' + plan.accountId, destination: 'Apple Ads (ads.apple.com), App Store search results',
    app: { id, name: scan.app.name, version: task.expectedVersion }, campaignName, countries, currency,
    budget: { daily: dailyBudget, total: totalBudget }, billingPeriod, startDate, endDate, keywords, maxCpt: plan.maxCpt,
  };
  const approvalStatement = 'Approve Apple Ads campaign "' + campaignName + '" for ' + scan.app.name + ' (' + id + ') in account ' +
    plan.accountId + ': ' + currency + ' ' + dailyBudget + '/day, ' + currency + ' ' + totalBudget + ' total, billing ' + billingPeriod +
    ', ' + startDate + ' to ' + endDate + ', countries ' + countries.join(', ') + ', ' + keywords.length + ' keywords. Fingerprint ' + fingerprint + '.';
  db.saveOpsEvidence(id, 'ads-plan', task.id + '|' + fingerprint, { ...plan, fingerprint, recordedAt: now, state: 'awaiting-approval' });
  return { fingerprint, preview, approvalStatement,
    next: 'Show the preview and approval statement to the owner verbatim. Only after explicit approval, create the campaign in the approved Apple Ads browser session, verify the campaign receipt, then run advance with action ads-launched, this fingerprint, approvalReference, campaignId, receiptEvidence and launchedAt.' };
}
