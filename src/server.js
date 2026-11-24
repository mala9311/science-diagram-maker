import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONCEPTS, getConcept } from './concepts.js';
import { generateDiagram } from './generate.js';
import { DEFAULT_MODEL } from './gemini.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_FILE = path.join(ROOT, 'results.json');
const REVIEWS_FILE = path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'reviews.json');

const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(ROOT, 'public')));

const readJson = async (file, fallback) => {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
};

// Saved results: served straight from results.json, no model call.
app.get('/api/results', async (_req, res) => {
  const saved = await readJson(RESULTS_FILE, []);
  res.json({ model: DEFAULT_MODEL, concepts: CONCEPTS.map(({ id, title, subject }) => ({ id, title, subject })), results: saved });
});

// Approve / reject decisions, stored in a JSON file on the server (browser also keeps a copy; see README).
app.get('/api/reviews', async (_req, res) => res.json(await readJson(REVIEWS_FILE, {})));

app.put('/api/reviews/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { decision, note } = req.body || {};
  if (!getConcept(id)) return res.status(404).json({ error: 'Unknown concept id.' });
  if (!['approved', 'rejected', null].includes(decision)) return res.status(400).json({ error: 'decision must be "approved", "rejected" or null.' });
  const all = await readJson(REVIEWS_FILE, {});
  const stamp = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
  all[id] = {
    decision,
    note: String(note ?? '').slice(0, 2000),
    updatedAt: new Date().toISOString(),
    noteUpdatedAt: stamp(req.body?.noteUpdatedAt) || new Date().toISOString(),
    decisionUpdatedAt: stamp(req.body?.decisionUpdatedAt) || null,
  };
  await fs.mkdir(path.dirname(REVIEWS_FILE), { recursive: true });
  await fs.writeFile(REVIEWS_FILE, JSON.stringify(all, null, 2));
  res.json(all[id]);
});

// Live generation for ONE concept. One at a time, capped per visitor AND globally,
// so one visitor cannot drain the free quota for the reviewers.
let busy = false;
const hitsByIp = new Map();
const LIMIT_PER_HOUR = Number(process.env.GENERATE_LIMIT_PER_HOUR || 20);
const GLOBAL_LIMIT_PER_HOUR = Number(process.env.GENERATE_GLOBAL_LIMIT_PER_HOUR || 100);

function recentHits(map, key, now) {
  const hits = (map.get(key) || []).filter((t) => now - t <= 3_600_000);
  map.set(key, hits);
  return hits;
}

app.post('/api/generate', async (req, res) => {
  const concept = getConcept(req.body?.id);
  if (!concept) return res.status(400).json({ error: 'Send {"id": 1-5}.' });
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'The server has no GEMINI_API_KEY set, so live generation is switched off. The 5 saved results still work.' });
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const mine = recentHits(hitsByIp, ip, now);
  const total = [...hitsByIp.values()].flatMap((list) => list.filter((t) => now - t <= 3_600_000)).length;
  if (mine.length >= LIMIT_PER_HOUR) return res.status(429).json({ error: 'You have reached the live generation limit for this hour. Please try again later.' });
  if (total >= GLOBAL_LIMIT_PER_HOUR) return res.status(429).json({ error: 'The shared generation limit for this hour has been reached. Please try again later.' });
  if (busy) return res.status(429).json({ error: 'Another diagram is being generated. Wait for it to finish, then try again.' });
  busy = true;
  mine.push(now);
  try {
    const result = await generateDiagram(concept);
    console.log(`[generate] live concept ${concept.id} model=${result.model} cost=$${result.costUsd} retries=${result.retries} apiRetries=${result.apiRetries}`);
    res.json({ result });
  } catch (e) {
    const status = e.status === 429 || e.status === 503 ? e.status : 502;
    res.status(status).json({ error: e.message, apiRetries: e.apiRetries ?? 0 });
  } finally {
    busy = false;
  }
});

// Never show a blank page: JSON errors for the API, plain message otherwise.
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Science Diagram Maker on http://localhost:${port}  (model: ${DEFAULT_MODEL}, key ${process.env.GEMINI_API_KEY ? 'set' : 'NOT set'})`));
