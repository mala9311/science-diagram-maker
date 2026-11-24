// Prints the README results table from results.json:  npm run table
import fs from 'node:fs';
const rs = JSON.parse(fs.readFileSync(new URL('../results.json', import.meta.url), 'utf8'));
console.log('| # | Concept | Result | Failed checks | Cost (USD, est.) | Retries | Tokens in/out |');
console.log('|---|---------|--------|---------------|------------------|---------|---------------|');
for (const r of rs) {
  const failed = r.checks.filter((c) => !c.passed).map((c) => c.name).join(', ') || '–';
  console.log(`| ${r.id} | ${r.concept} | ${r.passed ? 'PASS' : 'FAIL'} | ${failed} | $${r.costUsd.toFixed(5)} | ${r.retries} | ${r.inputTokens}/${r.outputTokens} |`);
}
console.log(`\nTotal estimated cost: $${rs.reduce((s, r) => s + r.costUsd, 0).toFixed(5)}  (model: ${rs[0]?.model})`);
