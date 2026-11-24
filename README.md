# Science Diagram Maker

Udhi Technologies home assignment. A small Node/Express app that asks a free Gemini model for five animated SVG science diagrams, validates every SVG with real code, saves the results, and lets a reviewer approve or reject each one.

- **Live app:** _to be added after deployment_ (see [Deploy](#deploy))
- **GitHub repo:** _to be added after the first push_
- **Model:** `gemini-3.5-flash-lite` (free tier). Change with `GEMINI_MODEL`.
- **Stack:** Node 20+, Express, plain HTML/CSS/JS, `@xmldom/xmldom`, Gemini REST API.

## How to run it on your computer

```bash
npm install
cp .env.example .env        # Windows: copy .env.example .env
# edit .env and put your free key from https://aistudio.google.com/api-keys in GEMINI_API_KEY
npm run generate            # Part A: up to 10 model calls -> results.json
npm start                   # Part B: http://localhost:3000
npm test                    # 17 unit tests, no key or network needed
npm run table               # prints the results table below
```

`npm run generate -- 3 4` re-runs only concepts 3 and 4 and keeps the other saved rows. The npm scripts use Node's built-in `--env-file-if-exists=.env` (Node 22.9+), so the key in `.env` is loaded automatically on Windows and Linux — no `export` needed. `.env` is in `.gitignore` and never goes to GitHub or the browser.

## How it works

| File | Job |
|------|-----|
| `src/concepts.js` | The 5 concepts, with the model text copied word for word from the PDF |
| `src/gemini.js` | One `fetch` call to Gemini; retries 429/503 up to 3 times with backoff; counts tokens; estimates cost |
| `src/validate.js` | The 5 code checks |
| `src/generate.js` | Model call → checks → one retry with the exact failure reasons → result record |
| `src/server.js` | Serves saved results, saves reviews, runs live generation for one concept |
| `public/index.html`, `public/styles.css`, `public/app.js` | Review studio UI: table, full-view modal, filters, stats, live Generate, approve/reject |
| `scripts/generate-all.js` | Writes `results.json` after every concept so a crash cannot lose finished work |

### The 6 checks

1. **parses** — well-formed XML, `<svg>` root, and an explicit `xmlns` (browsers will not draw an SVG in `<img>` without it).
2. **inside_viewbox** — needs a valid `viewBox`; checks rect, circle, ellipse, line, polygon, polyline, path and text anchors. Text width is estimated from font size, and translate/rotate/scale/matrix/skew transforms are applied to bounding boxes, so clipped labels are caught.
3. **title_and_labels** — a non-empty `<title>` directly under `<svg>` and at least 3 non-empty `<text>` labels.
4. **has_animation** — SMIL (`animate`, `animateTransform`, `animateMotion`, `set`) or CSS `@keyframes` that an element actually uses.
5. **safe_content** (my own check) — rejects `<script>`, event attributes, `<foreignObject>`, `<image>`, `<iframe>`, external links/fonts and external CSS. The UI also renders every SVG inside an `<img>` data URL, so model output cannot run code on the page.
6. **plain_text_labels** (my second own check) — rejects literal `$`, LaTeX commands/braces/subscripts in labels and titles. GCSE slides should say `a² + b² = c²` and `V₁`, not `$V_{total}$`.

If a check fails, the model is called **once more** with the failing check names and details. Both attempts' token counts are added to the logged cost. If it still fails, the failure is saved honestly rather than hidden.

### Cost numbers

Free-tier calls cost $0. The displayed cost is an **estimate at paid list price** for Gemini 3.5 Flash-Lite: $0.30 per 1M input tokens and $2.50 per 1M output tokens (including thinking tokens), from `ai.google.dev/pricing`. Override with `PRICE_INPUT_PER_M` / `PRICE_OUTPUT_PER_M` if you change model.

### Where Approve / Reject is saved, and why

**A JSON file on the server (`data/reviews.json`) plus a copy in the browser's localStorage.**

- The server file is shared: another reviewer sees the same decision.
- Render's free tier can wipe the disk on restart/sleep. On load, the page merges the server file with the browser copy so a refresh in the same browser never loses a decision.
- A database would add setup for five rows; if this were a real product I would move to SQLite/Postgres with reviewer names and history.

### Live Generate button

Runs the same Part A pipeline for one concept and shows the result in that row marked `live`. It does **not** overwrite `results.json`, so the five saved results stay stable. Errors are shown in the row and in a banner (rate limit, overloaded, bad key, no key, offline). One run at a time, 20 per hour per visitor (`GENERATE_LIMIT_PER_HOUR`) and 100 per hour globally (`GENERATE_GLOBAL_LIMIT_PER_HOUR`) protect the free quota.

## Results

Generated with `gemini-3.5-flash-lite`. `npm run table` prints this table from `results.json`:

| # | Concept | Result | Failed checks (final) | Cost (USD, est.) | Retries | Tokens in/out |
|---|---------|--------|-----------------------|------------------|---------|---------------|
| 1 | Pythagoras' theorem | PASS | – | $0.01289 | 1 | 3539/4733 |
| 2 | Parts of a circle | PASS | – | $0.00961 | 1 | 2566/3535 |
| 3 | Series circuit | PASS | – | $0.00621 | 0 | 344/2441 |
| 4 | Photosynthesis | PASS | – | $0.00850 | 0 | 336/3358 |
| 5 | States of matter | PASS | – | $0.00884 | 0 | 350/3493 |

**Total estimated cost: $0.04604.** All five final SVGs pass all five checks. Concepts 1 and 2 needed one check-failure retry; 3–5 passed on the first call. No 429/503 API waits were needed in this run.

## What failed, and how I fixed it

Problems found by the **unit tests while building** (real, not guessed):

- `@xmldom/xmldom` 0.9 ignores the old `errorHandler` option, so every SVG looked unparseable. Switched to `onError(level, message)`; a test with a known-good SVG caught it.
- The parser adds the SVG namespace itself, so an SVG missing `xmlns` passed check 1 but would not render in `<img>`. Check 1 now reads the raw attribute.
- A viewBox test moved a circle by 300, which still fitted; changed it to 400 so it actually tests the boundary.

Problems with the **model output**, copied from `firstAttemptChecks` in `results.json`:

- **Concept 1:** first attempt had `<rect> spans x 150..300, y 360..510` outside `viewBox="0 0 800 500"`. Check `inside_viewbox` failed; the retry with that exact message produced a diagram inside the viewBox. PASS after 1 retry.
- **Concept 2:** first attempt was flagged `unsafe or external content: external CSS reference`. Check `safe_content` failed; the retry removed it. PASS after 1 retry.
- Concepts 3–5 passed on the first call.

## What I would do with one more day

- Render each SVG in a headless browser and compare screenshots to catch overlapping labels and text wider than its box. The viewBox check only sees text anchor points, not glyph widths.
- Prove the animation actually changes the picture between two frames, rather than trusting an animation tag.
- Add a "plain-text labels" check for literal LaTeX (`$I$`, `V_{total}`) and re-generate until GCSE-friendly Unicode is used everywhere.
- Use structured output to separate SVG from chatter, test several free models side by side, and run each concept several times to measure pass rate.
- Move reviews to a real database with reviewer names and an audit trail.

## AI tools used

- **Gemini 3.5 Flash-Lite** — the product model that drew the five diagrams.
- **An AI coding assistant (OpenCode agent)** — helped build the validation pipeline, the review UI and this README. I read every file and can explain and change any line on the call.
- No other AI tools were used for the final code.

## Deploy

Free hosting with Render (a `render.yaml` is included):

1. Push this repo to GitHub (`.gitignore` already excludes `.env`, `node_modules` and `data/`).
2. Render → New → Web Service → pick the repo. The blueprint sets `npm install` / `npm start`, Node 22 and the model name.
3. In Render's Environment tab add `GEMINI_API_KEY` as a secret. **Never put the key in code or commit it.**
4. Open the service URL. The five saved results show immediately with no model call; only pressing Generate uses the key.

The same app also runs on Vercel (as a Node service), Hugging Face Spaces (Docker/Node SDK) or any host that runs `npm start`.
