import { copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, resolve } from 'node:path';
import { jsonCommand, readJson, run, writeJson } from './io.mjs';

const PLATFORMS = {
  tiktok: { url: 'https://www.tiktok.com/tiktokstudio/upload', format: '9:16 product demo with captions', platformNotes: 'Show the problem and a real action in the opening seconds. Confirm account and music rights.' },
  instagram: { url: 'https://www.instagram.com/', format: '9:16 Reel with a thumbnail and caption', platformNotes: 'Keep the important screen area and caption clear of overlays. Verify where the campaign link is accessible.' },
  youtube: { url: 'https://studio.youtube.com/', format: '9:16 Short with a clear title', platformNotes: 'Prepare a thumbnail or frame, description and supported link placement. Verify upload settings.' },
  x: { url: 'https://x.com/compose/post', format: 'Short native demo or screenshot with a concise post', platformNotes: 'Lead with one outcome and link the exact store campaign. Avoid duplicate replies.' },
  reddit: { url: 'https://www.reddit.com/', format: 'Useful community-specific write-up and optional demo', platformNotes: 'Read each community’s rules, disclose affiliation, and use only the permitted self-promotion thread or format.' },
  linkedin: { url: 'https://www.linkedin.com/feed/', format: 'Native demo with a practical founder or product story', platformNotes: 'Show the use case, what changed and who benefits.' },
};

function storeLink(value, id, required = false) {
  if (!value && !required) return null;
  const url = new URL(value);
  if (url.origin !== 'https://apps.apple.com' || url.username || url.password ||
    !url.pathname.endsWith('/id' + id) || (required && (!url.searchParams.get('pt') || !url.searchParams.get('ct')))) {
    throw new Error('Use an apps.apple.com campaign link for this exact App Store ID, with pt and ct');
  }
  return url.href;
}

export function prepareBrief(scan, options, dir) {
  if (scan.source.status !== 'matched') throw new Error('Confirm the GitHub repo/folder/ref and scan again before creating App claims');
  if (!scan.store.data?.live) throw new Error('A verified live iOS version is required for this public promotion brief');
  if (scan.source.releaseStatus !== 'tag-match' || !scan.source.release?.sha || options.listingSha !== scan.source.release.sha) {
    throw new Error('Promotion claims require the matched live release tag; development HEAD is not shipped evidence. Resolve release provenance first.');
  }
  const liveVersion = scan.store.data.live.version;
  const requiredText = ['audience', 'hook', 'proof', 'cta'];
  if (options.verifiedVersion !== liveVersion || requiredText.some((key) =>
    typeof options[key] !== 'string' || !options[key].trim())) {
    throw new Error('Provide the verified live version, audience, hook, proof and call to action');
  }
  const platforms = [...new Set(options.platforms ?? [])];
  if (!platforms.length || platforms.some((key) => !Object.hasOwn(PLATFORMS, key))) throw new Error('Choose at least one supported platform');

  const usedLinks = new Set();
  const channels = platforms.map((key) => {
    const campaignLink = storeLink(options.campaignLinks?.[key], scan.app.id);
    const campaign = campaignLink && new URL(campaignLink).searchParams.get('ct');
    if (campaign && usedLinks.has(campaign)) throw new Error('Use a distinct campaign token for each channel');
    if (campaign) {
      storeLink(campaignLink, scan.app.id, true);
      usedLinks.add(campaign);
    }
    return { platform: key, ...PLATFORMS[key], campaignLink: campaign ? campaignLink : null,
      tracking: campaign ? 'ready' : 'needs Apple campaign link' };
  });

  const result = {
    state: 'draft', appId: scan.app.id, appName: scan.app.name, liveVersion,
    listingSha: options.listingSha, checkedAt: scan.capturedAt, audience: options.audience,
    hook: options.hook, featureProof: options.proof, cta: options.cta, recommendation: scan.decision.recommendation,
    sceneCopy: [options.hook, options.proof, options.cta],
    channels, measurement: 'Check each campaign URL and record published URL/date after approval. Compare attributed downloads in App Analytics after reporting and privacy thresholds permit.',
  };
  writeJson(join(dir, 'brief.json'), result);
  return result;
}

