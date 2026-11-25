import { attempt, jsonCommand } from './io.mjs';

const LIVE = 'READY_FOR_DISTRIBUTION';
const RETIRED = new Set(['REPLACED_WITH_NEW_VERSION', 'REMOVED_FROM_SALE', 'DEVELOPER_REMOVED_FROM_SALE']);

export function appleClient(config = {}) {
  const cli = config.cli ?? 'asc';
  const profile = config.profile ? ['--profile', config.profile] : [];
  const asc = (args, options) => jsonCommand(cli, [...args, '--output', 'json', ...profile], options);
  const rows = (response) => {
    if (!Array.isArray(response.data)) throw new Error('Expected ASC data array');
    return response.data;
  };

  return {
    apps() {
      return rows(asc(['apps', 'list', '--paginate'])).map(({ id, attributes }) => ({
        id, name: attributes.name, bundleId: attributes.bundleId, sku: attributes.sku,
      }));
    },
    status(id) {
      const response = asc(['versions', 'list', '--app', id, '--platform', 'IOS', '--paginate',
        '--include', 'build,appStoreVersionSubmission']);
      const builds = new Map((response.included ?? []).filter((item) => item.type === 'builds').map((build) => [build.id, build.attributes]));
      const versions = rows(response).map(({ id, attributes: a, relationships: r }) => {
        const buildId = r?.build?.data?.id;
        return { id, version: a.versionString, state: a.appVersionState ?? a.appStoreState,
          createdAt: a.createdDate, buildId, buildNumber: builds.get(buildId)?.version,
          buildProcessing: builds.get(buildId)?.processingState,
          submissionId: r?.appStoreVersionSubmission?.data?.id };
      }).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') ||
        (b.version ?? '').localeCompare(a.version ?? '', undefined, { numeric: true }));
      const live = versions.find((v) => v.state === LIVE || v.state === 'READY_FOR_SALE') ?? null;
      return { live, candidate: versions.find((v) => v !== live && v.state !== 'READY_FOR_SALE' &&
        v.state !== LIVE && !RETIRED.has(v.state) &&
        (!live || versions.indexOf(v) < versions.indexOf(live))) ?? null, versions: versions.slice(0, 12) };
    },
    reviews(id) {
      const response = asc(['reviews', 'list', '--app', id, '--limit', '60', '--sort=-createdDate',
        '--fields', 'rating,title,body,createdDate,territory']);
      return rows(response).map(({ id: reviewId, attributes }) => ({ id: reviewId,
        date: attributes.createdDate?.slice(0, 10), rating: attributes.rating, territory: attributes.territory,
        title: attributes.title?.slice(0, 150), body: attributes.body?.slice(0, 800),
      }));
    },
    latestUpload(id) {
      const response = asc(['builds', 'list', '--app', id, '--platform', 'IOS', '--limit', '1',
        '--sort=-uploadedDate', '--include', 'preReleaseVersion']);
      const build = rows(response)[0];
      if (!build) return null;
      const version = response.included?.find((entry) => entry.id === build.relationships?.preReleaseVersion?.data?.id &&
        entry.type === 'preReleaseVersions');
      return { id: build.id, number: build.attributes.version, version: version?.attributes?.version,
        uploadedAt: build.attributes.uploadedDate, state: build.attributes.processingState };
    },
    review(id, versionId) {
      try {
        return asc(['validate', '--app', id, '--version-id', versionId, '--platform', 'IOS']);
      } catch (error) {
        // The CLI prints its diagnostic JSON before returning a nonzero code for blockers.
        if (!Number.isInteger(error.status) || !error.stdout) throw error;
        const report = JSON.parse(error.stdout);
        if (!(report.summary?.blocking > 0)) throw error;
        return report;
      }
    },
    sales(id, periods) {
      const { previous, current } = periods;
      const vendor = config.vendor ?? process.env.ASC_VENDOR_NUMBER;
      if (!vendor) return { status: 'unavailable', reason: 'ASC vendor number is missing' };
      return attempt(() => {
        const response = asc(['analytics', 'compare', '--source', 'sales', '--vendor', String(vendor),
          '--app', id, '--from', previous.start, '--from-end', previous.end,
          '--to', current.start, '--to-end', current.end, '--frequency', 'DAILY', '--by-currency'],
        { timeout: 120_000 });
        if (!Array.isArray(response.metrics)) throw new Error('Expected sales metrics');
        return { baseline: response.baseline, comparison: response.comparison, metrics: response.metrics };
      });
    },
    ads(periods, ads = {}) {
      const configuredAccounts = ads.accounts?.length ? ads.accounts : (process.env.ASC_ADS_AD_ACCOUNT_ID ? [process.env.ASC_ADS_AD_ACCOUNT_ID] : []);
      const accounts = [...new Set(configuredAccounts.map(String))];
      if (!accounts.length) return { status: 'unavailable', reason: 'Apple Ads account IDs are missing' };
      return attempt(() => accounts.map((account) => {
        const fetchPeriod = ({ start, end }) => {
          const response = [];
          const pageSize = 100;
          for (let offset = 0; offset < 10_000; offset += pageSize) {
            const body = { timeRange: { start, end, timeZone: 'ORTZ' },
              fields: ['localSpend', 'tapNewDownloads'], pagination: { offset, pageSize } };
            const args = ['ads', 'reports', 'apps', 'campaigns', '--ad-account', String(account), '--file', '-', '--output', 'json'];
            if (ads.profile) args.push('--ads-profile', ads.profile);
            const page = jsonCommand(cli, args, { input: JSON.stringify(body) });
            const data = page.result?.rows;
            if (!Array.isArray(data)) throw new Error('Unknown Apple Ads report format');
            response.push(...data);
            const total = page.pagination?.totalCount;
            if (Number.isInteger(total) ? response.length >= total : data.length < pageSize) return response;
            if (data.length === 0) throw new Error('Incomplete Apple Ads report');
          }
          throw new Error('Apple Ads report exceeded pagination limit');
        };
        return { account: String(account), current: fetchPeriod(periods.current), previous: fetchPeriod(periods.previous) };
      }));
    },
  };
}
