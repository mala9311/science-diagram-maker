// Code checks for a model-written SVG. Pure functions: no network, no model.
// Every check returns { name, passed, detail }.
import { DOMParser } from '@xmldom/xmldom';

const SVG_NS = 'http://www.w3.org/2000/svg';
export const CHECK_NAMES = ['parses', 'inside_viewbox', 'title_and_labels', 'has_animation', 'safe_content', 'plain_text_labels'];

/** Pull the <svg>...</svg> out of a model reply (it may add ``` fences or chatter). */
export function extractSvg(raw) {
  if (!raw) return '';
  const text = String(raw).replace(/```(?:svg|xml|html)?/gi, '');
  const start = text.search(/<svg[\s>]/i);
  const end = text.toLowerCase().lastIndexOf('</svg>');
  if (start === -1) return text.trim();
  if (end === -1 || end < start) return text.slice(start).trim(); // truncated: parse check will fail
  return text.slice(start, end + 6).trim();
}

// ---------- check 1: parses ----------
function parseSvg(svg) {
  const problems = [];
  // @xmldom/xmldom >= 0.9 uses onError(level, message); 'warning' is ignored, 'error'/'fatalError' count as failures
  const onError = (level, m) => { if (level !== 'warning') problems.push(String(m).split('\n')[0]); };
  let doc = null;
  try {
    doc = new DOMParser({ onError }).parseFromString(svg, 'image/svg+xml');
  } catch (e) {
    problems.push(e.message);
  }
  const root = doc && doc.documentElement;
  if (!root) problems.push('no root element');
  else if (root.localName !== 'svg') problems.push(`root element is <${root.localName}>, not <svg>`);
  // browsers will not render an <img> SVG without the explicit xmlns attribute
  else if (root.getAttribute('xmlns') !== SVG_NS) problems.push('missing xmlns="http://www.w3.org/2000/svg" on <svg>');
  return { doc: problems.length ? null : doc, problems };
}

// ---------- helpers ----------
const num = (v, d = 0) => {
  if (v == null || v === '') return d;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
};

function* walk(node) {
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1) {
      yield c;
      yield* walk(c);
    }
  }
}

const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

/** Font sizes declared in <style> rules, so text width can be estimated without a browser. */
function cssFontRules(root) {
  const rules = new Map();
  for (const el of walk(root)) {
    if (el.localName !== 'style') continue;
    for (const [, selector, body] of textOf(el).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const size = body.match(/font-size\s*:\s*([\d.]+)\s*px/i);
      if (!size) continue;
      const sel = selector.trim().replace(/\s+/g, ' ');
      if (sel.startsWith('.')) rules.set(sel.slice(1), Number(size[1]));
      else if (/^[a-z]+$/i.test(sel)) rules.set(sel.toLowerCase(), Number(size[1]));
    }
  }
  return rules;
}

function fontSizeFor(el, rules) {
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
    const attr = n.getAttribute && n.getAttribute('font-size');
    if (attr != null) {
      const v = parseFloat(attr);
      if (Number.isFinite(v)) return v;
    }
    const cls = n.getAttribute && n.getAttribute('class');
    if (cls) for (const name of cls.trim().split(/\s+/)) if (rules.has(name)) return rules.get(name);
    if (n.localName && rules.has(n.localName.toLowerCase())) return rules.get(n.localName.toLowerCase());
  }
  return 16;
}

const corners = (b) => [[b.minX, b.minY], [b.maxX, b.minY], [b.minX, b.maxY], [b.maxX, b.maxY]];
const wrap = (pts) => ({
  minX: Math.min(...pts.map((p) => p[0])), maxX: Math.max(...pts.map((p) => p[0])),
  minY: Math.min(...pts.map((p) => p[1])), maxY: Math.max(...pts.map((p) => p[1])),
});

/** Apply one SVG transform to a bounding box by transforming its four corners. */
function applyTransform(b, fn, a) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const point = ([x, y]) => {
    switch (fn) {
      case 'translate': return [x + (a[0] || 0), y + (a[1] || 0)];
      case 'scale': return [x * (a[0] ?? 1), y * (a[1] ?? a[0] ?? 1)];
      case 'rotate': {
        const t = rad(a[0] || 0), cx = a[1] || 0, cy = a[2] || 0;
        return [cx + (x - cx) * Math.cos(t) - (y - cy) * Math.sin(t), cy + (x - cx) * Math.sin(t) + (y - cy) * Math.cos(t)];
      }
      case 'matrix': {
        const [m11 = 1, m12 = 0, m21 = 0, m22 = 1, dx = 0, dy = 0] = a;
        return [m11 * x + m21 * y + dx, m12 * x + m22 * y + dy];
      }
      case 'skewx': return [x + Math.tan(rad(a[0] || 0)) * y, y];
      case 'skewy': return [x, y + Math.tan(rad(a[0] || 0)) * x];
      default: return [x, y];
    }
  };
  return wrap(corners(b).map(point));
}

/** Bounding box after this element's own transform and every ancestor transform. */
function transformedBounds(b, el) {
  const chain = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) chain.push(n);
  let out = b;
  for (const n of chain.reverse()) {
    const t = n.getAttribute && n.getAttribute('transform');
    if (!t) continue;
    for (const [, fn, raw] of t.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
      const args = raw.split(/[\s,]+/).filter(Boolean).map(Number);
      if (args.some(Number.isNaN)) continue;
      out = applyTransform(out, fn.toLowerCase(), args);
    }
  }
  return out;
}

/** Rough bounding box of a path's d attribute (handles M L H V C S Q T A Z, abs + rel). */
function pathBounds(d) {
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g);
  if (!toks) return null;
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0;
  const xs = [], ys = [];
  const push = (px, py) => { xs.push(px); ys.push(py); };
  const n = () => parseFloat(toks[i++]);
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === 'Z') { x = sx; y = sy; continue; }
    if (C === 'M' || C === 'L' || C === 'T') {
      const a = n(), b = n();
      x = rel ? x + a : a; y = rel ? y + b : b;
      push(x, y);
      if (C === 'M') { sx = x; sy = y; cmd = rel ? 'l' : 'L'; }
    } else if (C === 'H') { const a = n(); x = rel ? x + a : a; push(x, y); }
    else if (C === 'V') { const b = n(); y = rel ? y + b : b; push(x, y); }
    else if (C === 'C') {
      for (let k = 0; k < 3; k++) { const a = n(), b = n(); push(rel ? x + a : a, rel ? y + b : b); if (k === 2) { x = rel ? x + a : a; y = rel ? y + b : b; } }
    } else if (C === 'S' || C === 'Q') {
      for (let k = 0; k < 2; k++) { const a = n(), b = n(); push(rel ? x + a : a, rel ? y + b : b); if (k === 1) { x = rel ? x + a : a; y = rel ? y + b : b; } }
    } else if (C === 'A') {
      i += 5; // rx ry rotation large-arc sweep
      const a = n(), b = n();
      x = rel ? x + a : a; y = rel ? y + b : b; push(x, y);
    } else break; // unknown command
    if (xs.some(Number.isNaN) || ys.some(Number.isNaN)) return null;
  }
  if (!xs.length) return null;
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function boundsOf(el, fontRules) {
  const g = (a, d) => num(el.getAttribute(a), d);
  switch (el.localName) {
    case 'rect': return { minX: g('x'), minY: g('y'), maxX: g('x') + g('width'), maxY: g('y') + g('height') };
    case 'circle': return { minX: g('cx') - g('r'), minY: g('cy') - g('r'), maxX: g('cx') + g('r'), maxY: g('cy') + g('r') };
    case 'ellipse': return { minX: g('cx') - g('rx'), minY: g('cy') - g('ry'), maxX: g('cx') + g('rx'), maxY: g('cy') + g('ry') };
    case 'line': return { minX: Math.min(g('x1'), g('x2')), maxX: Math.max(g('x1'), g('x2')), minY: Math.min(g('y1'), g('y2')), maxY: Math.max(g('y1'), g('y2')) };
    case 'polygon':
    case 'polyline': {
      const nums = (el.getAttribute('points') || '').split(/[\s,]+/).filter(Boolean).map(Number);
      const xs = nums.filter((_, k) => k % 2 === 0), ys = nums.filter((_, k) => k % 2 === 1);
      if (!xs.length || !ys.length) return null;
      return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    }
    case 'path': return pathBounds(el.getAttribute('d') || '');
    case 'text': {
      // Estimate glyph width from font-size (no browser here). Average sans-serif glyph ≈ 0.58 em.
      const x = num(el.getAttribute('x')), y = num(el.getAttribute('y'));
      const size = fontSizeFor(el, fontRules);
      const width = Math.max(textOf(el).length, 1) * size * 0.58;
      const anchor = (el.getAttribute('text-anchor') || 'start').toLowerCase();
      const minX = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
      return { minX, maxX: minX + width, minY: y - size * 0.82, maxY: y + size * 0.22 };
    }
    default: return null;
  }
}

// ---------- check 2: nothing outside the viewBox ----------
function checkViewBox(root) {
  const vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || vb.some((n) => !Number.isFinite(n)) || vb[2] <= 0 || vb[3] <= 0) {
    return { passed: false, detail: 'missing or invalid viewBox attribute (need viewBox="minX minY width height")' };
  }
  const [vx, vy, vw, vh] = vb;
  const tol = 1;
  const outside = [];
  const fontRules = cssFontRules(root);
  let checked = 0;
  for (const el of walk(root)) {
    if ([el, ...ancestors(el)].some((a) => ['defs', 'clipPath', 'mask', 'pattern', 'marker', 'symbol'].includes(a.localName))) continue;
    const b = boundsOf(el, fontRules);
    if (!b) continue;
    checked++;
    const { minX, maxX, minY, maxY } = transformedBounds(b, el);
    if (minX < vx - tol || minY < vy - tol || maxX > vx + vw + tol || maxY > vy + vh + tol) {
      const what = el.localName === 'text' ? `text "${textOf(el).slice(0, 28)}"` : `<${el.localName}>`;
      outside.push(`${what} spans x ${r(minX)}..${r(maxX)}, y ${r(minY)}..${r(maxY)}`);
    }
  }
  const frame = `viewBox is ${vx} ${vy} ${vw} ${vh}`;
  if (outside.length) {
    return { passed: false, detail: `${outside.length} element(s) outside the viewBox (${frame}): ${outside.slice(0, 4).join('; ')}` };
  }
  return { passed: true, detail: `${checked} shapes inside the viewBox (${frame}), incl. estimated text widths` };
}
const r = (n) => Math.round(n * 10) / 10;
function* ancestors(el) { for (let n = el.parentNode; n && n.nodeType === 1; n = n.parentNode) yield n; }

// ---------- check 3: title + >= 3 text labels ----------
function checkTitleAndLabels(root) {
  const title = [...root.childNodes].find((n) => n.nodeType === 1 && n.localName === 'title');
  const labels = [...walk(root)].filter((el) => el.localName === 'text' && textOf(el).length > 0);
  const problems = [];
  if (!title || !textOf(title)) problems.push('no non-empty <title> as a direct child of <svg>');
  if (labels.length < 3) problems.push(`only ${labels.length} non-empty <text> label(s), need at least 3`);
  return problems.length
    ? { passed: false, detail: problems.join('; ') }
    : { passed: true, detail: `title "${textOf(title)}" and ${labels.length} text labels` };
}

// ---------- check 4: at least one animation ----------
function checkAnimation(root) {
  const smil = [...walk(root)].filter((el) => ['animate', 'animateTransform', 'animateMotion', 'set'].includes(el.localName));
  const css = [...walk(root)].filter((el) => el.localName === 'style').map(textOf).join(' ');
  const keyframes = /@keyframes\s+[\w-]+/.test(css);
  const uses = /animation(-name)?\s*:/.test(css) || [...walk(root)].some((el) => /animation\s*:/.test(el.getAttribute('style') || ''));
  if (smil.length) return { passed: true, detail: `${smil.length} SMIL animation element(s)` };
  if (keyframes && uses) return { passed: true, detail: 'CSS @keyframes animation is defined and applied' };
  if (keyframes) return { passed: false, detail: '@keyframes defined but no element uses an animation property, so nothing moves' };
  return { passed: false, detail: 'no <animate>, <animateTransform>, <animateMotion>, <set> or CSS @keyframes found' };
}

// ---------- check 5 (my own): safe, self-contained content ----------
// The page shows these SVGs to reviewers, so reject anything that could run code or load other sites.
function checkSafe(root) {
  const bad = [];
  for (const el of walk(root)) {
    const name = el.localName.toLowerCase();
    if (['script', 'foreignobject', 'iframe', 'object', 'embed', 'image'].includes(name)) bad.push(`<${name}> element`);
    for (let k = 0; k < el.attributes.length; k++) {
      const a = el.attributes[k];
      if (/^on/i.test(a.name)) bad.push(`${a.name} event attribute`);
      if (/^(xlink:)?href$/i.test(a.name) && !/^\s*#/.test(a.value)) bad.push(`external ${a.name}="${a.value.slice(0, 40)}"`);
    }
    if (name === 'style' && /@import|url\(\s*['"]?\s*(https?:|\/\/|data:)/i.test(el.textContent)) bad.push('external CSS reference');
  }
  return bad.length
    ? { passed: false, detail: `unsafe or external content: ${[...new Set(bad)].slice(0, 4).join(', ')}` }
    : { passed: true, detail: 'no scripts, event handlers, foreignObject or external references' };
}

// ---------- check 6 (my own): GCSE-friendly plain text labels ----------
// A model often writes "$V_{total}$" even when told not to. Those dollar signs look wrong on a lesson slide.
function checkPlainText(root) {
  const labels = [...walk(root)]
    .filter((el) => ['text', 'tspan', 'title'].includes(el.localName))
    .map(textOf).join(' ');
  const problems = [];
  if (labels.includes('$')) problems.push('literal $ (LaTeX/markdown maths)');
  if (/\\(?:frac|sqrt|times|cdot|alpha|beta|gamma|theta|pi|sum|rightarrow|mathrm|text|begin|end)\b/.test(labels)) problems.push('LaTeX command');
  if (/[{}]/.test(labels)) problems.push('LaTeX braces');
  if (/[A-Za-z]_\d/.test(labels)) problems.push('LaTeX-style subscript');
  return problems.length
    ? { passed: false, detail: `non-plain labels: ${[...new Set(problems)].join(', ')}` }
    : { passed: true, detail: 'labels use plain Unicode text' };
}

/** Run all 6 checks. Always returns all results, in CHECK_NAMES order. */
export function validateSvg(raw) {
  const svg = extractSvg(raw);
  const { doc, problems } = parseSvg(svg);
  if (!doc) {
    const fail = { passed: false, detail: 'skipped: SVG did not parse' };
    return [
      { name: 'parses', passed: false, detail: problems.slice(0, 3).join('; ') || 'could not parse as XML' },
      ...CHECK_NAMES.slice(1).map((name) => ({ name, ...fail })),
    ];
  }
  const root = doc.documentElement;
  return [
    { name: 'parses', passed: true, detail: 'well-formed XML with an <svg> root' },
    { name: 'inside_viewbox', ...checkViewBox(root) },
    { name: 'title_and_labels', ...checkTitleAndLabels(root) },
    { name: 'has_animation', ...checkAnimation(root) },
    { name: 'safe_content', ...checkSafe(root) },
    { name: 'plain_text_labels', ...checkPlainText(root) },
  ];
}

export const allPassed = (checks) => checks.every((c) => c.passed);
