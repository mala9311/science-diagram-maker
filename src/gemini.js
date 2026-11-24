// Thin Gemini REST client with 429/503 retry. No SDK: one fetch call, easy to explain.
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
export const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

// Paid-tier list price used only to ESTIMATE cost (the free tier itself bills $0).
// Source: https://ai.google.dev/pricing  (Gemini 3.5 Flash-Lite, USD per 1M tokens, output includes thinking).
// Override with PRICE_INPUT_PER_M / PRICE_OUTPUT_PER_M if you use another model.
export const PRICES = {
  input: Number(process.env.PRICE_INPUT_PER_M ?? 0.3),
  output: Number(process.env.PRICE_OUTPUT_PER_M ?? 2.5),
};
export const estimateCost = (inTok, outTok) => (inTok * PRICES.input + outTok * PRICES.output) / 1e6;

export class ApiError extends Error {
  constructor(message, { status, retryable = false, apiRetries = 0 } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryable = retryable;
    this.apiRetries = apiRetries;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function friendly(status, body) {
  const msg = body?.error?.message || '';
  if (status === 400 && /api key/i.test(msg)) return 'Gemini rejected the API key. Check GEMINI_API_KEY.';
  if (status === 401 || status === 403) return 'Gemini refused the request (invalid key or no access to this model). Check GEMINI_API_KEY and GEMINI_MODEL.';
  if (status === 404) return 'Gemini model not found. Set GEMINI_MODEL to a model your key can use.';
  if (status === 429) return 'Gemini rate limit hit (free tier is small). Wait a minute and try again.';
  if (status === 503) return 'Gemini is overloaded right now (503). Try again shortly.';
  return `Gemini API error ${status}${msg ? `: ${msg.slice(0, 200)}` : ''}`;
}

/**
 * Call generateContent. Retries on 429/503 up to `maxRetries` (3) times with exponential backoff.
 * Returns { text, inputTokens, outputTokens, apiRetries, finishReason }.
 * `sleepFn` and `fetchFn` are injectable so tests don't wait or hit the network.
 */
export async function callGemini({ system, contents, model = DEFAULT_MODEL, apiKey = process.env.GEMINI_API_KEY, maxRetries = 3, sleepFn = sleep, fetchFn = fetch }) {
  if (!apiKey) throw new ApiError('GEMINI_API_KEY is not set on the server.', { status: 500 });
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: { temperature: 0.4, maxOutputTokens: 16000 },
  };
  let apiRetries = 0;
  for (let attempt = 0; ; attempt++) {
    let res, data;
    try {
      res = await fetchFn(`${BASE}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, // key in header, never in URL/logs
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      throw new ApiError(`Could not reach Gemini: ${e.message}`, { status: 0, apiRetries });
    }

    if (res.ok) {
      const cand = data.candidates?.[0];
      const text = (cand?.content?.parts || []).map((p) => p.text || '').join('');
      const u = data.usageMetadata || {};
      return {
        text,
        inputTokens: u.promptTokenCount || 0,
        outputTokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
        finishReason: cand?.finishReason || data.promptFeedback?.blockReason || 'UNKNOWN',
        apiRetries,
      };
    }

    const retryable = res.status === 429 || res.status === 503;
    if (retryable && attempt < maxRetries) {
      // honour Google's suggested delay if present ("retryDelay": "17s"), else 2s, 4s, 8s
      const hint = (data?.error?.details || []).find((d) => d.retryDelay)?.retryDelay;
      const wait = hint ? Math.min(parseFloat(hint) * 1000 + 500, 60_000) : 2000 * 2 ** attempt;
      apiRetries++;
      console.warn(`[gemini] ${res.status}, retry ${apiRetries}/${maxRetries} in ${Math.round(wait / 1000)}s`);
      await sleepFn(wait);
      continue;
    }
    throw new ApiError(friendly(res.status, data), { status: res.status, retryable, apiRetries });
  }
}
