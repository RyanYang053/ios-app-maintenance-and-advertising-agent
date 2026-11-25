const DAY = 86_400_000;
const COUNT = ['impressions', 'productPageViews', 'firstTimeDownloads', 'paidConversions', 'campaignDownloads'];

export function reportingPeriods(days = 7, now = new Date()) {
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('days must be from 1 to 30');
  const label = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(now);
  const end = Date.parse(label + 'T00:00:00Z') - 3 * DAY;
  const date = (ms) => new Date(ms).toISOString().slice(0, 10);
  return {
    current: { start: date(end - (days - 1) * DAY), end: date(end) },
    previous: { start: date(end - (2 * days - 1) * DAY), end: date(end - days * DAY) },
  };
}

export function normalizeAnalytics(entry, periods) {
  const result = {};
  for (const key of ['current', 'previous']) {
    const row = entry?.[key];
    if (!row || row.start !== periods[key].start || row.end !== periods[key].end ||
      typeof row.source !== 'string' || !row.source.trim() ||
      typeof row.scope !== 'string' || !row.scope.trim()) continue;
    result[key] = Object.fromEntries(Object.entries(row).filter(([name, value]) =>
      ['start', 'end', 'source', 'scope'].includes(name) ||
      (COUNT.includes(name) && Number.isSafeInteger(value) && value >= 0)));
  }
  if (result.current && result.previous &&
    (result.current.source !== result.previous.source || result.current.scope !== result.previous.scope)) {
    return { current: result.current, issue: 'Comparison requires matching source and scope' };
  }
  return result;
}

export function normalizeBrowserSales(entry, periods) {
  if (!entry || typeof entry.source !== 'string' || !entry.source.trim() ||
    typeof entry.scope !== 'string' || !entry.scope.trim()) {
    return { status: 'unavailable', reason: 'Browser sales require a source and scope' };
  }
  const { current: c, previous: p } = entry;
  if (!c || !p || ![c, p].every((row, index) => {
    const period = periods[index ? 'previous' : 'current'];
    return row.start === period.start && row.end === period.end;
  })) return { status: 'unavailable', reason: 'Browser sales require both exact reporting windows' };
  const metrics = [];
  if ([c, p].every((row) => Number.isSafeInteger(row.downloadUnits) && row.downloadUnits >= 0)) {
    metrics.push({ name: 'download_units', baseline: p.downloadUnits, comparison: c.downloadUnits, unit: 'count' });
  }
  const proceeds = (row) => new Map(Object.entries(row.developerProceeds ?? {}).filter(([currency, amount]) =>
    /^[A-Z]{3}$/.test(currency) && typeof amount === 'number' && Number.isFinite(amount)));
  const before = proceeds(p);
  const after = proceeds(c);
  const currencies = [...new Set([...before.keys(), ...after.keys()])];
  if (currencies.length) metrics.push({ name: 'developer_proceeds', byCurrency: currencies.map((currency) =>
    ({ currency, baseline: before.get(currency), comparison: after.get(currency) })) });
  return metrics.length ? { status: 'ok', source: entry.source, scope: entry.scope,
    data: { baseline: periods.previous, comparison: periods.current, metrics } } :
    { status: 'unavailable', reason: 'No observed sales metrics in the import' };
}

function spendAmount(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) return NaN;
  return Number(value);
}

export function summarizeAds(raw, appId, periods, imported, mapping = {}) {
  const currencyTotals = (rows) => {
    const totals = {};
    for (const row of rows) totals[row.currency] = Math.round(((totals[row.currency] ?? 0) + row.amount) * 100_000_000) / 100_000_000;
    return totals;
  };
  if (imported) {
    if (typeof imported.source !== 'string' || !imported.source.trim()) return { status: 'unavailable', reason: 'Ad spend needs a source' };
    const data = { status: 'reported', source: imported.source };
    for (const key of ['current', 'previous']) {
      const row = imported[key];
      if (!row || row.start !== periods[key].start || row.end !== periods[key].end || !Array.isArray(row.spend) ||
        row.spend.some(({ currency, amount }) => !/^[A-Z]{3}$/.test(currency) || !Number.isFinite(spendAmount(amount)))) {
        return { status: 'unavailable', reason: 'Ad spend must cover both exact reporting windows and include currencies' };
      }
      data[key] = currencyTotals(row.spend.map(({ amount, currency }) => ({ amount: spendAmount(amount), currency })));
    }
    return data;
  }
  if (raw.status !== 'ok') return raw;
  const result = { status: 'reported', source: 'Apple Ads Platform API, configured accounts, account time zone',
    efficiency: {} };
  for (const key of ['current', 'previous']) {
    const rows = [];
    for (const { account, [key]: campaigns } of raw.data) {
      for (const row of campaigns) {
        const meta = row.metadata ?? row.dimensions ?? row;
        const campaign = meta.id ?? meta.campaignId;
        const linked = meta.promotedObjectId ?? meta.adamId ?? mapping[account]?.[campaign];
        if (linked == null) return { status: 'partial', reason: 'Unmapped Apple Ads campaigns. Add account/campaign to App Store ID mappings.' };
        if (String(linked) !== appId) continue;
        const spend = row.totalMetrics?.localSpend;
        const amount = spendAmount(spend?.amount);
        if (!Number.isFinite(amount) || !/^[A-Z]{3}$/.test(spend?.currency)) {
          return { status: 'partial', reason: 'Apple Ads spend is missing a usable amount or currency' };
        }
        rows.push({ amount, currency: spend.currency, newDownloads: row.totalMetrics.tapNewDownloads });
      }
    }
    result[key] = currencyTotals(rows);
    result.efficiency[key] = Object.fromEntries(Object.entries(result[key]).flatMap(([currency, amount]) => {
      const group = rows.filter((row) => row.currency === currency);
      if (!group.every((row) => Number.isSafeInteger(row.newDownloads) && row.newDownloads >= 0)) return [];
      const tapNewDownloads = group.reduce((count, row) => count + row.newDownloads, 0);
      return [[currency, { tapNewDownloads, costPerTapNewDownload: tapNewDownloads > 0 ? amount / tapNewDownloads : null }]];
    }));
  }
  return result;
}

