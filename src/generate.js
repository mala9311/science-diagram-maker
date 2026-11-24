// Part A pipeline: one concept -> model call -> code checks -> (one retry with the failure reasons) -> result record.
import { callGemini, DEFAULT_MODEL, estimateCost } from './gemini.js';
import { extractSvg, validateSvg, allPassed } from './validate.js';

const SYSTEM = `You are an expert maker of animated science diagrams for UK GCSE students (ages 14-16).
Reply with ONE complete SVG document and nothing else: no markdown fences, no explanation.

Hard requirements (they are checked by code):
- Root element: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500">. Keep EVERY shape and text anchor inside x 0..800, y 0..500.
- First child of <svg> is a <title> naming the diagram.
- At least 3 <text> labels naming the key parts; use font-size 16-22 and a sans-serif font.
- At least one animation that helps explain the idea, using SMIL (<animate>, <animateTransform>, <animateMotion>) or CSS @keyframes inside a <style> element. Animation must loop or run on repeat.
- No <script>, no event attributes (onclick etc.), no <foreignObject>, no <image>, no external links or fonts.

Quality: scientifically correct and clear for a teenager. Use a white or very light background rect, strong contrast, and colour with purpose. Do not overlap labels or let a caption sit on top of a shape. Animate the idea itself (e.g. things that move, grow or highlight in sequence), not just decoration. Write all text as plain text. Never use LaTeX or dollar signs; for maths use Unicode characters such as a², b², c² and a² + b² = c².`;

const userPrompt = (c) =>
  `Draw one animated SVG diagram for this ${c.subject} concept: "${c.title}".\n\nText to teach:\n${c.text}`;

const feedbackPrompt = (failed) =>
  `Your SVG failed these automatic checks:\n${failed.map((c) => `- ${c.name}: ${c.detail}`).join('\n')}\n\nFix every problem and reply with the complete corrected SVG only (no markdown, no explanation).`;

/**
 * @param concept   one entry from CONCEPTS
 * @param opts.call injectable model caller (tests); defaults to the real Gemini client
 * Throws ApiError if the API fails after its own retries. Otherwise always returns a record,
 * even when checks still fail after the one allowed retry (the failure is saved honestly).
 */
export async function generateDiagram(concept, { call = callGemini, model = DEFAULT_MODEL, log = console.log } = {}) {
  const contents = [{ role: 'user', parts: [{ text: userPrompt(concept) }] }];
  const attempts = [];
  let inputTokens = 0, outputTokens = 0, apiRetries = 0;

  for (let n = 0; n < 2; n++) {
    const res = await call({ system: SYSTEM, contents, model }); // throws ApiError after 3 waits on 429/503
    inputTokens += res.inputTokens;
    outputTokens += res.outputTokens;
    apiRetries += res.apiRetries;
    const svg = extractSvg(res.text);
    const checks = validateSvg(svg);
    attempts.push({ svg, checks, finishReason: res.finishReason });
    log(`[${concept.slug}] attempt ${n + 1}: ${checks.filter((c) => c.passed).length}/${checks.length} checks passed`);
    if (allPassed(checks) || n === 1) break;
    // retry once, telling the model exactly what failed
    contents.push({ role: 'model', parts: [{ text: svg || res.text || '(empty reply)' }] });
    contents.push({ role: 'user', parts: [{ text: feedbackPrompt(checks.filter((c) => !c.passed)) }] });
  }

  // keep the final attempt unless the first one was strictly better
  const score = (a) => a.checks.filter((c) => c.passed).length;
  const best = attempts.length === 2 && score(attempts[0]) > score(attempts[1]) ? attempts[0] : attempts[attempts.length - 1];

  return {
    id: concept.id,
    slug: concept.slug,
    concept: concept.title,
    subject: concept.subject,
    model,
    inputTokens,
    outputTokens,
    costUsd: Number(estimateCost(inputTokens, outputTokens).toFixed(6)),
    retries: attempts.length - 1, // check-failure retries (0 or 1)
    apiRetries, // 429/503 waits
    passed: allPassed(best.checks),
    checks: best.checks,
    firstAttemptChecks: attempts.length === 2 ? attempts[0].checks : undefined,
    svg: best.svg,
    generatedAt: new Date().toISOString(),
  };
}
