// two-video-compare.ts
// Minimal HTTP service: POST /compare2
// One-shot compare for two TikTok videos (URL version)
// Pipeline: validate -> yt-dlp metadata -> download cache -> ffmpeg sanitize -> Gemini Files upload
// -> single model call with both videos -> strict Zod parse -> 5 Tabs JSON

import http from 'node:http';
import { mkdir, stat, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import YTDlpWrap from 'yt-dlp-wrap';
import ffmpegPathRaw from 'ffmpeg-static';
import { z } from 'zod';
import { GoogleGenerativeAI, type GenerateContentResult } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { scheduleASR, readTranscriptIfExists } from './src/lib/asr';
import { exec as _exec } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(_exec);

// -------------------- Env & Defaults --------------------
const API_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY || '';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 90000);
const VIDEO_CACHE_DIR = process.env.VIDEO_CACHE_DIR || '/var/tmp/video-cache';
const PORT = Number(process.env.PORT || 5050);
const MODEL_ID = 'gemini-2.5-pro';
const MAX_SIZE = 50 * 1024 * 1024; // 50MB
const YT_DLP_TIMEOUT = Number(process.env.YT_DLP_TIMEOUT || 60000); // 60s default timeout for yt-dlp operations
const YT_DLP_DOWNLOAD_TIMEOUT = Number(process.env.YT_DLP_DOWNLOAD_TIMEOUT || 120000); // 2min default for downloads
const YT_DLP_RETRIES = Number(process.env.YT_DLP_RETRIES || 3); // Number of retries for yt-dlp operations

// Multiple TikTok API endpoints to try as fallbacks
const TIKTOK_API_ENDPOINTS = [
  'api16-normal-c-useast1a.tiktokv.com',
  'api16-normal-c-useast2a.tiktokv.com',
  'api16-core-c-useast1a.tiktokv.com',
  'api19-normal-c-useast1a.tiktokv.com',
  'api22-normal-c-useast1a.tiktokv.com'
];

if (!API_KEY) {
  console.error('Missing GOOGLE_GENERATIVE_AI_API_KEY');
}

// -------------------- Schema & Prompt --------------------
const Grade = z.enum(['S', 'A', 'B', 'C', 'D']);
const TimelineItem = z.object({
  labelA: z.string().optional(),
  labelB: z.string().optional(),
  description: z.string(),
  severity: z.enum(['low', 'medium', 'high']),
  tip: z.string(),
});

const CompareSchema = z.object({
  summary: z.string(),
  perVideo: z.object({
    A: z.object({ score: z.number().int(), grade: Grade, highlights: z.array(z.string()), issues: z.array(z.string()) }),
    B: z.object({ score: z.number().int(), grade: Grade, highlights: z.array(z.string()), issues: z.array(z.string()) }),
  }),
  diff: z.array(z.string()),
  actions: z.tuple([z.string(), z.string(), z.string()]),
  timeline: z.array(TimelineItem).max(8),
  improvementSummary: z.string(),
}).passthrough();

const PROMPT_V1 = `You are a short-form video compare analyst for TikTok Shop creatives.
You will receive two videos: A and B. Compare them and produce actionable guidance.

Rules:
- Base conclusions ONLY on the videos. Neutral, specific, factual.
- Return STRICT JSON only. No markdown. No extra keys.

Return JSON with:
- summary (<=400 chars)
- perVideo: {
  A: { score: 0-100, grade: "S"|"A"|"B"|"C"|"D", highlights: string[], issues: string[] },
  B: { score: 0-100, grade: "S"|"A"|"B"|"C"|"D", highlights: string[], issues: string[] }
}
- diff: string[]  // key differences (hook, product display, trust, CTA, pacing, visuals)
- actions: string[3]  // exactly 3 immediate improvements
- timeline: up to 8 items { labelA?: string, labelB?: string, description: string,
  severity: "low"|"medium"|"high", tip: string }
- improvementSummary: string  // 5–10 sentences
Grades mapping: S ≥90, A 80–89, B 70–79, C 60–69, D <60.`;