export function diagnose(app, store, sales, analytics, { ads, source, compliance }) {
  const ideas = [];
  const add = (priority, finding, action, measure) => ideas.push({ priority, finding, action, measure });
  if (store.status !== 'ok') add(1, 'Store status is unknown', 'Open the authorized App Store Connect session and verify the iOS version and availability.', 'iOS version and review state');
  else if (!store.data.live) add(1, 'No live iOS version found', 'Resolve distribution or review issues before driving App Store traffic.', 'Live iOS version');
  if (/REJECTED|INVALID|REMOVED/.test(store.data?.candidate?.state ?? '')) {
    add(1, 'The next iOS version has a review blocker', 'Read the exact review message and run the code guard and ASC validator against the candidate.', 'Review blocker status');
  }
  if (source.status !== 'matched') add(1, 'App source is unresolved', 'Confirm the GitHub repo, app folder and ref before asserting features or producing content.', 'Exact bundle ID and commit');
  if (['blocked', 'findings'].includes(compliance.status)) add(1, 'Static compliance scan found release risks', 'Verify each finding against Apple’s current guidelines, the build and the listing.', 'Confirmed findings resolved');

  const c = analytics.current;
  const p = analytics.previous;
  const comparable = Boolean(c && p);
  if (comparable && c.impressions != null && p.impressions >= 100 && c.impressions <= p.impressions * 0.8) {
    add(2, 'Impressions fell at least 20% versus the prior window', 'Break out country and acquisition source. Try a tracked demo on one relevant social channel.', 'Impressions and campaign downloads');
  }
  // Downloads and product page views are distinct surfaces in Apple Analytics. Avoid constructing a false conversion rate.
  if (comparable && c.productPageViews >= 100 && p.productPageViews >= 100 &&
    c.productPageViews >= p.productPageViews * 0.9 && c.firstTimeDownloads != null &&
    p.firstTimeDownloads >= 20 && c.firstTimeDownloads <= p.firstTimeDownloads * 0.8) {
    add(2, 'First-time downloads fell while page traffic held up', 'Check acquisition mix first, then test the first screenshots or value proposition through Product Page Optimization.', 'Apple’s reported conversion metric by comparable acquisition segment');
  }
  if (comparable && c.firstTimeDownloads >= 50 && c.paidConversions != null &&
    p.firstTimeDownloads >= 50 && p.paidConversions >= 10 &&
    c.paidConversions / c.firstTimeDownloads <= p.paidConversions / p.firstTimeDownloads * 0.8) {
    add(2, 'Same-period paid conversions per download fell', 'Check acquisition mix and onboarding. Validate paid conversion with install cohorts before changing the paywall.', 'Install-cohort trial and paid conversion');
  }
  const downloads = sales.data?.metrics.find((metric) => metric.name === 'download_units');
  if (!ideas.some((item) => item.priority === 2) && downloads?.baseline >= 20 && Number.isFinite(downloads.comparison) && downloads.comparison <= downloads.baseline * 0.8) {
    add(2, 'Sales and Trends download units fell at least 20%', 'Pull App Analytics by country and source to localize the drop before redesigning or buying traffic.', 'Comparable first-time downloads and acquisition mix');
  }
  for (const [currency, observed] of Object.entries(ads.efficiency?.current ?? {})) {
    const before = ads.efficiency?.previous?.[currency];
    if (observed.tapNewDownloads >= 20 && before?.tapNewDownloads >= 20 &&
      before.costPerTapNewDownload > 0 && observed.costPerTapNewDownload > before.costPerTapNewDownload * 1.25) {
      add(2, `Apple Ads cost per tap-attributed new download rose more than 25% in ${currency}`,
        'Inspect campaign and keyword mix before raising budget. Check install-cohort proceeds before using spend to scale.',
        'Tap-attributed new downloads and cost per new download by campaign and currency');
    }
  }
  if (!comparable) add(3, 'Comparable funnel data is missing', 'Import matching App Analytics windows and specify territory and channel scopes.', 'Comparable impressions, page views, and downloads');
  if (ads.status !== 'reported') add(3, 'Verified ad spend is missing or incomplete', 'Connect Apple Ads or import a scoped export. Avoid estimating ROI from store revenue alone.', 'Spend per currency and attributable outcome by channel');
  if (!ideas.length) add(3, 'No configured rule detected a material drop', 'Test one verified feature demo with its own campaign link and compare against the prior period.', 'Campaign downloads followed by paid cohort conversion');

  return { appId: app.id, appName: app.name, recommendation: ideas[0], ideas,
    methodology: 'Rules are screening thresholds. Compare like periods and verify source mix, releases, seasonality and data delays before inferring cause.' };
}
