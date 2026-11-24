// Runs Part A for all 5 concepts and writes results.json.
// Usage: GEMINI_API_KEY=... npm run generate            (all five)
//        GEMINI_API_KEY=... npm run generate -- 3 4     (only concepts 3 and 4; others are kept)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONCEPTS } from '../src/concepts.js';
import { generateDiagram } from '../src/generate.js';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'results.json');
const only = process.argv.slice(2).map(Number).filter(Boolean);
const existing = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => []);
const byId = new Map(existing.map((r) => [r.id, r]));

for (const c of CONCEPTS.filter((c) => !only.length || only.includes(c.id))) {
  try {
    const r = await generateDiagram(c);
    byId.set(c.id, r);
    console.log(`#${c.id} ${c.title}: ${r.passed ? 'PASS' : 'FAIL'} | in ${r.inputTokens} out ${r.outputTokens} tokens | $${r.costUsd} | retries ${r.retries} | api waits ${r.apiRetries}`);
    for (const k of r.checks) console.log(`     ${k.passed ? '✓' : '✗'} ${k.name}: ${k.detail}`);
  } catch (e) {
    console.error(`#${c.id} ${c.title}: API ERROR - ${e.message}`);
  }
  // write after every concept so a crash never loses finished work
  await fs.writeFile(file, JSON.stringify([...byId.values()].sort((a, b) => a.id - b.id), null, 2));
  await new Promise((r) => setTimeout(r, 4000)); // be gentle with free-tier limits
}
console.log(`\nSaved ${byId.size}/5 results to results.json`);