const escape = (value) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function renderVideo(briefPath, screenshot, outDir) {
  const brief = readJson(briefPath);
  if (brief.state !== 'draft' || !Array.isArray(brief.sceneCopy) || brief.sceneCopy.length !== 3 ||
    ![brief.appName, ...brief.sceneCopy].every((text) => typeof text === 'string' && text.trim() && text.length < 105)) {
    throw new Error('Use a generated brief with three short, approved scenes');
  }
  const extension = extname(screenshot).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extension) || !statSync(screenshot).isFile()) {
    throw new Error('Supply an approved real App screenshot as PNG, JPEG or WebP');
  }
  const require = createRequire(import.meta.url);
  const env = { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1' };
  const assets = join(outDir, 'assets');
  mkdirSync(assets, { recursive: true, mode: 0o700 });
  copyFileSync(screenshot, join(assets, 'screen' + extension));
  copyFileSync(require.resolve('gsap/dist/gsap.min.js'), join(assets, 'gsap.min.js'));
  const scenes = brief.sceneCopy.map((copy, i) => `<section class="clip scene" id="scene-${i}" data-start="${i * 4}" data-duration="4" data-track-index="1"><h1>${escape(copy)}</h1></section>`).join('\n');
  writeFileSync(join(outDir, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><script src="assets/gsap.min.js"></script><style>
*{box-sizing:border-box} html,body{margin:0;background:#101b19;font-family:Arial,sans-serif;color:#f0f7e8}
[data-composition-id]{position:relative;width:1080px;height:1920px;overflow:hidden;background:radial-gradient(ellipse at 85% 72%,#1c5446,#101b19 69%)}
.brand{position:absolute;left:104px;top:144px;font-size:39px;font-weight:700;color:#c6f876}
.scene{position:absolute;left:104px;top:260px;width:860px}
h1{font-size:88px;line-height:1.02;letter-spacing:-3px;margin:0;overflow-wrap:anywhere}
.screen{position:absolute;left:177px;top:755px;width:726px;height:960px;object-fit:contain;border-radius:32px}
</style></head><body>
<main id="promo" data-composition-id="promo" data-start="0" data-duration="12" data-width="1080" data-height="1920">
  <div class="brand">${escape(brief.appName)}</div>
  <img id="screen" class="clip screen" data-start="0" data-duration="12" data-track-index="0" src="assets/screen${extension}" alt="">
  ${scenes}
</main>
<script>
const timeline = gsap.timeline({paused:true});
timeline.from('#screen', {opacity:0, y:46, duration:0.55, ease:'power2.out'}, 0);
[0, 1, 2].forEach((i) => {
  timeline.from('#scene-' + i + ' h1', {opacity:0, y:38, duration:0.44, ease:'power2.out'}, 4 * i);
  timeline.to('#scene-' + i + ' h1', {opacity:0, y:-18, duration:0.22}, 4 * i + 3.77);
});
window.__timelines = {promo:timeline};
</script></body></html>`, { mode: 0o600 });
  const output = resolve(outDir, 'promo.mp4');
  run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', 'hyperframes@0.9.95', 'render',
    outDir, '--output', output, '--fps', '30', '--quality', 'draft', '--workers', '1'],
  { timeout: 300_000, env });
  const probe = jsonCommand('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,codec_name:format=duration', '-of', 'json', output]);
  const stream = probe.streams?.[0];
  if (stream?.width !== 1080 || stream.height !== 1920 || Math.abs(Number(probe.format.duration) - 12) > 0.1) {
    throw new Error('Rendered video did not pass format validation');
  }
  return { output, width: stream.width, height: stream.height, duration: Number(probe.format.duration) };
}

export const dashboards = {
  asc: 'https://appstoreconnect.apple.com/',
  ads: 'https://ads.apple.com/',
  ...Object.fromEntries(Object.entries(PLATFORMS).map(([key, value]) => [key, value.url])),
};

const LISTING_LIMITS = {
  subtitle: 30, promotionalText: 170, description: 4000, keywords: 100,
};

export function prepareStoreDraft(scan, input, dir) {
  const versions = [scan.store.data?.candidate, scan.store.data?.live];
  const target = versions.find((version) => version && version.id === input.versionId && version.version === input.version);
  if (!target || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(input.locale ?? '') ||
    typeof input.hypothesis !== 'string' || !input.hypothesis.trim() ||
    typeof input.metric !== 'string' || !input.metric.trim() || !Array.isArray(input.changes) || !input.changes.length) {
    throw new Error('Provide a known version ID and number, locale, hypothesis, metric and proposed changes');
  }
  const prior = new Set();
  const changes = input.changes.map(({ field, before, after, observedAt }) => {
    if (!Object.hasOwn(LISTING_LIMITS, field) || prior.has(field) || typeof before !== 'string' ||
      typeof after !== 'string' || !after.trim() || before === after || [...after].length > LISTING_LIMITS[field] ||
      typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))) {
      throw new Error('Use unique supported fields with recent observed values and valid replacement lengths');
    }
    prior.add(field);
    return { field, before, after, observedAt };
  });
  const draft = { status: 'draft', appId: scan.app.id, version: target.version, versionId: target.id,
    observedVersionState: target.state, locale: input.locale, hypothesis: input.hypothesis, metric: input.metric,
    changes, nextCheck: 'Re-read the exact fields in the authenticated browser and verify which fields Apple lets you edit in this state before seeking approval.' };
  writeJson(join(dir, 'store-draft.json'), draft);
  return draft;
}
