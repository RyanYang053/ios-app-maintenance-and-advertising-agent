// Agent-authored promotional video. The agent decides the concept, beats, layouts, motion,
// media and copy (guided by the OpenDesign design-brief, motion-design and video-hyperframes
// skills). This module enforces truthfulness and safety rules, composes a HyperFrames project,
// gates it with `hyperframes check`, renders it and returns review frames. It never posts.
import { copyFileSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertEvidenceApp } from './app-context.mjs';
import { jsonCommand, run, writeJson } from './io.mjs';

export const HYPERFRAMES = 'hyperframes@0.9.95';
export const VIDEO_FORMATS = { '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350], '16:9': [1920, 1080] };
export const LAYOUTS = ['title', 'device', 'split', 'full-bleed', 'list', 'quote', 'cta'];
export const MOTIONS = ['rise', 'slide', 'zoom', 'pop', 'blur', 'type', 'none'];
export const FONTS = ['Inter', 'Montserrat', 'Outfit', 'Nunito', 'Oswald', 'League Gothic', 'Archivo Black', 'Space Mono',
  'IBM Plex Mono', 'JetBrains Mono', 'EB Garamond', 'Playfair Display', 'Source Code Pro', 'Noto Sans JP', 'Roboto',
  'Open Sans', 'Lato', 'Poppins'];
export const CLAIM_KINDS = ['source', 'capture', 'store-listing', 'review', 'metric', 'owner'];
const SOCIAL = ['tiktok', 'instagram', 'youtube', 'x', 'reddit', 'linkedin', 'apple-ads'];
const MEDIA = { image: ['.png', '.jpg', '.jpeg', '.webp'], video: ['.mp4', '.mov', '.webm'], audio: ['.mp3', '.wav', '.m4a', '.aac'] };
const NEEDS_MEDIA = ['device', 'split', 'full-bleed'];
const RISKY = /\d|%|#1|\b(best|fastest|only|first|free|guaranteed|never|always|instant(ly)?|unlimited|no\.? ?1)\b|免费|第一|最|唯一|保证/i;

const text = (x, n) => typeof x === 'string' && x.trim().length > 0 && x.length <= n;
const num = (x, lo, hi) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
const hex = (x) => typeof x === 'string' && /^#[0-9a-f]{6}$/i.test(x);
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const round = (x) => Math.round(x * 1000) / 1000;

function luminance(color) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
export function mediaKind(asset) {
  const ext = extname(asset).toLowerCase();
  return Object.keys(MEDIA).find((kind) => MEDIA[kind].includes(ext)) ?? null;
}
const assetName = (x) => typeof x === 'string' && /^[\w][\w./ -]{0,199}$/.test(x) && !x.split(/[\\/]/).includes('..') && !isAbsolute(x);

// Returns a normalized storyboard with timing, or throws one message listing every problem.
export function validateStoryboard(sb, { id, scan, release }) {
  assertEvidenceApp(id, sb);
  const problems = [];
  const need = (ok, message) => { if (!ok) problems.push(message); };
  need(scan?.app?.id === id && scan.store?.status === 'ok' && scan.store.data?.live?.version === sb.verifiedVersion,
    'verifiedVersion must equal the live App Store version in the latest scan');
  need(release?.sha && release.sha === sb.listingSha,
    'listingSha must equal the shipped commit (Git tag or release-confirm record)' + (release?.sha ? ': ' + release.sha : '; none recorded yet'));
  const c = sb.concept ?? {};
  need(text(c.audience, 200) && text(c.insight, 300) && text(c.angle, 200), 'concept needs audience, insight and angle');
  need(Array.isArray(c.platforms) && c.platforms.length > 0 && c.platforms.every((p) => SOCIAL.includes(p)),
    'concept.platforms must list target channels from: ' + SOCIAL.join(', '));
  const od = c.openDesign ?? {};
  need(text(od.designBrief, 3000) && text(od.beatMap, 3000) && Array.isArray(od.references) &&
    ['design-brief', 'motion-design'].every((name) => od.references.includes(name)),
  'concept.openDesign needs designBrief (from the design-brief skill), beatMap (from motion-design) and references including design-brief and motion-design');
  need(Object.hasOwn(VIDEO_FORMATS, sb.format), 'format must be one of ' + Object.keys(VIDEO_FORMATS).join(', '));
  const t = sb.theme ?? {};
  const colors = ['background', 'surface', 'text', 'accent'];
  need(colors.every((k) => hex(t[k])), 'theme needs hex colors background, surface, text, accent (#rrggbb)');
  need(FONTS.includes(t.headingFont ?? 'Inter') && FONTS.includes(t.bodyFont ?? 'Inter'), 'theme fonts must be bundled HyperFrames fonts: ' + FONTS.join(', '));
  if (colors.every((k) => hex(t[k]))) {
    for (const [fg, bg] of [['text', 'background'], ['text', 'surface'], ['background', 'accent']]) {
      const ratio = contrast(t[fg], t[bg]);
      need(ratio >= 4.5, 'theme.' + fg + ' on theme.' + bg + ' contrast is ' + ratio.toFixed(2) + ':1; WCAG AA needs 4.5:1');
    }
  }
  const claims = new Map();
  if (!Array.isArray(sb.claims) || sb.claims.length > 30) problems.push('claims must be an array (up to 30)');
  for (const claim of Array.isArray(sb.claims) ? sb.claims : []) {
    const ok = /^[a-z0-9-]{1,32}$/.test(claim?.id ?? '') && !claims.has(claim.id) && text(claim.text, 300) &&
      text(claim.evidence, 1000) && CLAIM_KINDS.includes(claim.kind);
    need(ok, 'claim ' + (claim?.id ?? '?') + ' needs a unique id, text, evidence and kind (' + CLAIM_KINDS.join(', ') + ')');
    if (ok) claims.set(claim.id, claim);
  }
  const scenes = Array.isArray(sb.scenes) ? sb.scenes : [];
  need(scenes.length >= 2 && scenes.length <= 12, 'use 2-12 scenes');
  let start = 0;
  const ids = new Set();
  const normalized = scenes.map((scene, index) => {
    const label = 'scene ' + (scene?.id ?? index + 1);
    const s = scene ?? {};
    need(/^[a-z0-9-]{1,32}$/.test(s.id ?? '') && !ids.has(s.id), label + ': id must be unique lowercase-dashed');
    ids.add(s.id);
    need(LAYOUTS.includes(s.layout), label + ': layout must be one of ' + LAYOUTS.join(', '));
    need(MOTIONS.includes(s.motion ?? 'rise'), label + ': motion must be one of ' + MOTIONS.join(', '));
    need(num(s.duration, 1.2, 10), label + ': duration must be 1.2-10 seconds');
    need(text(s.headline, 90), label + ': headline is required (max 90 characters)');
    need(s.body === undefined || text(s.body, 160), label + ': body max 160 characters');
    if (s.layout === 'list') need(Array.isArray(s.items) && s.items.length >= 2 && s.items.length <= 4 && s.items.every((x) => text(x, 60)),
      label + ': list layout needs 2-4 items of up to 60 characters');
    if (s.layout === 'quote') need(text(s.quote, 200) && text(s.attribution, 60), label + ': quote layout needs quote and attribution (no reviewer names or handles)');
    if (s.layout === 'cta') need(text(s.button, 40), label + ': cta layout needs button text');
    const media = s.media;
    if (NEEDS_MEDIA.includes(s.layout)) need(media, label + ': ' + s.layout + ' layout needs media from stateDir/assets/' + id);
    if (media !== undefined) {
      const kind = assetName(media?.asset) ? mediaKind(media.asset) : null;
      need(kind === 'image' || kind === 'video', label + ': media.asset must be an image (' + MEDIA.image.join(' ') + ') or screen recording (' + MEDIA.video.join(' ') + ') path inside assets/' + id);
      need(media?.mediaStart === undefined || (kind === 'video' && num(media.mediaStart, 0, 3600)), label + ': mediaStart applies to video only');
      need(media?.fit === undefined || ['contain', 'cover'].includes(media.fit), label + ': media.fit is contain or cover');
    }
    const cited = Array.isArray(s.claimIds) ? s.claimIds : [];
    need(cited.every((cid) => claims.has(cid)), label + ': claimIds must reference declared claims');
    const words = [s.headline, s.body, ...(s.items ?? []), s.quote].filter((x) => typeof x === 'string').join(' ');
    if (!['title', 'cta'].includes(s.layout) || RISKY.test(words)) {
      need(cited.length > 0, label + ': cite at least one claimId (feature, number, comparison or superlative copy needs evidence)');
    }
    if (s.layout === 'quote') need(cited.some((cid) => claims.get(cid)?.kind === 'review'), label + ': quote must cite a review claim');
    const row = { ...s, motion: s.motion ?? 'rise', claimIds: cited, start: round(start), end: round(start + (num(s.duration, 0, 99) ? s.duration : 0)) };
    start = row.end;
    return row;
  });
  const total = round(start);
  need(total >= 6 && total <= 60, 'total duration must be 6-60 seconds (now ' + total + ')');
  need(normalized.at(-1)?.layout === 'cta', 'the last scene must use the cta layout');
  const captions = sb.captions ?? [];
  need(Array.isArray(captions) && captions.length <= 60 && captions.every((cap, i) => num(cap?.start, 0, 60) && num(cap?.end, 0, 60) &&
    cap.end - cap.start >= 0.8 && cap.end <= total + 1e-9 && text(cap.text, 90) && (i === 0 || cap.start >= captions[i - 1].end - 1e-9)),
  'captions need ordered, non-overlapping {start, end, text<=90}, each at least 0.8 s and inside the video');
  const audio = sb.audio ?? {};
  for (const key of ['music', 'voiceover']) {
    const track = audio[key];
    if (track === undefined) continue;
    need(assetName(track?.asset) && mediaKind(track.asset) === 'audio' && text(track.license, 300) &&
      (track.volume === undefined || num(track.volume, 0, 1)),
    'audio.' + key + ' needs an audio asset (' + MEDIA.audio.join(' ') + ') in assets/' + id + ', license/source and optional volume 0-1');
  }
  if (audio.voiceover) need(captions.length > 0, 'a voiceover needs burned-in captions for viewers watching without sound');
  need(sb.disclosure === undefined || text(sb.disclosure, 80), 'disclosure max 80 characters');
  if (problems.length) throw new Error('Storyboard needs revision:\n- ' + problems.join('\n- '));
  return { ...sb, theme: { headingFont: 'Inter', bodyFont: 'Inter', ...t }, scenes: normalized, captions, audio, totalDuration: total,
    size: VIDEO_FORMATS[sb.format] };
}

export function storyboardAssets(sb) {
  return [...new Set([...sb.scenes.flatMap((s) => (s.media ? [s.media.asset] : [])),
    ...['music', 'voiceover'].flatMap((k) => (sb.audio?.[k] ? [sb.audio[k].asset] : []))])];
}

// Geometry per layout and orientation, as fractions of the canvas.
function regions(layout, W, H, captions) {
  const portrait = W / H <= 1.05;
  const reserve = (captions ? 0.13 : 0.05) * H;
  const box = (l, t, w, h) => ({ left: Math.round(l), top: Math.round(t), width: Math.round(w), height: Math.round(Math.max(h, 40)) });
  const full = box(0.07 * W, 0.12 * H, 0.86 * W, H - 0.12 * H - reserve);
  if (portrait) {
    if (layout === 'device') return { text: box(0.07 * W, 0.1 * H, 0.86 * W, 0.26 * H), media: box(0.18 * W, 0.38 * H, 0.64 * W, H - 0.4 * H - reserve) };
    if (layout === 'split') return { media: box(0.06 * W, 0.1 * H, 0.88 * W, 0.5 * H), text: box(0.07 * W, 0.63 * H, 0.86 * W, H - 0.64 * H - reserve) };
    if (layout === 'full-bleed') return { media: box(0, 0, W, H), text: box(0.06 * W, H - reserve - 0.3 * H, 0.88 * W, 0.28 * H), panel: true };
    if (layout === 'cta') return { text: box(0.07 * W, 0.36 * H, 0.86 * W, H - 0.38 * H - reserve), icon: box(0.5 * W - 0.11 * Math.min(W, H), 0.13 * H, 0.22 * Math.min(W, H), 0.22 * Math.min(W, H)) };
    return { text: full };
  }
  if (layout === 'device') return { text: box(0.07 * W, 0.14 * H, 0.45 * W, 0.8 * H - reserve), media: box(0.57 * W, 0.08 * H, 0.36 * W, 0.88 * H - reserve) };
  if (layout === 'split') return { media: box(0.05 * W, 0.1 * H, 0.5 * W, 0.86 * H - reserve), text: box(0.6 * W, 0.14 * H, 0.35 * W, 0.8 * H - reserve) };
  if (layout === 'full-bleed') return { media: box(0, 0, W, H), text: box(0.05 * W, H - reserve - 0.36 * H, 0.56 * W, 0.33 * H), panel: true };
  if (layout === 'cta') return { text: box(0.3 * W, 0.42 * H, 0.4 * W, H - 0.44 * H - reserve), icon: box(0.5 * W - 0.09 * H, 0.12 * H, 0.18 * H, 0.18 * H) };
  return { text: full };
}

const px = (b) => 'left:' + b.left + 'px;top:' + b.top + 'px;width:' + b.width + 'px;height:' + b.height + 'px';

function entrance(motion, first) {
  const o = first ? 1 : 0;
  return {
    rise: [{ opacity: o, y: 50 }, { opacity: 1, y: 0, duration: 0.55, ease: 'power3.out' }],
    slide: [{ opacity: o, x: -80 }, { opacity: 1, x: 0, duration: 0.6, ease: 'power3.out' }],
    zoom: [{ opacity: o, scale: 0.9 }, { opacity: 1, scale: 1, duration: 0.6, ease: 'power2.out' }],
    pop: [{ opacity: o, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.5, ease: 'back.out(1.7)' }],
    blur: [{ opacity: o, filter: 'blur(14px)' }, { opacity: 1, filter: 'blur(0px)', duration: 0.6, ease: 'power2.out' }],
    type: [{ opacity: 1, clipPath: first ? 'inset(0 0% 0 0)' : 'inset(0 100% 0 0)' }, { opacity: 1, clipPath: 'inset(0 0% 0 0)', duration: 0.9, ease: 'power1.inOut' }],
    none: [{ opacity: o }, { opacity: 1, duration: 0.35, ease: 'none' }],
  }[motion];
}

// assets maps original asset names to project-relative paths (assets/...).
export function composeHtml(sb, appName, assets) {
  const [W, H] = sb.size;
  const s = Math.min(W, H) / 100;
  const th = sb.theme;
  const hasCaptions = sb.captions.length > 0;
  const fit = (h) => (h.length > 60 ? 0.72 : h.length > 40 ? 0.85 : 1);
  const media = [];
  const scenes = [];
  const tl = [];
  sb.scenes.forEach((scene, i) => {
    const r = regions(scene.layout, W, H, hasCaptions);
    const at = scene.start;
    const id = scene.id;
    const big = ['title', 'cta', 'quote'].includes(scene.layout) ? 9 : 7.4;
    if (scene.media) {
      const kind = mediaKind(scene.media.asset);
      const src = esc(assets[scene.media.asset]);
      const box = scene.layout === 'cta' ? r.icon : r.media;
      const objectFit = scene.media.fit ?? (scene.layout === 'full-bleed' ? 'cover' : 'contain');
      const radius = scene.layout === 'full-bleed' ? 0 : scene.layout === 'cta' ? 4.5 * s : 3.6 * s;
      const timing = 'data-start="' + at + '" data-duration="' + scene.duration + '" data-track-index="0"';
      const tag = kind === 'video' ?
        '<video id="m-' + id + '" class="clip media" ' + timing + (scene.media.mediaStart ? ' data-media-start="' + scene.media.mediaStart + '"' : '') +
          ' muted playsinline src="' + src + '" style="object-fit:' + objectFit + '"></video>' :
        '<img id="m-' + id + '" class="clip media" ' + timing + ' src="' + src + '" alt="" style="object-fit:' + objectFit + '">';
      media.push('<div class="mwrap" id="mw-' + id + '" style="' + px(box) + ';border-radius:' + radius + 'px"><div class="mframe" id="mf-' + id + '">' + tag + '</div></div>');
      tl.push("tl.fromTo('#mw-" + id + "'," + JSON.stringify({ opacity: i === 0 ? 1 : 0, y: 40 }) + ',' +
        JSON.stringify({ opacity: 1, y: 0, duration: 0.6, ease: 'power2.out' }) + ',' + at + ');');
      tl.push("tl.fromTo('#mf-" + id + "',{scale:1},{scale:1.04,duration:" + scene.duration + ",ease:'none'}," + at + ');');
      if (i < sb.scenes.length - 1) tl.push("tl.to('#mw-" + id + "',{opacity:0,duration:0.25}," + round(scene.end - 0.3) + ');');
    }
    const parts = [];
    if (scene.layout === 'quote') {
      parts.push('<p class="quote" style="font-size:' + round(6 * s * fit(scene.quote)) + 'px">“' + esc(scene.quote) + '”</p>');
      parts.push('<p class="attr">' + esc(scene.attribution) + '</p>');
      parts.push('<h2 class="small-head">' + esc(scene.headline) + '</h2>');
    } else {
      parts.push('<h1 style="font-size:' + round(big * s * fit(scene.headline)) + 'px">' + esc(scene.headline) + '</h1>');
      if (scene.body) parts.push('<p class="body">' + esc(scene.body) + '</p>');
      if (scene.layout === 'list') parts.push('<ul>' + scene.items.map((x) => '<li><span class="dot"></span>' + esc(x) + '</li>').join('') + '</ul>');
      if (scene.layout === 'cta') {
        parts.push('<div class="button">' + esc(scene.button) + '</div>');
        parts.push('<p class="store">' + esc(appName) + ' · App Store</p>');
        if (sb.disclosure) parts.push('<p class="disclosure">' + esc(sb.disclosure) + '</p>');
      }
    }
    const align = ['title', 'cta', 'quote'].includes(scene.layout) ? ' center' : '';
    scenes.push('<section id="s-' + id + '" class="clip scene l-' + scene.layout + '" data-start="' + at + '" data-duration="' +
      scene.duration + '" data-track-index="1"><div class="inner' + align + (r.panel ? ' panel' : '') + '" id="in-' + id + '" style="' + px(r.text) + '">' +
      parts.join('') + '</div></section>');
    const [from, to] = entrance(scene.motion, i === 0);
    tl.push("tl.fromTo('#in-" + id + " > *'," + JSON.stringify(from) + ',' + JSON.stringify({ ...to, stagger: 0.09 }) + ',' + at + ');');
    if (scene.layout === 'list') {
      tl.push("tl.fromTo('#in-" + id + " li',{opacity:" + (i === 0 ? 1 : 0) + ",x:-40},{opacity:1,x:0,duration:0.45,stagger:" +
        round(Math.min(0.6, (scene.duration - 1) / scene.items.length)) + ",ease:'power2.out'}," + round(at + 0.35) + ');');
    }
    if (scene.layout === 'cta') tl.push("tl.fromTo('#in-" + id + " .button',{scale:1},{scale:1.06,duration:0.5,yoyo:true,repeat:" +
      Math.max(1, Math.floor((scene.duration - 1) / 0.5)) + ",ease:'sine.inOut'}," + round(at + 0.8) + ');');
    if (i < sb.scenes.length - 1) tl.push("tl.to('#in-" + id + "',{opacity:0,duration:0.25}," + round(scene.end - 0.3) + ');');
  });
  const captions = sb.captions.map((cap, i) => '<div id="cap-' + i + '" class="clip cap" data-start="' + cap.start + '" data-duration="' +
    round(cap.end - cap.start) + '" data-track-index="2"><span>' + esc(cap.text) + '</span></div>');
  const voice = sb.audio.voiceover;
  const music = sb.audio.music;
  const audio = [];
  if (voice) audio.push('<audio id="voiceover" class="clip" src="' + esc(assets[voice.asset]) + '" data-start="0" data-volume="' + (voice.volume ?? 1) + '" data-track-index="3"></audio>');
  if (music) audio.push('<audio id="music" class="clip" src="' + esc(assets[music.asset]) + '" data-start="0" data-duration="' + sb.totalDuration +
    '" data-volume="' + (music.volume ?? (voice ? 0.18 : 0.5)) + '" data-fade-in="0.5" data-fade-out="1.2" data-track-index="4"></audio>');
  const css = `*{box-sizing:border-box;margin:0}
html,body{width:${W}px;height:${H}px;background:${th.background};overflow:hidden}
#promo{position:relative;width:${W}px;height:${H}px;overflow:hidden;font-family:'${th.bodyFont}',sans-serif;color:${th.text}}
.bg{position:absolute;inset:0;background:radial-gradient(ellipse at 80% 85%,${th.surface} 0%,${th.background} 70%)}
.brand{position:absolute;left:${round(0.06 * W)}px;top:${round(0.035 * H)}px;padding:${round(0.9 * s)}px ${round(2 * s)}px;border-radius:${round(3 * s)}px;background:${th.surface};color:${th.text};font:700 ${round(3.1 * s)}px '${th.headingFont}',sans-serif;z-index:9}
.mwrap{position:absolute;overflow:hidden;background:${th.surface};box-shadow:0 ${round(2 * s)}px ${round(6 * s)}px rgba(0,0,0,.35);z-index:1}
.mframe{position:absolute;inset:0}
.media{position:absolute;left:0;top:0;width:100%;height:100%}
.scene{position:absolute;inset:0;z-index:3}
.inner{position:absolute;display:flex;flex-direction:column;justify-content:center;gap:${round(2.2 * s)}px}
.inner.center{align-items:center;text-align:center}
.inner.panel{background:${th.surface};border-radius:${round(3 * s)}px;padding:${round(3.4 * s)}px}
h1{font-family:'${th.headingFont}',sans-serif;font-weight:800;line-height:1.04;letter-spacing:-.02em;overflow-wrap:anywhere}
.small-head{font-family:'${th.headingFont}',sans-serif;font-size:${round(4.2 * s)}px;color:${th.text}}
.body{font-size:${round(3.9 * s)}px;line-height:1.25;overflow-wrap:anywhere}
.quote{font-family:'${th.headingFont}',sans-serif;line-height:1.15}
.attr{font-size:${round(3.4 * s)}px}
ul{list-style:none;padding:0;display:flex;flex-direction:column;gap:${round(1.8 * s)}px}
li{display:flex;align-items:center;gap:${round(2 * s)}px;font-size:${round(4.4 * s)}px;line-height:1.2}
.dot{flex:none;width:${round(2.2 * s)}px;height:${round(2.2 * s)}px;border-radius:50%;background:${th.accent}}
.button{padding:${round(2.2 * s)}px ${round(5 * s)}px;border-radius:${round(6 * s)}px;background:${th.accent};color:${th.background};font:800 ${round(4.6 * s)}px '${th.headingFont}',sans-serif}
.store{font-size:${round(3.3 * s)}px}
.disclosure{font-size:${round(2.8 * s)}px}
.cap{position:absolute;left:${round(0.06 * W)}px;right:${round(0.06 * W)}px;bottom:${round(0.035 * H)}px;display:flex;justify-content:center;z-index:8}
.cap span{background:${th.surface};color:${th.text};padding:${round(1 * s)}px ${round(2.2 * s)}px;border-radius:${round(1.6 * s)}px;font:700 ${round(3.8 * s)}px '${th.bodyFont}',sans-serif;text-align:center}`;
  const html = `<!doctype html>
<html lang="${esc(sb.locale ?? 'en')}"><head><meta charset="utf-8"><script src="assets/gsap.min.js"></script><style>
${css}
</style></head><body>
<main id="promo" data-composition-id="promo" data-start="0" data-duration="${sb.totalDuration}" data-width="${W}" data-height="${H}">
<div class="bg"></div>
<div class="brand">${esc(appName)}</div>
${media.join('\n')}
${scenes.join('\n')}
${captions.join('\n')}
${audio.join('\n')}
</main>
<script>
const tl = gsap.timeline({paused:true});
${tl.join('\n')}
window.__timelines = window.__timelines || {};
window.__timelines["promo"] = tl;
</script></body></html>`;
  return { html, width: W, height: H, duration: sb.totalDuration };
}

function insideDir(base, name) {
  const root = realpathSync(base);
  const dest = realpathSync(resolve(root, name));
  const rel = relative(root, dest);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Asset ' + name + ' must be inside the app assets folder');
  return dest;
}

export function resolveAssets(sb, assetRoot) {
  return storyboardAssets(sb).map((name) => {
    let path;
    try { path = insideDir(assetRoot, name); } catch (error) {
      throw new Error(error.code === 'ENOENT' ? 'Asset not found in the app assets folder: ' + name : error.message);
    }
    const info = statSync(path);
    if (!info.isFile() || info.size > 300_000_000) throw new Error('Asset must be a file up to 300 MB: ' + name);
    return { name, path, kind: mediaKind(name) };
  });
}

function probeDuration(path) {
  const out = jsonCommand('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path]);
  return Number(out.format?.duration);
}

function hyperframes(args, options = {}) {
  const env = { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', CI: '1' };
  return spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', HYPERFRAMES, ...args],
    { encoding: 'utf8', env, timeout: options.timeout ?? 300_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Flattens the hyperframes check JSON envelope into findings the agent can act on.
export function summarizeCheck(report) {
  const findings = [];
  const walk = (value, section) => {
    if (Array.isArray(value)) return value.forEach((v) => walk(v, section));
    if (!value || typeof value !== 'object') return;
    const severity = value.severity ?? value.level;
    const message = value.message ?? value.msg;
    if (typeof severity === 'string' && typeof message === 'string') {
      findings.push({ section, severity: severity.toLowerCase(), rule: value.rule ?? value.code ?? value.id ?? null, message: message.slice(0, 400),
        selector: value.selector ?? value.target?.selector ?? null, time: value.time ?? value.sampleTime ?? value.at ?? null });
      return;
    }
    for (const [key, child] of Object.entries(value)) if (key !== 'snapshots') walk(child, section ?? key);
  };
  walk(report, null);
  const unique = [...new Map(findings.map((f) => [JSON.stringify([f.section, f.rule, f.message, f.selector]), f])).values()];
  return { ok: report?.ok === true, browserSkipped: report?.browserSkipped === true,
    errors: unique.filter((f) => f.severity === 'error').slice(0, 40), warnings: unique.filter((f) => f.severity === 'warning').slice(0, 40) };
}

function parseJson(stdout) {
  const startAt = stdout.indexOf('{');
  if (startAt < 0) return null;
  try { return JSON.parse(stdout.slice(startAt)); } catch { return null; }
}

export function renderStoryboard(sb, appName, assetRoot, outDir) {
  const assets = resolveAssets(sb, assetRoot);
  const map = {};
  mkdirSync(join(outDir, 'assets'), { recursive: true, mode: 0o700 });
  assets.forEach((asset, i) => {
    const target = 'assets/' + i + '-' + basename(asset.name).replace(/[^\w.-]/g, '_');
    copyFileSync(asset.path, join(outDir, target));
    map[asset.name] = target;
  });
  const timing = [];
  for (const scene of sb.scenes.filter((s) => s.media && mediaKind(s.media.asset) === 'video')) {
    const length = probeDuration(assets.find((a) => a.name === scene.media.asset).path);
    if (!(length + 0.05 >= (scene.media.mediaStart ?? 0) + scene.duration)) {
      timing.push('scene ' + scene.id + ': recording is ' + round(length) + ' s but needs ' + round((scene.media.mediaStart ?? 0) + scene.duration) + ' s from mediaStart');
    }
  }
  if (timing.length) throw new Error('Storyboard needs revision:\n- ' + timing.join('\n- '));
  copyFileSync(createRequire(import.meta.url).resolve('gsap/dist/gsap.min.js'), join(outDir, 'assets', 'gsap.min.js'));
  const composed = composeHtml(sb, appName, map);
  writeFileSync(join(outDir, 'index.html'), composed.html, { mode: 0o600 });
  writeJson(join(outDir, 'storyboard.json'), sb);

  const checked = hyperframes(['check', outDir, '--json'], { timeout: 300_000 });
  const report = parseJson(checked.stdout ?? '');
  if (!report) {
    return { status: 'blocked', project: outDir, reason: 'hyperframes check did not return a report; run `npx ' + HYPERFRAMES + ' doctor` on this machine',
      exitCode: checked.status };
  }
  writeJson(join(outDir, 'check.json'), report);
  const audit = summarizeCheck(report);
  if (audit.errors.length) {
    return { status: 'needs-revision', project: outDir, checkReport: join(outDir, 'check.json'), errors: audit.errors, warnings: audit.warnings,
      next: 'Revise the storyboard (shorter copy, different layout, timing or colors), save it with storyboard, and render again. Nothing was rendered.' };
  }

  const output = join(outDir, 'promo.mp4');
  const rendered = hyperframes(['render', outDir, '--output', output, '--fps', '30', '--quality', 'standard', '--workers', '1'], { timeout: 900_000 });
  if (rendered.status !== 0) return { status: 'blocked', project: outDir, reason: 'hyperframes render failed (exit ' + rendered.status + ')' };
  const probe = jsonCommand('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', output]);
  const video = probe.streams?.find((x) => x.codec_type === 'video');
  const hasAudio = probe.streams?.some((x) => x.codec_type === 'audio');
  const duration = Number(probe.format?.duration);
  const wantsAudio = Boolean(sb.audio.music || sb.audio.voiceover);
  if (video?.width !== composed.width || video.height !== composed.height || Math.abs(duration - composed.duration) > 0.2 || (wantsAudio && !hasAudio)) {
    return { status: 'failed-validation', project: outDir, output, observed: { width: video?.width, height: video?.height, duration, hasAudio } };
  }
  mkdirSync(join(outDir, 'review'), { recursive: true });
  const frames = sb.scenes.map((scene) => {
    const frame = join(outDir, 'review', scene.id + '.png');
    run('ffmpeg', ['-v', 'error', '-y', '-ss', String(round(scene.start + Math.min(scene.duration * 0.6, scene.duration - 0.35))), '-i', output,
      '-frames:v', '1', '-vf', 'scale=' + Math.round(composed.width / 2) + ':-2', frame], { timeout: 60_000 });
    return { scene: scene.id, layout: scene.layout, at: round(scene.start + scene.duration * 0.6), frame };
  });
  const manifest = { state: 'draft', appId: sb.appId, version: sb.verifiedVersion, listingSha: sb.listingSha, format: sb.format,
    output, width: video.width, height: video.height, duration, hasAudio, platforms: sb.concept.platforms,
    claims: sb.claims, warnings: audit.warnings, auditSkipped: audit.browserSkipped, reviewFrames: frames,
    next: 'Open every review frame and the MP4 yourself. Revise if text is cut, hard to read, off-message or unproven. Then show the final preview to the owner for approval before posting.' };
  writeJson(join(outDir, 'manifest.json'), manifest);
  return { status: 'rendered', ...manifest };
}