// Standard v3 prompt (thicker output, still A emulates B). Keep camelCase output contract unchanged.
const PROMPT_V3 = `You are a TikTok Shop creative coach. Compare two videos: A (needs improvement) and B (pro reference). Your goal is to produce simple, clear, and highly actionable guidance so that A emulates B’s strengths in the next shoot.

STRICT OUTPUT — IMPORTANT
- Return ONLY JSON, no markdown or prose before/after, no code fences.
- Use EXACT camelCase keys and value types defined below. Do not add/remove keys.
- Scores are integers 0–100.
- Minimum content quality bars:
  - perVideo.A.highlights: 3–4 items; perVideo.A.issues: 3–4 items
  - perVideo.B.highlights: 3–4 items; perVideo.B.issues: 2–3 “tweaks” (fine‑tuning)
  - diff: 5–6 items; actions: exactly 3 items; timeline: exactly 5 items
  - Each description ≤160 chars; use short sentences and simple words
- Actions must apply ONLY to A. If B also needs fine‑tuning, put them under perVideo.B.issues and optionally flag in diff with [B-TWEAK].
- If unsure about a field, output "" or [] but do NOT omit keys.

A VS B ROLE (FIXED)
- Treat B as the gold standard. Do NOT suggest changes to B inside actions.
- For each difference, say: what B does well, what A lacks, and exactly how A should replicate it (wording, framing, timing, subtitle style, demo, CTA placement/phrasing).
- Anchor claims to visible evidence: time windows like “0–3s/3–10s”, on‑screen text (quote it), spoken phrases, or shot description.

SCORING FRAMEWORK (STRICT)
- Weights: Hook 40%, Product Display/Proof 25%, Trust/Credibility 20%, CTA 15%.
- Grade bands: S ≥90, A 80–89, B 70–79, C 60–69, D <60.
- Ceiling rules (fatal caps):
  - No clear hook in first 3s → max C
  - No product visible in first 5s → max B
  - Poor visuals/audio (blurry/low‑light/over‑gain) → max D
- Apply weights rigorously; weak hook rarely ≥B.

EVIDENCE & STYLE
- Use concise windows in labelA/labelB (e.g., “0–3s”, “3–10s”, “10–20s”, “20s+”).
- When possible, quote on‑screen text (“STOP scrolling”) or spoken lines.
- Simple language (10–18 words per sentence), imperative voice for tips and actions.

[BUILT‑IN KNOWLEDGE BASE — REFERENCE ONLY]
Do not output as separate fields. Use this to inform insights, diff, actions, and timeline only when evidence appears in the videos.
- Verbal hook types (examples):
  - Curiosity: “Just wait for it…”, “You won’t believe what happens next…”
  - Pain point: “I was wasting so much time on ___ so I got this…”, “Tell me I’m not the only one dealing with this…”
  - Urgency/Sale: “Back in stock but not for long!”, “Don’t buy ___ because right now you can get it for ___”
  - Social proof: “This is your sign to ___”, “I tried the viral ___ and here’s what they aren’t telling you…”
- On‑screen text hooks (examples):
  - “STOP scrolling. You need this.”, “Why is no one talking about this?!”, “This went viral for a REASON.”
- Main body (5–25s):
  - 35–45s total; focus on 1–2 selling points; each paired with a demo
  - Templates: “Look at this… + demo”, “Do you see how… + comparison”, “Watch what happens when…”
- CTA (25–30s) examples:
  - Soft: “I’ll put the link with the sale price in that orange cart!”
  - Urgency: “I don’t know how much longer the sale has…”, “Back in stock but not for long!”
- Visuals/Pacing:
  - Cut every 1–3s or add motion; avoid static 5s+
  - Captions ≥14px, high contrast; crop to subject; avoid tiny product in frame
- Market adaptation:
  - High saturation (fashion/beauty): visual differentiation > correctness
  - Low saturation (novelty/niche): product education > visual impact
- Pre‑publish checklist:
  - Hook ≤3s, ≤2 selling points, product clearly shown, CTA feels natural, audio/video quality sufficient

DIFF & ACTIONS
- diff (5–6 items): write concise differences; optionally prefix with [HOOK]/[PRODUCT]/[TRUST]/[CTA]/[VISUAL]. When it’s a fine‑tuning for B, prefix with [B-TWEAK]. Always explain why B outperforms A and how A should copy it.
- actions (exactly 3, for A only): each includes What + Where (time/shot) + How (wording/framing/subtitles/demo/CTA) + Why (expected effect). Cover at least one hook and one product/CTA improvement.

TIMELINE GUIDELINES
- Provide exactly 5 items to cover the story arc; use labelA/labelB windows (“0–3s”, “3–10s”, “10–20s”, “20s+”).
- severity: low / medium / high (use high only when it clearly hurts performance).
- description ≤160 chars; tip is a concrete fix for A inspired by B’s approach.

OUTPUT — RETURN EXACTLY THIS JSON (camelCase)
{
  "summary": "",
  "perVideo": {
    "A": { "score": 0, "grade": "S|A|B|C|D", "highlights": [], "issues": [] },
    "B": { "score": 0, "grade": "S|A|B|C|D", "highlights": [], "issues": [] }
  },
  "diff": ["", "", "", "", ""],
  "actions": ["", "", ""],
  "timeline": [
    { "labelA": "", "labelB": "", "description": "", "severity": "low|medium|high", "tip": "" }
  ],
  "improvementSummary": ""
}`;

