// Front-end for the review studio. All model calls happen on the server;
// this file only reads saved results, saves reviews, and asks for a live generation.
const $ = (sel, root = document) => root.querySelector(sel);

const LABELS = {
  parses: 'Valid SVG XML',
  inside_viewbox: 'Inside viewBox',
  title_and_labels: 'Title + 3 labels',
  has_animation: 'Has animation',
  safe_content: 'Safe content (my check)',
};

const state = {
  concepts: [],
  results: {},
  reviews: {},
  model: '',
  query: '',
  filter: 'all',
  statuses: {},
  busy: false,
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `$${Number(n || 0).toFixed(5)}`;
const svgSrc = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

// localStorage is a backup for review decisions if the free host restarts and loses its disk.
const ls = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
};

async function api(url, opts) {
  let res;
  try { res = await fetch(url, opts); }
  catch { throw new Error('Cannot reach the server. Check your connection and try again.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

function banner(message, type = 'info') {
  const el = $('#banner');
  if (!message) { el.hidden = true; el.innerHTML = ''; return; }
  el.className = `banner ${type}`;
  el.innerHTML = `${esc(message)}<button type="button" data-action="close-banner" aria-label="Dismiss message">×</button>`;
  el.hidden = false;
}

function toast(message, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 5200);
}

function renderStats() {
  const rows = Object.values(state.results);
  const checks = rows.flatMap((r) => r.checks || []);
  const passed = checks.filter((c) => c.passed).length;
  const cost = rows.reduce((sum, r) => sum + (r.costUsd || 0), 0);
  const reviewed = Object.values(state.reviews).filter((r) => r.decision).length;
  const cards = [
    { label: 'Diagrams', value: `${rows.length}/5`, foot: 'Saved results, loaded instantly', pct: rows.length / 5 * 100 },
    { label: 'Code checks passed', value: `${passed}/${checks.length}`, foot: 'Five automated checks per diagram', pct: checks.length ? passed / checks.length * 100 : 0, glow: 'rgba(52,211,153,.12)' },
    { label: 'Estimated cost', value: money(cost), foot: 'Paid-list-price estimate; free tier bills $0', pct: 100, glow: 'rgba(129,140,248,.12)' },
    { label: 'Reviewed', value: `${reviewed}/5`, foot: 'Approve / reject decisions saved', pct: reviewed / 5 * 100 },
  ];
  $('#stats').innerHTML = cards.map((c) => `<article class="stat-card" style="--stat-glow:${c.glow || 'rgba(94,234,212,.09)'}">
    <div class="stat-label">${esc(c.label)}</div>
    <div class="stat-value">${esc(c.value)}</div>
    <div class="stat-foot">${esc(c.foot)}</div>
    <div class="stat-bar"><i style="width:${Math.min(100, Math.max(0, c.pct))}%"></i></div>
  </article>`).join('');
}

function visibleConcepts() {
  const q = state.query.trim().toLowerCase();
  return state.concepts.filter((c) => {
    if (q && !`${c.title} ${c.subject}`.toLowerCase().includes(q)) return false;
    const r = state.results[c.id];
    const rv = state.reviews[c.id] || {};
    if (state.filter === 'passed' && !r?.passed) return false;
    if (state.filter === 'failed' && r?.passed) return false;
    if (state.filter === 'reviewed' && !rv.decision) return false;
    if (state.filter === 'unreviewed' && rv.decision) return false;
    return true;
  });
}

function checksHtml(result) {
  if (!result) return '<span class="sub">–</span>';
  return `<ul class="checks">${(result.checks || []).map((c) => `<li>
    <span class="check-pill ${c.passed ? 'pass' : 'fail'}">${c.passed ? 'PASS' : 'FAIL'}</span>
    <span class="check-name">${esc(LABELS[c.name] || c.name)}</span>
    <span class="check-detail">${esc(c.detail)}</span>
  </li>`).join('')}</ul>`;
}

function rowHtml(c) {
  const r = state.results[c.id];
  const rv = state.reviews[c.id] || {};
  const st = state.statuses[c.id] || {};
  const diagram = r
    ? `<button type="button" class="diagram-frame" data-action="view" data-id="${c.id}" aria-label="Open full diagram for ${esc(c.title)}"><img alt="Animated diagram: ${esc(c.title)}" src="${svgSrc(r.svg)}"></button>`
    : '<div class="no-diagram">No saved result yet.<br>Press Generate.</div>';
  const stats = r ? `<div class="cost-main">${money(r.costUsd)}</div>
    <div class="cost-label">Est. cost · ${esc(r.model)}</div>
    <div class="metric-grid">
      <span>Retries</span><b>${r.retries}${r.apiRetries ? ` + ${r.apiRetries} API wait${r.apiRetries > 1 ? 's' : ''}` : ''}</b>
      <span>Tokens</span><b>${r.inputTokens} / ${r.outputTokens}</b>
    </div>` : '<span class="sub">–</span>';
  const stateLabel = rv.decision ? `Saved: ${rv.decision}` : (rv.note ? 'Note saved · not reviewed' : 'Not reviewed');
  return `<tr data-id="${c.id}" class="${r?.live ? 'live-row' : ''}">
    <td class="concept-cell">
      <div class="concept-num">#${c.id}</div>
      <div class="concept-title">${esc(c.title)}${r?.live ? '<span class="tag-live">live</span>' : ''}</div>
      <span class="subject-tag">${esc(c.subject)}</span>
      <button type="button" class="btn gen-btn" data-action="generate" data-id="${c.id}" ${state.busy || st.loading ? 'disabled' : ''}>
        ${st.loading ? '<i class="spinner"></i> Generating…' : 'Generate live'}
      </button>
      ${st.text ? `<div class="status ${st.type || ''}">${esc(st.text)}</div>` : ''}
    </td>
    <td class="diagram-cell">${diagram}</td>
    <td>${checksHtml(r)}</td>
    <td class="cost-cell">${stats}</td>
    <td class="review-cell">
      <div class="segmented">
        <button type="button" class="approve ${rv.decision === 'approved' ? 'on' : ''}" data-action="approve" data-id="${c.id}" aria-pressed="${rv.decision === 'approved'}">✓ Approve</button>
        <button type="button" class="reject ${rv.decision === 'rejected' ? 'on' : ''}" data-action="reject" data-id="${c.id}" aria-pressed="${rv.decision === 'rejected'}">✕ Reject</button>
      </div>
      <textarea class="note-input" data-id="${c.id}" placeholder="Reviewer note…" aria-label="Reviewer note for ${esc(c.title)}">${esc(rv.note || '')}</textarea>
      <div class="review-state ${rv.decision ? 'saved' : ''}">${rv.decision ? '●' : '○'} ${stateLabel}</div>
    </td>
  </tr>`;
}

function syncNotes() {
  document.querySelectorAll('.note-input').forEach((el) => {
    const id = Number(el.dataset.id);
    state.reviews[id] = { ...(state.reviews[id] || {}), note: el.value };
  });
}

function render() {
  renderStats();
  const rows = visibleConcepts();
  $('#rows').innerHTML = rows.map(rowHtml).join('');
  $('#empty').hidden = rows.length > 0;
  $('#row-count').textContent = rows.length;
  $('#subtitle').textContent = state.filter === 'all' && !state.query
    ? 'Code checks and reviewer decisions, side by side.'
    : `${rows.length} matching result${rows.length === 1 ? '' : 's'} · click a diagram for the full view.`;
  $('#model-badge').textContent = `model · ${state.model || 'unknown'}`;
}

function updateReviewUi(tr, review) {
  const approve = $('.approve', tr), reject = $('.reject', tr), label = $('.review-state', tr);
  approve.classList.toggle('on', review.decision === 'approved');
  reject.classList.toggle('on', review.decision === 'rejected');
  approve.setAttribute('aria-pressed', String(review.decision === 'approved'));
  reject.setAttribute('aria-pressed', String(review.decision === 'rejected'));
  label.className = `review-state ${review.decision ? 'saved' : ''}`;
  label.textContent = `${review.decision ? '●' : '○'} ${review.decision ? `Saved: ${review.decision}` : (review.note ? 'Note saved · not reviewed' : 'Not reviewed')}`;
}

async function saveReview(id, patch, tr) {
  const next = { ...(state.reviews[id] || {}), ...patch };
  state.reviews[id] = next;
  ls.set('reviews', state.reviews);
  updateReviewUi(tr, next);
  try {
    await api(`/api/reviews/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: next.decision ?? null, note: next.note ?? '' }),
    });
  } catch (e) {
    $('.review-state', tr).textContent = `● Saved in this browser only (${e.message})`;
    toast('Server unavailable — review saved in this browser only.', 'error');
  }
}

async function generate(id, button) {
  if (state.busy) return;
  state.busy = true;
  syncNotes();
  state.statuses[id] = { text: 'Asking the model… this can take up to a minute.', loading: true };
  render();
  try {
    const { result } = await api('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    state.results[id] = { ...result, live: true };
    state.statuses[id] = {
      text: `Live result · ${result.passed ? 'all checks passed' : 'some checks failed'}${result.retries ? ` · ${result.retries} retry` : ''}`,
      type: result.passed ? 'ok' : 'err',
    };
    banner(`Concept ${id} generated live. It is shown in this row only — results.json is unchanged.`, 'info');
    toast(`Concept ${id}: ${result.passed ? 'all checks passed' : 'some checks failed'}.`, result.passed ? 'ok' : 'error');
  } catch (e) {
    state.statuses[id] = { text: e.message, type: 'err' };
    banner(`Generate failed for concept ${id}: ${e.message}`, 'error');
    toast(`Generation failed: ${e.message}`, 'error');
  } finally {
    state.busy = false;
    render();
  }
}

function openModal(id) {
  const r = state.results[id];
  if (!r) return;
  const c = state.concepts.find((x) => x.id === id);
  const checks = (r.checks || []).map((k) => `<li><span class="check-pill ${k.passed ? 'pass' : 'fail'}">${k.passed ? 'PASS' : 'FAIL'}</span><span class="check-name">${esc(LABELS[k.name] || k.name)}</span><span class="check-detail">${esc(k.detail)}</span></li>`).join('');
  $('#modal-body').innerHTML = `<h2 id="modal-title">${esc(c?.title || r.concept)}</h2>
    <p class="modal-sub">${esc(c?.subject || r.subject)} · generated with ${esc(r.model)}</p>
    <div class="modal-grid">
      <div class="modal-diagram"><img alt="Full animated diagram: ${esc(r.concept)}" src="${svgSrc(r.svg)}"></div>
      <div class="modal-meta">
        <h3>Code checks</h3><ul class="checks">${checks}</ul>
        <h3>Run details</h3>
        <dl class="meta-list">
          <div><dt>Estimated cost</dt><dd>${money(r.costUsd)}</dd></div>
          <div><dt>Retries</dt><dd>${r.retries}</dd></div>
          <div><dt>API waits (429/503)</dt><dd>${r.apiRetries || 0}</dd></div>
          <div><dt>Input tokens</dt><dd>${r.inputTokens}</dd></div>
          <div><dt>Output tokens</dt><dd>${r.outputTokens}</dd></div>
          <div><dt>Generated</dt><dd>${esc(new Date(r.generatedAt).toLocaleString())}</dd></div>
        </dl>
      </div>
    </div>`;
  $('#modal').hidden = false;
  $('.modal-close').focus();
}

function closeModal() { $('#modal').hidden = true; }

async function load() {
  try {
    const data = await api('/api/results');
    state.concepts = data.concepts || [];
    state.results = Object.fromEntries((data.results || []).map((r) => [r.id, r]));
    state.model = data.model || '';
    let server = {};
    try { server = await api('/api/reviews'); } catch { /* browser copy still works */ }
    state.reviews = { ...ls.get('reviews', {}), ...server };
    render();
    if (!data.results.length) banner('No saved results found. Run npm run generate with a GEMINI_API_KEY, or press Generate live on a row.', 'info');
  } catch (e) {
    banner(`Could not load the saved results: ${e.message}`, 'error');
  }
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const trigger = e.target.closest('[data-action], [data-close]');
  if (!trigger) return;
  if (trigger.hasAttribute('data-close')) { closeModal(); return; }
  const action = trigger.dataset.action;
  const tr = trigger.closest('tr[data-id]');
  const id = Number(tr?.dataset.id || trigger.dataset.id);
  if (action === 'close-banner') { banner(''); }
  if (action === 'view') { openModal(id); }
  if (action === 'generate') { generate(id, trigger); }
  if (action === 'approve' || action === 'reject') {
    const want = action === 'approve' ? 'approved' : 'rejected';
    const decision = state.reviews[id]?.decision === want ? null : want; // click again to clear
    const note = $('.note-input', tr)?.value ?? state.reviews[id]?.note ?? '';
    saveReview(id, { decision, note }, tr);
  }
});

document.addEventListener('change', (e) => {
  if (!e.target.matches('.note-input')) return;
  const tr = e.target.closest('tr[data-id]');
  saveReview(Number(tr.dataset.id), { note: e.target.value }, tr);
});

$('#search').addEventListener('input', (e) => { state.query = e.target.value; render(); });
$('#filter').addEventListener('change', (e) => { state.filter = e.target.value; render(); });
$('#refresh').addEventListener('click', () => { syncNotes(); load(); toast('Reloaded saved results.'); });
$('#how-it-works').addEventListener('click', () => banner('Each SVG is checked for valid XML, viewBox bounds, a title plus 3 labels, real animation, and safe content. A failed check is sent back to Gemini once. Reviews are saved on the server and in this browser.', 'info'));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

load();
