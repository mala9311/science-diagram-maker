import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSvg, allPassed, extractSvg } from '../src/validate.js';
import { generateDiagram } from '../src/generate.js';
import { callGemini, ApiError } from '../src/gemini.js';
import { CONCEPTS } from '../src/concepts.js';

const GOOD = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500"><title>Test</title>
<rect x="0" y="0" width="800" height="500" fill="#fff"/>
<circle cx="400" cy="250" r="100"><animate attributeName="r" values="90;110;90" dur="2s" repeatCount="indefinite"/></circle>
<path d="M 50 50 L 750 50 L 750 450 Z" fill="none" stroke="#000"/>
<text x="10" y="30">a</text><text x="10" y="60">b</text><text x="10" y="90">c</text></svg>`;
const byName = (checks, n) => checks.find((c) => c.name === n);

test('good svg passes all 5 checks', () => {
  const r = validateSvg(GOOD);
  assert.ok(allPassed(r), JSON.stringify(r.filter((c) => !c.passed)));
  assert.equal(r.length, 5);
});

test('extracts svg from fenced, chatty reply', () => {
  assert.ok(allPassed(validateSvg('Sure!\n```svg\n' + GOOD + '\n```\nHope it helps')));
  assert.ok(extractSvg('```xml\n' + GOOD + '\n```').startsWith('<svg'));
});

test('unparseable / truncated svg fails parse and marks the rest skipped', () => {
  const r = validateSvg(GOOD.replace('</svg>', '').replace('<title>Test</title>', '<title>Test'));
  assert.equal(byName(r, 'parses').passed, false);
  assert.equal(r.filter((c) => !c.passed).length, 5);
});

test('missing xmlns fails parse', () => {
  assert.equal(byName(validateSvg(GOOD.replace(' xmlns="http://www.w3.org/2000/svg"', '')), 'parses').passed, false);
});

test('shape outside viewBox fails (circle, path, translated group)', () => {
  assert.equal(byName(validateSvg(GOOD.replace('cx="400"', 'cx="790"')), 'inside_viewbox').passed, false);
  assert.equal(byName(validateSvg(GOOD.replace('L 750 50', 'L 900 50')), 'inside_viewbox').passed, false);
  const moved = GOOD.replace('<circle', '<g transform="translate(400,0)"><circle').replace('</circle>', '</circle></g>');
  assert.equal(byName(validateSvg(moved), 'inside_viewbox').passed, false);
});

test('missing viewBox fails', () => {
  assert.equal(byName(validateSvg(GOOD.replace(' viewBox="0 0 800 500"', '')), 'inside_viewbox').passed, false);
});

test('needs title and 3 labels', () => {
  assert.equal(byName(validateSvg(GOOD.replace('<title>Test</title>', '')), 'title_and_labels').passed, false);
  assert.equal(byName(validateSvg(GOOD.replace('<text x="10" y="90">c</text>', '')), 'title_and_labels').passed, false);
  assert.equal(byName(validateSvg(GOOD.replace('<text x="10" y="90">c</text>', '<text x="1" y="1"> </text>')), 'title_and_labels').passed, false);
});

test('animation: none fails, SMIL passes, CSS needs keyframes AND use', () => {
  const none = GOOD.replace(/<animate [^>]*\/>/, '');
  assert.equal(byName(validateSvg(none), 'has_animation').passed, false);
  const css = none.replace('<rect', '<style>@keyframes s{to{opacity:0}} .a{animation:s 2s infinite}</style><rect');
  assert.equal(byName(validateSvg(css), 'has_animation').passed, true);
  const unused = none.replace('<rect', '<style>@keyframes s{to{opacity:0}}</style><rect');
  assert.equal(byName(validateSvg(unused), 'has_animation').passed, false);
});

test('safe_content rejects scripts, handlers, external hrefs', () => {
  assert.equal(byName(validateSvg(GOOD.replace('<rect', '<script>alert(1)</script><rect')), 'safe_content').passed, false);
  assert.equal(byName(validateSvg(GOOD.replace('<rect', '<rect onclick="x()"')), 'safe_content').passed, false);
  assert.equal(byName(validateSvg(GOOD.replace('<rect x="0"', '<use href="https://evil.test/x.svg#a"/><rect x="0"')), 'safe_content').passed, false);
});

// ---------- pipeline with a stubbed model ----------
const stub = (replies) => {
  const calls = [];
  const fn = async (args) => {
    calls.push(JSON.parse(JSON.stringify(args.contents)));
    const text = replies[Math.min(calls.length - 1, replies.length - 1)];
    return { text, inputTokens: 1000, outputTokens: 2000, finishReason: 'STOP', apiRetries: 0 };
  };
  fn.calls = calls;
  return fn;
};
const quiet = { log: () => {} };

test('pipeline: passes first time, 0 retries, cost computed', async () => {
  const r = await generateDiagram(CONCEPTS[0], { call: stub([GOOD]), ...quiet });
  assert.equal(r.passed, true);
  assert.equal(r.retries, 0);
  assert.equal(r.inputTokens, 1000);
  assert.ok(Math.abs(r.costUsd - (1000 * 0.3 + 2000 * 2.5) / 1e6) < 1e-9);
});

test('pipeline: failed check -> one retry that tells the model why', async () => {
  const bad = GOOD.replace('cx="400"', 'cx="900"');
  const call = stub([bad, GOOD]);
  const r = await generateDiagram(CONCEPTS[1], { call, ...quiet });
  assert.equal(r.retries, 1);
  assert.equal(r.passed, true);
  assert.equal(r.inputTokens, 2000); // tokens summed over both calls
  const feedback = call.calls[1].at(-1).parts[0].text;
  assert.match(feedback, /inside_viewbox/);
  assert.match(feedback, /outside the viewBox/);
});

test('pipeline: still failing after the single retry is saved honestly as FAIL', async () => {
  const bad = GOOD.replace('cx="400"', 'cx="900"');
  const call = stub([bad, bad, bad]);
  const r = await generateDiagram(CONCEPTS[2], { call, ...quiet });
  assert.equal(call.calls.length, 2); // never more than one retry
  assert.equal(r.passed, false);
  assert.equal(r.retries, 1);
});

// ---------- API retry on 429 / 503 ----------
const resp = (status, body) => ({ ok: status < 300, status, json: async () => body });
const OK = resp(200, { candidates: [{ content: { parts: [{ text: GOOD }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 5 } });

test('api: 429 then 503 then success -> waits twice, counts thinking tokens', async () => {
  const seq = [resp(429, { error: { message: 'quota' } }), resp(503, {}), OK];
  const waits = [];
  const r = await callGemini({ system: 's', contents: [], apiKey: 'k', fetchFn: async () => seq.shift(), sleepFn: async (ms) => waits.push(ms) });
  assert.equal(r.apiRetries, 2);
  assert.equal(waits.length, 2);
  assert.equal(r.outputTokens, 25);
});

test('api: gives up after 3 retries with a clear message', async () => {
  let n = 0;
  await assert.rejects(
    callGemini({ system: 's', contents: [], apiKey: 'k', fetchFn: async () => (n++, resp(503, {})), sleepFn: async () => {} }),
    (e) => e instanceof ApiError && e.status === 503 && /overloaded/i.test(e.message) && e.apiRetries === 3,
  );
  assert.equal(n, 4); // 1 try + 3 retries
});

test('api: other errors are not retried; missing key is explained', async () => {
  let n = 0;
  await assert.rejects(callGemini({ system: 's', contents: [], apiKey: 'k', fetchFn: async () => (n++, resp(403, {})), sleepFn: async () => {} }), /refused/i);
  assert.equal(n, 1);
  await assert.rejects(callGemini({ system: 's', contents: [], apiKey: '' }), /GEMINI_API_KEY/);
});