// v4 prompt (replace with user-provided frozen prompt)
const PROMPT_V4 = `Role & Task
You are the TikTok Shop compare system.
Use exactly the two file inputs as “Video A” (to improve) and “Video B” (reference). Do not assume URLs or any external metadata.
Return ONLY valid JSON that matches the structure below. Use clear, easy-to-understand English (clarity over flourish).

Attach an evidence anchor to every specific claim or label using brackets:

time window [00:12–00:18]

shot/camera cue [close-up] [product-in-hand] [text-overlay] [screen-record]

subtitle quote [sub: "..."] (only if clearly visible)

Output JSON shape (keys and casing must match exactly)
{
  "summary": string,
  "perVideo": {
    "A": {
      "score": integer 0–100,
      "grade": "S"|"A"|"B"|"C"|"D",
      "highlights": string[],   // 3–4 items; each includes evidence [..]; may include a tiny fix if helpful
      "issues": string[]        // 3–4 items; each includes evidence [..]; may include a tiny fix if helpful
    },
    "B": {
      "score": integer 0–100,
      "grade": "S"|"A"|"B"|"C"|"D",
      "highlights": string[],
      "issues": string[]
    }
  },
  "diff": string[],             // 5–6 items; if a small change on B would close the gap, prefix with "[B-TWEAK]"
  "actions": string[],          // exactly 3 items; each must include: the concrete action + a mini example (oral line or on-screen text) + a short value reason
  "timeline": [                 // exactly 5 items
    {
      "labelA": string,         // what happens in A at that moment; include evidence [..]
      "labelB": string,         // what happens in B at that moment; include evidence [..]
      "description": string,    // what this difference means for performance
      "severity": "low"|"medium"|"high",
      "tip": string             // 1 specific adjustment creator can do now
    }
  ],
  "improvementSummary": string  // 8–12 full sentences; conversational; highlight strengths, call out issues, and give next steps
}


Fixed lengths & allowed sets

actions = exactly 3.

timeline = exactly 5.

diff = 5–6 items.

highlights = 3–4 for A and 3–4 for B.

issues = 3–4 for A and 3–4 for B.

severity ∈ {low, medium, high}; grade ∈ {S, A, B, C, D}; score ∈ integers 0–100.

No extra fields (except the optional _key_clips field described below when the environment flag is enabled).


Scoring rubric (make grading consistent)

score: whole number 0–100 reflecting likely watch-through + conversion.

grade bands: S (90–100), A (80–89), B (70–79), C (60–69), D (<60).

Hard ceiling rules (apply strictly):

No clear hook in the first 3 seconds → grade ≤ C.

No product shown in the first 3 seconds → grade ≤ B.

No CTA detected → include in issues as a critical gap and reflect in diff; grade ≤ C.

Very poor video/audio quality that harms comprehension → grade = D.

Scoring lens (guidance, not new fields):
Prioritize: hook strength (0–3s), product display clarity, creator credibility/naturalness, CTA clarity & motivating power.
Favor evidence density over adjectives; when in doubt, add a firm time window and a concrete cue.


Timeline guidance (use phase cues inside labels/descriptions)

Detect phase cues and reflect them inside labelA, labelB, and description:

Hook — stop-scroll moment, bold opening claim, punchy overlay like “STOP scrolling”.

Trust — demo, proof, brand mention, contrast (“before/after”, “with/without”).

Desire — benefits, feeling language, beauty shots, transformation.

CTA — spoken (“buy/link/cart/sale/grab/get yours/don’t miss/limited stock/tap”), or visual (orange cart, price overlay, hand pointing).

If no CTA exists, ensure the gap shows up in issues and diff, and propose a practical CTA in actions.


Field guides for stronger outputs

1) Hooks (opening 0–5s)

Curiosity (often boosts watch-through): “Just wait for it…”, “Do not get scammed…”, “This $10 item changed my life.”

Pain-point resonance (target specific frustration): “I was so tired of ___ so I got this.”, “Tell me I’m not the only one…”

Urgency / promo (supports conversion): “Back in stock but not for long!!”, “If you don’t see the cart, it’s sold out again!!”

Social proof (builds trust): “This is your sign to…”, “I tried the viral ___ and here’s the truth.”

On-screen hooks: “STOP scrolling. You need this.”, “This went viral for a REASON.”, “Everyone’s sleeping on this…”

2) Main body (≈5–25s)

Optimal total length: ~35–45 seconds.

Core rule: focus on 1–2 key selling points with a clear demo.

Useful phrasing:

“Look at this…” + demo

“Do you see how…” + comparison

“Watch what happens when…” + process

“It literally feels like…” / “You know that feeling when…”

3) CTA (≈25–30s)

Soft closing (gentle nudge): “I’ll drop the link in the orange cart for you.”

Urgent closing (scarcity/now): “I don’t know how much longer this sale lasts.”, “This has been out of stock for months!!”

(Use these only as inspiration to shape examples inside actions; do not copy verbatim.)


Actions (exactly 3 — immediately usable)

Each action must be a single string that contains three parts:

Concrete operation — what to change (move earlier, add overlay, cut fluff, reframe, reshoot, retime, re-record).

Mini example — a sample oral line or on-screen text that implements it.

Value reason — why this lifts performance (earlier clarity, stronger stopping power, cleaner demo contrast, clearer CTA, higher click intent).

Examples (format illustration only; do not hard-code):

“Open with a stronger promise; example oral: ‘Don’t get scammed on skincare!’; lifts stop-rate in first 3s.”

“Add overlay for legibility at [00:07–00:12]; example text: ‘Viral humidifier hack’; clarifies benefit mid-scroll.”

“Make CTA explicit in last 4s; example oral: ‘Link in the cart—grab it before it’s gone’; increases click intent.”

No strict word cap: be concise but fully specify the action so a creator can execute today.


Diff list (5–6 items)

State the most meaningful differences that drive performance gaps.

When a small change on B would close the gap, prefix with [B-TWEAK] and describe the micro-adjust.

Always attach an evidence window and cue when referencing a specific moment.


Evidence rules (apply everywhere)

Attach at least one [00:mm–ss] window per bullet or label.

Add [shot] or [sub: "..."] when visible; never invent subtitles.

If timing is unclear, pick the nearest reliable window and say [unclear shot] rather than hallucinating.


ImprovementSummary (8–12 sentences, friendly and specific)

Write as if advising a teammate. Use everyday words.

Include: 2–3 clear strengths, 2–3 concrete fixes, and what to try next (move the hook earlier, shorten the middle, sharpen demo contrast, make CTA explicit).

Do not list bullets; write a short flowing paragraph. Tie points to evidence windows where helpful.


Optional helper field for script generation (env-gated)

If the environment flag is enabled, provide a small helper field of key transcript clips for both videos:

Field name: _key_clips (OPTIONAL; omit entirely if you cannot extract any).

Shape:

"_key_clips": {
  "A": [
    { "at": "mm:ss–mm:ss", "shot": "close-up|macro|product-in-hand|text-overlay|screen-record", "sub": "visible subtitle or \"\"" }
  ],
  "B": [
    { "at": "mm:ss–mm:ss", "shot": "close-up|macro|product-in-hand|text-overlay|screen-record", "sub": "visible subtitle or \"\"" }
  ]
}


4–8 clips per video. Keep only the most script-worthy (hooks, key demos, benefits, CTA).

Keep "sub" empty if subtitles are not clearly visible; never invent lines.

This field is OPTIONAL and must not affect any required fields.


Strict-schema fallback (if you cannot add new top-level fields):

Append one line to the end of improvementSummary:

[KEY_CLIPS_JSON]: {"A":[...],"B":[...]}


where the JSON value follows the same shape and rules above. Do not change any other fields.


Final instruction

Keep keys and casing exactly as defined; do not add or omit required fields.

actions length must be exactly 3; timeline length must be exactly 5; diff must have 5–6 items; highlights/issues must have 3–4 each for both A and B.

Return ONLY the JSON object (no markdown fences, no extra text, no comments).`;

