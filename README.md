# Science Diagram Maker

Udhi Technologies home assignment. A small web app that asks Gemini for 5 animated SVG science diagrams, checks each one with code, and lets a reviewer approve or reject it.

- **Live app:** `<PASTE YOUR RENDER LINK HERE>`
- **Model:** `gemini-3.5-flash-lite` (free tier). Change it with the `GEMINI_MODEL` env var.

## How to run it on your computer

Needs Node 20 or newer.

```bash
npm install
cp .env.example .env            # then put your free key from aistudio.google.com/api-keys in .env
export GEMINI_API_KEY=your-key  # (or load .env however you like; the key is never in the code)
npm run generate                # Part A: calls the model 5 times, writes results.json
npm start                       # Part B: web page at http://localhost:3000
npm test                        # 15 unit tests (checks, retry logic, 429/503 handling) - no key needed
npm run table                   # prints the results table below from results.json
```

`npm run generate -- 3 4` re-runs only concepts 3 and 4 and keeps the others.

## How it works

| File | Job |
|------|-----|
| `src/concepts.js` | The 5 concepts, text copied from the assignment |
| `src/gemini.js` | One `fetch` call to Gemini. Retries 429 and 503 up to 3 times (uses Google's `retryDelay` if given, otherwise 2s/4s/8s). Counts input and output tokens (thinking tokens count as output). |
| `src/validate.js` | The 5 code checks (below) |
| `src/generate.js` | Pipeline: call model, run checks, if any fail then retry **once** and send the model the exact failure reasons, log everything |
| `src/server.js` | Express: serves saved results, saves reviews, runs live generation |
| `public/index.html` | The review table |

### The 5 checks

1. **parses** - valid XML, root is `<svg>`, has `xmlns` (without it a browser will not draw the SVG as an image).
2. **inside_viewbox** - needs a `viewBox`; every rect, circle, ellipse, line, polygon, polyline, path (all path commands) and text anchor must sit inside it. `translate()` is followed; shapes under `rotate`/`scale`/`matrix` are skipped and the detail says how many.
3. **title_and_labels** - a non-empty `<title>` directly under `<svg>` and at least 3 non-empty `<text>` elements.
4. **has_animation** - SMIL (`animate`, `animateTransform`, `animateMotion`, `set`) or CSS `@keyframes` that an element actually uses.
5. **safe_content** (my own check) - rejects `<script>`, `on*` attributes, `<foreignObject>`, `<image>`, `<iframe>` and any non-`#` `href`. Reason: the page displays model output, so it must not be able to run code or load other sites. The page also shows diagrams through `<img>`, which blocks scripts anyway (two layers).

### Cost numbers

Free-tier calls cost $0. The "cost" shown is an **estimate at the paid list price** for Gemini 3.5 Flash-Lite: $0.30 per 1M input tokens and $2.50 per 1M output tokens (from ai.google.dev/pricing, checked 24 Nov 2026). If you change the model, set `PRICE_INPUT_PER_M` and `PRICE_OUTPUT_PER_M`.

### Where Approve / Reject is saved, and why

**A JSON file on the server (`data/reviews.json`), plus a copy in the browser's localStorage.**

- The server file is shared: a reviewer on another computer sees the same decisions.
- Free hosts (Render free) wipe the disk when the service restarts or sleeps. The localStorage copy covers that gap for the same browser: on load, the page merges the server file with the local copy.
- I did not use a database because this is 5 rows and a database adds setup for no gain. Next step if this were real: Postgres or SQLite on a persistent disk.

### Live "Generate" button

Runs the same pipeline for one concept and shows the result in that row marked `live`. It does **not** overwrite `results.json`, so the 5 saved results stay stable. If the API fails, the row shows the reason (rate limit, overloaded, bad key, no key set). It allows one run at a time and 20 per hour (`GENERATE_LIMIT_PER_HOUR`) so a visitor cannot use up the free quota.

## Deploy (Render, free)

1. Push this repo to GitHub (the `.gitignore` already excludes `.env` and `node_modules`).
2. Render, New, Web Service, pick the repo. `render.yaml` sets the build and start commands.
3. In Render's Environment tab, add `GEMINI_API_KEY`. Never put it in the code or the repo.
4. Open the link. The 5 saved results show without any API call.

## Results

<!-- Run `npm run generate` then `npm run table` and paste the output here. -->

> TODO: paste the table from `npm run table`.

## What failed, and how I fixed it

Problems I hit while building (real, found by the unit tests):

- **XML parser API changed.** `@xmldom/xmldom` 0.9 ignores the old `errorHandler` option, so every SVG looked "unparseable". Switched to `onError(level, message)`. A test that expects a good SVG to pass caught it.
- **Missing `xmlns` slipped through.** The parser added the SVG namespace itself, so a model that forgot `xmlns` passed check 1, but browsers will not draw such an SVG in an `<img>`. Check 1 now reads the attribute directly.
- **A wrong test.** My "translated group is outside the viewBox" test moved a circle by 300 and it still fit; I changed it to 400.

Problems with the model's output:

> TODO: after running `npm run generate`, write what actually failed for each concept (look at `firstAttemptChecks` in `results.json`) and whether the retry fixed it. Do not guess; copy it from the log.

## What I would do with one more day

- Render each SVG in a headless browser and compare screenshots, to catch overlapping labels and text that runs past its box. My viewBox check can only see text anchor points, not text width.
- Check animation more deeply: that the SVG changes between two frames, not just that an animation tag exists.
- Use Gemini's JSON/structured output to separate the SVG from any chatter, and test several models side by side on cost and pass rate.
- Move reviews to a real database and add reviewer names.
- Run the 5 concepts several times each to measure how often the first attempt passes, instead of one run.

## AI tools used

- **Claude** - helped write the first version of the code, the unit tests and this README. I read through all of it and can explain it.
- **Gemini 3.5 Flash-Lite** - the model the app calls to draw the diagrams (it is the product, not a coding aid).

> Edit this section so it is true for you.
