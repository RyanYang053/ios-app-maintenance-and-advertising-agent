import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateStoryboard, composeHtml, summarizeCheck, contrast, resolveAssets, renderStoryboard } from '../src/storyboard.mjs';
import { schemas } from '../src/schemas.mjs';
import { run } from '../src/io.mjs';

const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const scan = { app: { id: '123', name: 'Rep Count' }, store: { status: 'ok', data: { live: { version: '1.2.0' } } } };
const release = { sha: SHA };
const board = () => {
  const sb = structuredClone(schemas.storyboard.example);
  sb.appId = '123';
  sb.scenes[3].media = { asset: 'icon.png' };
  delete sb.audio;
  return sb;
};

test('storyboard accepts an evidenced agent concept and computes the timeline', () => {
  const sb = validateStoryboard(board(), { id: '123', scan, release });
  assert.equal(sb.totalDuration, 13.5);
  assert.deepEqual(sb.size, [1080, 1920]);
  assert.deepEqual(sb.scenes.map((s) => [s.id, s.start, s.end]), [['hook', 0, 2.5], ['demo', 2.5, 7], ['proof', 7, 10.5], ['cta', 10.5, 13.5]]);
});

test('storyboard rejects unproven claims, missing OpenDesign work, bad contrast and wrong provenance in one message', () => {
  const sb = board();
  sb.listingSha = 'f'.repeat(40);
  sb.concept.openDesign.references = ['video-hyperframes'];
  sb.theme.text = '#203530';
  sb.scenes[0].headline = 'The #1 rep counter';
  sb.scenes[1].claimIds = [];
  sb.scenes.pop();
  assert.throws(() => validateStoryboard(sb, { id: '123', scan, release }), (e) =>
    ['listingSha', 'openDesign', 'contrast', 'scene hook: cite', 'scene demo: cite', 'last scene'].every((part) => e.message.includes(part)));
});

test('storyboard blocks quotes without a review claim, voiceover without captions and paths outside assets', () => {
  const sb = board();
  sb.scenes.splice(2, 0, { id: 'quote', layout: 'quote', duration: 3, headline: 'Lifters say', quote: 'Finally I can focus', attribution: 'App Store review', claimIds: ['auto-count'] });
  sb.audio = { voiceover: { asset: '../secret.mp3', license: 'owner recording' } };
  sb.captions = [];
  assert.throws(() => validateStoryboard(sb, { id: '123', scan, release }), (e) =>
    /quote must cite a review claim/.test(e.message) && /voiceover needs burned-in captions/.test(e.message) && /audio.voiceover needs/.test(e.message));
});

test('composed HyperFrames project times media outside scenes, escapes copy and registers the timeline', () => {
  const sb = board();
  sb.scenes[0].headline = 'Lost count <again>?';
  sb.captions = [{ start: 0.2, end: 2.4, text: 'Lost & found' }];
  sb.audio = { music: { asset: 'track.mp3', license: 'licensed' } };
  const checked = validateStoryboard(sb, { id: '123', scan, release });
  const { html, width, height, duration } = composeHtml(checked, 'Rep Count', { 'rep-demo.mp4': 'assets/0-rep-demo.mp4', 'icon.png': 'assets/1-icon.png', 'track.mp3': 'assets/2-track.mp3' });
  assert.deepEqual([width, height, duration], [1080, 1920, 13.5]);
  assert.match(html, /data-composition-id="promo" data-start="0" data-duration="13.5" data-width="1080" data-height="1920"/);
  assert.match(html, /<video id="m-demo" class="clip media" data-start="2.5" data-duration="4.5" data-track-index="0" muted playsinline/);
  assert.match(html, /Lost count &lt;again&gt;\?/);
  assert.match(html, /Lost &amp; found/);
  assert.match(html, /<audio id="music" class="clip" src="assets\/2-track.mp3" data-start="0" data-duration="13.5" data-volume="0.5"/);
  assert.match(html, /window.__timelines\["promo"\] = tl/);
  assert.doesNotMatch(html, /<section[^>]*>\s*<video/);
});

test('check summaries surface errors and warnings for the agent', () => {
  const summary = summarizeCheck({ ok: false, lint: { findings: [{ severity: 'error', rule: 'clip_ends_past_root_duration', message: 'Raise duration' }] },
    layout: [{ severity: 'warning', code: 'text_overflow', message: 'Headline overflows', selector: '#in-demo h1', time: 3 }] });
  assert.equal(summary.ok, false);
  assert.equal(summary.errors[0].rule, 'clip_ends_past_root_duration');
  assert.equal(summary.warnings[0].selector, '#in-demo h1');
  assert.ok(contrast('#ffffff', '#000000') > 20);
});

test('assets resolve only inside the app folder', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-assets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '123'));
  writeFileSync(join(dir, '123', 'rep-demo.mp4'), 'x');
  writeFileSync(join(dir, 'icon.png'), 'outside');
  const checked = validateStoryboard(board(), { id: '123', scan, release });
  assert.throws(() => resolveAssets(checked, join(dir, '123')), /Asset not found in the app assets folder: icon.png/);
});

// Real HyperFrames check + render. Needs Chrome, FFmpeg, network for npx and installed gsap.
test('storyboard renders through HyperFrames check into a verified MP4 with review frames', { skip: process.env.RUN_VIDEO_SMOKE !== '1', timeout: 1_200_000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-render-'));
  if (process.env.KEEP_VIDEO_SMOKE !== '1') t.after(() => rmSync(dir, { recursive: true, force: true }));
  const assets = join(dir, 'assets');
  mkdirSync(assets);
  run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=720x1560:rate=30', '-t', '6', '-pix_fmt', 'yuv420p', join(assets, 'rep-demo.mp4')]);
  run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xc6f876:size=512x512', '-frames:v', '1', join(assets, 'icon.png')]);
  run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=14', '-ac', '2', join(assets, 'track.mp3')]);
  const sb = board();
  sb.audio = { music: { asset: 'track.mp3', license: 'generated test tone' } };
  const checked = validateStoryboard(sb, { id: '123', scan, release });
  const result = renderStoryboard(checked, 'Rep Count', assets, join(dir, 'out'));
  if (result.status !== 'rendered') console.log(JSON.stringify(result, null, 2));
  assert.equal(result.status, 'rendered');
  assert.deepEqual([result.width, result.height, result.hasAudio], [1080, 1920, true]);
  assert.equal(result.reviewFrames.length, 4);
  assert.ok(result.reviewFrames.every((f) => existsSync(f.frame)));
  if (process.env.KEEP_VIDEO_SMOKE === '1') console.log('kept', dir);
});