// Choose prompt version at runtime (default v3). Set COMPARE_PROMPT_VERSION=v1 or v4 to switch.
const PROMPT = process.env.COMPARE_PROMPT_VERSION === 'v1' ? PROMPT_V1 : (process.env.COMPARE_PROMPT_VERSION === 'v4' ? PROMPT_V4 : PROMPT_V3);

// -------------------- Types --------------------
type Side = { type: 'url'; value: string };
type Body = { A: Side; B: Side };

// -------------------- Utils --------------------
const TIKTOK_RE = /^https?:\/\/([a-z0-9-]+\.)*tiktok\.com\/.+/i;

function isValidTikTokUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!TIKTOK_RE.test(url)) return false;
    return true;
  } catch {
    return false;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('TIMEOUT')), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }).catch((e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

function hash(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex');
}

async function ensureDir(p: string) {
  if (!existsSync(p)) await mkdir(p, { recursive: true });
}

async function ensureYtDlpBinary(): Promise<string> {
  // 1) Explicit path from env
  if (process.env.YT_DLP_PATH && process.env.YT_DLP_PATH.trim()) {
    console.log(`[compare] using yt-dlp from env: ${process.env.YT_DLP_PATH}`);
    return process.env.YT_DLP_PATH.trim();
  }
  // 2) Common system paths
  const common = ['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp'];
  for (const p of common) {
    if (existsSync(p)) {
      console.log(`[compare] using yt-dlp from common path: ${p}`);
      return p;
    }
  }
  // 3) PATH
  try {
    await exec('yt-dlp --version');
    console.log('[compare] using yt-dlp from PATH');
    return 'yt-dlp';
  } catch {
    throw new Error('yt-dlp_not_found');
  }
}

async function ytMetadata(url: string, retries = YT_DLP_RETRIES): Promise<any> {
  const bin = await ensureYtDlpBinary();
  const ytw = new YTDlpWrap(bin);

  let lastError: any;
  let endpointIndex = 0;

  for (let attempt = 1; attempt <= retries; attempt++) {
    // Rotate through different API endpoints on retries
    const apiEndpoint = TIKTOK_API_ENDPOINTS[endpointIndex % TIKTOK_API_ENDPOINTS.length];
    endpointIndex++;

    // TikTok-specific parameters for better compatibility
    const params = [
      url,
      '--dump-single-json',
      '--no-warnings',
      '--referer', 'https://www.tiktok.com/',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '--socket-timeout', '30',  // 30 seconds timeout for network operations
      '--retries', '3',  // yt-dlp internal retries
      '--retry-sleep', '2',  // Sleep 2 seconds between retries
      '--no-check-certificate',  // Sometimes helps with TLS issues
      '--extractor-args', `tiktok:api_hostname=${apiEndpoint}`  // Use rotating API endpoint
    ];

    try {
      console.log(`[ytMetadata] Attempt ${attempt}/${retries} for URL: ${url} (using ${apiEndpoint})`);
      const json = await withTimeout(
        ytw.execPromise(params),
        YT_DLP_TIMEOUT
      );
      return JSON.parse(json);
    } catch (error: any) {
      lastError = error;
      console.error(`[ytMetadata] Attempt ${attempt} failed with ${apiEndpoint}:`, error?.message || error);

      if (attempt < retries) {
        // Wait with exponential backoff before retry
        const waitTime = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        console.log(`[ytMetadata] Waiting ${waitTime}ms before retry with different endpoint...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }

  console.error('[ytMetadata] All attempts failed for URL:', url);
  throw lastError;
}

function getEstimatedSize(meta: any): number | null {
  const n = Number(meta?.filesize ?? meta?.filesize_approx);
  return Number.isFinite(n) ? n : null;
}

async function ytDownload(url: string, outPath: string, retries = YT_DLP_RETRIES): Promise<void> {
  const bin = await ensureYtDlpBinary();
  const ytw = new YTDlpWrap(bin);

  let lastError: any;
  let endpointIndex = 0;

  for (let attempt = 1; attempt <= retries; attempt++) {
    // Rotate through different API endpoints on retries
    const apiEndpoint = TIKTOK_API_ENDPOINTS[endpointIndex % TIKTOK_API_ENDPOINTS.length];
    endpointIndex++;

    // Enhanced parameters for TikTok download
    const params = [
      url,
      '--no-warnings',
      '--referer', 'https://www.tiktok.com/',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '-f', 'mp4/best[ext=mp4]/best',  // Prefer mp4, fallback to best available
      '-o', outPath,
      '--socket-timeout', '30',
      '--retries', '3',
      '--retry-sleep', '2',
      '--no-check-certificate',
      '--extractor-args', `tiktok:api_hostname=${apiEndpoint}`
    ];

    try {
      console.log(`[ytDownload] Attempt ${attempt}/${retries} for URL: ${url} (using ${apiEndpoint})`);
      await withTimeout(
        ytw.execPromise(params),
        YT_DLP_DOWNLOAD_TIMEOUT
      );
      console.log(`[ytDownload] Successfully downloaded: ${url}`);
      return;
    } catch (error: any) {
      lastError = error;
      console.error(`[ytDownload] Attempt ${attempt} failed with ${apiEndpoint}:`, error?.message || error);

      if (attempt < retries) {
        const waitTime = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        console.log(`[ytDownload] Waiting ${waitTime}ms before retry with different endpoint...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }

  console.error('[ytDownload] All download attempts failed for URL:', url);
  throw lastError;
}

async function sanitize(input: string, output: string): Promise<void> {
  const FFMPEG_BIN = process.env.FFMPEG_PATH || (ffmpegPathRaw as any as string) || 'ffmpeg';
  const cmd = `${shellSafe(FFMPEG_BIN)} -y -i ${shellSafe(input)} -map 0:v:0 -map 0:a:0? -dn -sn -map_chapters -1 -c copy -map_metadata -1 -movflags +faststart ${shellSafe(output)}`;
  await exec(cmd);
}

function shellSafe(p: string) {
  return `'${p.replaceAll("'", "'\\''")}'`;
}

function parseJsonStrict(text: string) {
  // strip markdown code fences if present
  const t = text.trim().replace(/^```json\n|^```/i, '').replace(/```$/i, '').trim();
  return JSON.parse(t);
}

// Minimal retry for transient 5xx/timeout during model call
async function withRetry<T>(fn: () => Promise<T>, retries = 2, base = 1.6, label = 'op'): Promise<T> {
  let lastErr: any;
  for (let i = 0; i <= retries; i++) {
    const attempt = i + 1;
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || e);
      const status = (e as any)?.status as number | undefined;
      const retryable = /5\d\d/.test(msg) || /Service Unavailable|temporarily|unavailable|timeout|timed out|aborted/i.test(msg) || (typeof status === 'number' && status >= 500);
      if (attempt <= retries && retryable) {
        const jitter = Math.random() * 300;
        const delay = Math.min(1000 * Math.pow(base, i) + jitter, 8000);
        console.log(`[v1] retry ${attempt}/${retries} for ${label} after ${Math.round(delay)}ms (msg: ${msg.split('\n')[0]})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// -------------------- Gemini Setup --------------------
const genAI = new GoogleGenerativeAI(API_KEY);
const fileManager = new GoogleAIFileManager(API_KEY);

async function uploadFileToGemini(filePath: string, mimeType = 'video/mp4') {
  const up = await fileManager.uploadFile(filePath, { mimeType });
  
  // Wait for file to be in ACTIVE state
  let file = up.file;
  while (file.state === 'PROCESSING') {
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
    file = await fileManager.getFile(file.name);
  }
  
  if (file.state !== 'ACTIVE') {
    throw new Error(`File upload failed with state: ${file.state}`);
  }
  
  return { uri: file.uri, mimeType: file.mimeType };
}

async function callModel(fileA: { uri: string; mimeType: string }, fileB: { uri: string; mimeType: string }) {
  const model = genAI.getGenerativeModel({ model: MODEL_ID, generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } });
  const res: GenerateContentResult = await model.generateContent([
    { text: PROMPT },
    { fileData: { fileUri: fileA.uri, mimeType: fileA.mimeType || 'video/mp4' } },
    { fileData: { fileUri: fileB.uri, mimeType: fileB.mimeType || 'video/mp4' } },
  ]);
  return res.response.text();
}

// -------------------- Core Handler --------------------
async function handleCompare(body: Body) {
  const t0 = Date.now();
  const log: Record<string, number> = {};
  try {
    // 1) validate
    if (body?.A?.type !== 'url' || body?.B?.type !== 'url') {
      return { success: false, errorCode: 'UNKNOWN', message: 'Only URL type is supported for now' };
    }
    const urlA = String(body.A.value || '');
    const urlB = String(body.B.value || '');
    if (!isValidTikTokUrl(urlA) || !isValidTikTokUrl(urlB)) {
      return { success: false, errorCode: 'INVALID_URL', message: 'Only tiktok.com links are supported' };
    }

    await ensureDir(VIDEO_CACHE_DIR);
    const tokenA = hash(urlA);
    const tokenB = hash(urlB);
    const rawA = join(VIDEO_CACHE_DIR, `${tokenA}.raw.mp4`);
    const rawB = join(VIDEO_CACHE_DIR, `${tokenB}.raw.mp4`);
    const sanA = join(VIDEO_CACHE_DIR, `${tokenA}.san.mp4`);
    const sanB = join(VIDEO_CACHE_DIR, `${tokenB}.san.mp4`);

    // 2) metadata + size guard
    const meta0 = Date.now();
    let mA: any, mB: any;
    try {
      [mA, mB] = await Promise.all([ytMetadata(urlA), ytMetadata(urlB)]);
    } catch (error: any) {
      const errorMsg = error?.message || String(error);
      if (errorMsg.includes('timed out') || errorMsg.includes('TIMEOUT')) {
        return {
          success: false,
          errorCode: 'TIKTOK_BLOCKED',
          message: 'Unable to fetch TikTok videos. The service might be temporarily blocked or rate-limited. Please try again later or use a different video.'
        };
      }
      return {
        success: false,
        errorCode: 'FETCH_ERROR',
        message: `Failed to fetch video metadata: ${errorMsg}`
      };
    }
    log.metadataMs = Date.now() - meta0;
    const szA = getEstimatedSize(mA);
    const szB = getEstimatedSize(mB);
    if ((szA && szA > MAX_SIZE) || (szB && szB > MAX_SIZE)) {
      return { success: false, errorCode: 'TOO_LARGE', message: 'Estimated size exceeds 50MB' };
    }

    // 3) download if not cached
    const d0 = Date.now();
    try {
      if (!existsSync(rawA)) await ytDownload(urlA, rawA);
      if (!existsSync(rawB)) await ytDownload(urlB, rawB);
    } catch (error: any) {
      const errorMsg = error?.message || String(error);
      if (errorMsg.includes('timed out') || errorMsg.includes('TIMEOUT')) {
        return {
          success: false,
          errorCode: 'DOWNLOAD_TIMEOUT',
          message: 'Download timed out. TikTok may be blocking the request. Please try again later or use a different video.'
        };
      }
      return {
        success: false,
        errorCode: 'DOWNLOAD_ERROR',
        message: `Failed to download video: ${errorMsg}`
      };
    }
    log.downloadMs = Date.now() - d0;

    // 3.1) check actual size
    const [stA, stB] = await Promise.all([stat(rawA), stat(rawB)]);
    if (stA.size > MAX_SIZE || stB.size > MAX_SIZE) {
      return { success: false, errorCode: 'TOO_LARGE', message: 'Downloaded size exceeds 50MB' };
    }

    // 4) sanitize
    const s0 = Date.now();
    if (!existsSync(sanA)) await sanitize(rawA, sanA);
    if (!existsSync(sanB)) await sanitize(rawB, sanB);
    log.sanitizeMs = Date.now() - s0;

    // 4.1) Background ASR (optional via env)
    try {
      const wavA = join(VIDEO_CACHE_DIR, `${tokenA}.wav`);
      const wavB = join(VIDEO_CACHE_DIR, `${tokenB}.wav`);
      const txtA = join(VIDEO_CACHE_DIR, `${tokenA}.transcript.txt`);
      const txtB = join(VIDEO_CACHE_DIR, `${tokenB}.transcript.txt`);
      scheduleASR(sanA, wavA, txtA).catch(() => {});
      scheduleASR(sanB, wavB, txtB).catch(() => {});
    } catch {}

    // 5) upload to Gemini Files
    const u0 = Date.now();
    const [fA, fB] = await Promise.all([uploadFileToGemini(sanA), uploadFileToGemini(sanB)]);
    log.uploadMs = Date.now() - u0;

    // 6) single model call with both videos
    const c0 = Date.now();
    const text = await withTimeout(
      withRetry(() => callModel(fA, fB), 2, 1.8, 'generateContent'),
      REQUEST_TIMEOUT_MS
    );
    log.modelMs = Date.now() - c0;

    // 7) parse & validate
    const p0 = Date.now();
    let parsed: unknown;
    try {
      parsed = parseJsonStrict(text);
    } catch {
      return { success: false, errorCode: 'SCHEMA', message: 'Model returned non-JSON' };
    }
    const safe = CompareSchema.safeParse(parsed);
    log.parseMs = Date.now() - p0;
    const durationMs = Date.now() - t0;

    if (!safe.success) {
      return { success: false, errorCode: 'SCHEMA', message: safe.error.message };
    }

    // Try include transcripts if present
    let transcripts: any = undefined;
    try {
      const tA = await readTranscriptIfExists(join(VIDEO_CACHE_DIR, `${tokenA}.transcript.txt`));
      const tB = await readTranscriptIfExists(join(VIDEO_CACHE_DIR, `${tokenB}.transcript.txt`));
      if (tA || tB) transcripts = { A: tA || '', B: tB || '' };
    } catch {}

    return {
      success: true,
      model: MODEL_ID,
      durationMs,
      result: transcripts ? { ...safe.data, transcripts } : safe.data,
      _metrics: log,
    };
  } catch (e: any) {
    const msg = e?.message || String(e);
    const code = /TIMEOUT/i.test(msg)
      ? 'TIMEOUT'
      : /INVALID_URL|UNSUPPORTED_HOST/i.test(msg)
      ? 'INVALID_URL'
      : 'UNKNOWN';
    return { success: false, errorCode: code, message: msg };
  }
}

// -------------------- HTTP server --------------------
function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req
      .on('data', (c) => chunks.push(c))
      .on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve(raw ? JSON.parse(raw) : {});
        } catch (e) {
          reject(e);
        }
      })
      .on('error', reject);
  });
}

function indexHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Two-Video Compare (URL)</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica Neue, Arial; margin: 24px; color: #0f172a; }
    .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    label { font-size: 12px; color: #64748b; display: block; margin-bottom: 4px; }
    input[type=text] { width: 100%; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 14px; }
    button { padding: 10px 14px; border-radius: 8px; border: 1px solid #111827; background: #111827; color: white; cursor: pointer; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    .muted { color: #64748b; font-size: 12px; }
    .status { display: inline-flex; align-items: center; gap: 8px; padding: 6px 10px; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 13px; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    pre { max-height: 40vh; overflow: auto; background: #0b1220; color: #e2e8f0; padding: 12px; border-radius: 8px; font-size: 12px; }
    ul { margin: 6px 0; padding-left: 18px; }
    .tag { display: inline-block; padding: 2px 8px; border-radius: 999px; border:1px solid #94a3b8; font-size: 11px; color:#334155; }
  </style>
</head>
<body>
  <h1>Two-Video Compare (URL)</h1>
  <div class="card">
    <div class="row">
      <div>
        <label>Video A URL (tiktok.com)</label>
        <input id="urlA" type="text" placeholder="https://www.tiktok.com/@user/video/111" />
      </div>
      <div>
        <label>Video B URL (tiktok.com)</label>
        <input id="urlB" type="text" placeholder="https://www.tiktok.com/@user/video/222" />
      </div>
    </div>
    <div style="margin-top:12px; display:flex; gap:8px; align-items:center;">
      <button id="btn" onclick="run()">Compare</button>
      <span class="muted">Once clicked, server downloads, sanitizes, uploads, then calls Gemini once with both videos.</span>
    </div>
    <div id="bar" style="margin-top:10px; display:none;" class="status"></div>
  </div>

  <div class="card" id="res" style="display:none;">
    <div id="summary"></div>
    <div style="margin-top:12px;" class="grid2">
      <div>
        <h3>Video A</h3>
        <div id="pa"></div>
      </div>
      <div>
        <h3>Video B</h3>
        <div id="pb"></div>
      </div>
    </div>
    <div style="margin-top:12px;">
      <h3>Diff</h3>
      <ul id="diff"></ul>
    </div>
    <div style="margin-top:12px;">
      <h3>Actions</h3>
      <ul id="actions"></ul>
    </div>
    <div style="margin-top:12px;">
      <h3>Timeline</h3>
      <ul id="timeline"></ul>
    </div>
  </div>

  <div class="card" id="raw" style="display:none;">
    <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
      <span class="tag" id="model"></span>
      <span class="tag" id="dur"></span>
      <button onclick="copyJson()">Copy JSON</button>
      <button onclick="downloadJson()">Download</button>
    </div>
    <pre id="json"></pre>
  </div>

  <script>
    const bar = document.getElementById('bar');
    const btn = document.getElementById('btn');
    const urlA = document.getElementById('urlA');
    const urlB = document.getElementById('urlB');
    const resCard = document.getElementById('res');
    const rawCard = document.getElementById('raw');
    let lastJson = null;

    function setBar(msg) { bar.style.display = 'inline-flex'; bar.textContent = msg; }
    function clearBar() { bar.style.display = 'none'; bar.textContent=''; }

    async function run() {
      resCard.style.display = 'none'; rawCard.style.display='none';
      lastJson = null;
      btn.disabled = true; setBar('preparing…');
      try {
        const body = { A: { type:'url', value: urlA.value.trim() }, B: { type:'url', value: urlB.value.trim() } };
        setBar('downloading & sanitizing…');
        const r = await fetch('/compare2', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
        const j = await r.json();
        lastJson = j;
        if (!j.success) {
          setBar('error: ' + j.errorCode + (j.message? (' – ' + j.message) : ''));
          return;
        }
        clearBar();
        render(j);
      } catch(e) {
        setBar('error: ' + (e?.message || e));
      } finally {
        btn.disabled = false;
      }
    }

    function esc(s){return String(s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}

    function render(j){
      const r = j.result;
      document.getElementById('summary').innerHTML = '<h3>Summary</h3><p>' + esc(r.summary) + '</p>';
      document.getElementById('pa').innerHTML = \`Score: \${r.perVideo.A.score} (\${esc(r.perVideo.A.grade)})<br/>
        <b>Highlights</b><ul>\${r.perVideo.A.highlights.map(h=>'<li>'+esc(h)+'</li>').join('')}</ul>
        <b>Issues</b><ul>\${r.perVideo.A.issues.map(h=>'<li>'+esc(h)+'</li>').join('')}</ul>\`;
      document.getElementById('pb').innerHTML = \`Score: \${r.perVideo.B.score} (\${esc(r.perVideo.B.grade)})<br/>
        <b>Highlights</b><ul>\${r.perVideo.B.highlights.map(h=>'<li>'+esc(h)+'</li>').join('')}</ul>
        <b>Issues</b><ul>\${r.perVideo.B.issues.map(h=>'<li>'+esc(h)+'</li>').join('')}</ul>\`;
      document.getElementById('diff').innerHTML = r.diff.map(d=>'<li>'+esc(d)+'</li>').join('');
      document.getElementById('actions').innerHTML = r.actions.map(a=>'<li>'+esc(a)+'</li>').join('');
      document.getElementById('timeline').innerHTML = r.timeline.map(t=>'<li>'+esc(t.labelA||'')+' | '+esc(t.labelB||'')+': '+esc(t.description)+' ['+esc(t.severity)+'] tip: '+esc(t.tip)+'</li>').join('');
      resCard.style.display = 'block';

      document.getElementById('model').textContent = 'model: ' + (j.model||'');
      document.getElementById('dur').textContent = 'durationMs: ' + (j.durationMs||'');
      document.getElementById('json').textContent = JSON.stringify(j, null, 2);
      rawCard.style.display = 'block';
    }

    function copyJson(){ if(!lastJson) return; navigator.clipboard.writeText(JSON.stringify(lastJson,null,2)); }
    function downloadJson(){ if(!lastJson) return; const blob = new Blob([JSON.stringify(lastJson,null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='compare.json'; a.click(); URL.revokeObjectURL(a.href); }
  </script>
</body>
</html>`;
}

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function applyCors(req: http.IncomingMessage, res: http.ServerResponse) {
  const origin = (req.headers['origin'] as string) || '';
  const allow = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin) ? origin || '*' : '*';
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method === 'GET' && req.url === '/') {
    const html = indexHtml();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
    return;
  }
  if (req.method === 'POST' && req.url === '/compare2') {
    try {
      const body = (await readJson(req)) as Body;
      const out = await handleCompare(body);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(out));
    } catch (e: any) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: false, errorCode: 'UNKNOWN', message: e?.message || String(e) }));
    }
    return;
  }
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ success: false, errorCode: 'UNKNOWN', message: 'Not found' }));
});

server.listen(PORT, async () => {
  await ensureDir(VIDEO_CACHE_DIR);
  console.log(`[two-video-compare] Listening on http://localhost:${PORT}`);
});
