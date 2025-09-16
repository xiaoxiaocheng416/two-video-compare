// two-video-compare-v2.ts
// Enhanced HTTP service with FAB-based prompt and strict validation
// Implements the full TikTok Shop Video Compare prompt with built-in knowledge base

import http from 'node:http';
import { mkdir, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
const ytdlpExec = require('yt-dlp-exec');
const ytdlp = process.env.YT_DLP_PATH ? ytdlpExec.create(process.env.YT_DLP_PATH) : ytdlpExec;
import { z } from 'zod';
import { GoogleGenerativeAI, type GenerateContentResult } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { exec as _exec } from 'node:child_process';
import ffmpegPathRaw from 'ffmpeg-static';
import { promisify } from 'node:util';

const exec = promisify(_exec);

// -------------------- Env & Defaults --------------------
const API_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY || '';
const REQUEST_TIMEOUT_MS = 120000; // 120s for all internal operations
const VIDEO_CACHE_DIR = process.env.VIDEO_CACHE_DIR || '/var/tmp/video-cache';
const PORT = Number(process.env.PORT || 5052); // Different port for v2
const MODEL_ID = 'gemini-2.5-pro';
const MAX_SIZE = 50 * 1024 * 1024; // 50MB
const PROMPT_VERSION = 'v2-fab-20250113';

if (!API_KEY) {
  console.error('Missing GOOGLE_GENERATIVE_AI_API_KEY');
}

// -------------------- Snake Case Schemas (Model Output) --------------------
const GradeSnake = z.enum(['S', 'A', 'B', 'C', 'D']);
const SeveritySnake = z.enum(['low', 'medium', 'high', 'critical']);
const PhaseSnake = z.enum(['hook', 'trust', 'desire', 'cta']);
const AspectSnake = z.enum(['hook', 'trust', 'cta', 'visual', 'product_display']);
const PillarSnake = z.enum(['hook', 'product_display', 'trust', 'cta']);

const VideoScoreSnake = z.object({
  score: z.number().int().min(0).max(100),
  grade: GradeSnake,
  highlights: z.array(z.string()),
  issues: z.array(z.string()),
});

const TimelineVideoSnake = z.object({
  t: z.string(),
  phase: PhaseSnake,
  score: z.number().int().min(0).max(100),
  spoken_excerpt: z.string(),
  screen_text: z.string(),
  visual_cue: z.string(),
  severity: SeveritySnake,
  pillar_contrib: PillarSnake,
  issue: z.string(),
  fix_hint: z.string(),
});

const TimelineGapSnake = z.object({
  aspect: AspectSnake,
  severity: SeveritySnake,
  hint: z.string(),
});

const TimelineItemSnake = z.object({
  A: TimelineVideoSnake,
  B: TimelineVideoSnake,
  gap: TimelineGapSnake,
});

const DiffItemSnake = z.object({
  aspect: AspectSnake,
  note: z.string(),
});

const CompareOutputSnake = z.object({
  summary: z.string(),
  per_video: z.object({
    A: VideoScoreSnake,
    B: VideoScoreSnake,
  }),
  diff: z.array(DiffItemSnake),
  actions: z.array(z.string()).length(3),
  timeline: z.array(TimelineItemSnake).max(5), // Reduced from 8 to 5
  improvement_summary: z.string(),
});

// -------------------- UI Schemas (Frontend Contract) --------------------
const GradeUI = z.enum(['S', 'A', 'B', 'C', 'D']);
const SeverityUI = z.enum(['low', 'medium', 'high']);

const TimelineItemUI = z.object({
  labelA: z.string().optional(),
  labelB: z.string().optional(),
  description: z.string(),
  severity: SeverityUI,
  tip: z.string(),
});

const CompareSchemaUI = z.object({
  summary: z.string(),
  perVideo: z.object({
    A: z.object({ 
      score: z.number().int(), 
      grade: GradeUI, 
      highlights: z.array(z.string()), 
      issues: z.array(z.string()) 
    }),
    B: z.object({ 
      score: z.number().int(), 
      grade: GradeUI, 
      highlights: z.array(z.string()), 
      issues: z.array(z.string()) 
    }),
  }),
  diff: z.array(z.string()),
  actions: z.tuple([z.string(), z.string(), z.string()]),
  timeline: z.array(TimelineItemUI).max(8),
  improvementSummary: z.string(),
});

// -------------------- Types --------------------
type Side = { type: 'url'; value: string };
type Body = { 
  A: Side; 
  B: Side;
  fab?: {
    product_name?: string;
    features?: string[];
    advantages?: string[];
    benefits?: string[];
    note?: string | null;
  };
};

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

function withTimeout<T>(p: Promise<T>, ms: number, label?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`TIMEOUT${label ? ` (${label})` : ''}`)), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }).catch((e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

// Retry with exponential backoff for timeout/5xx errors
async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 2, // Increased from 1 to 2
  backoffMultiplier = 1.5,
  label?: string
): Promise<T> {
  let lastError: any;
  for (let i = 0; i <= retries; i++) {
    try {
      const startTime = Date.now();
      const result = await fn();
      if (i > 0) {
        console.log(`[v2] Retry ${i}/${retries} succeeded for ${label || 'operation'} in ${Date.now() - startTime}ms`);
      }
      return result;
    } catch (error: any) {
      lastError = error;
      const isRetryable = 
        error?.message?.includes('TIMEOUT') ||
        error?.message?.includes('503') ||
        error?.status >= 500;
      
      if (i < retries && isRetryable) {
        const jitter = Math.random() * 300; // 0-300ms random jitter
        const delay = Math.min(1000 * Math.pow(backoffMultiplier, i) + jitter, 10000);
        console.log(`[v2] Retry ${i + 1}/${retries} for ${label || 'operation'} after ${delay}ms (error: ${error?.message || error})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
  throw lastError;
}

// Helper to trim strings to max length
function trimString(str: string | null | undefined, maxLength: number): string | null {
  if (!str) return null;
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}

// Helper to trim FAB arrays
function trimFABArray(arr: string[] | undefined, maxItems: number, maxItemLength: number): string[] {
  if (!arr) return [];
  return arr.slice(0, maxItems).map(item => trimString(item, maxItemLength) || '');
}

function hash(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex');
}

async function ensureDir(p: string) {
  if (!existsSync(p)) await mkdir(p, { recursive: true });
}

async function ytMetadata(url: string): Promise<any> {
  const res = await ytdlp(url, { dumpSingleJson: true, noWarnings: true });
  return res as any;
}

function getEstimatedSize(meta: any): number | null {
  const n = Number(meta?.filesize ?? meta?.filesize_approx);
  return Number.isFinite(n) ? n : null;
}

async function ytDownload(url: string, outPath: string): Promise<void> {
  await ytdlp(url, {
    output: outPath,
    format: 'mp4',
    noWarnings: true,
  });
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
  // Be tolerant to code fences and leading/trailing prose
  const t = text.trim().replace(/^```json\n|^```/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      const candidate = t.slice(start, end + 1);
      return JSON.parse(candidate);
    }
    throw new Error('NON_JSON');
  }
}

// -------------------- Prompt Loading --------------------
let CACHED_PROMPT: string | null = null;
let PROMPT_CACHE_TIME = 0;
const PROMPT_CACHE_TTL = 60000; // 1 minute cache

async function loadComparePrompt(): Promise<string> {
  const now = Date.now();
  if (CACHED_PROMPT && (now - PROMPT_CACHE_TIME) < PROMPT_CACHE_TTL) {
    return CACHED_PROMPT;
  }

  try {
    const content = await readFile('prompt.md', 'utf-8');
    // Prefer the frozen v4 block if present
    const lines = content.split('\n');
    const frozenIdx = lines.findIndex(line => line.includes('Compare v4 Frozen Prompt'));
    if (frozenIdx !== -1) {
      const prompt = lines.slice(frozenIdx + 1).join('\n').trim();
      console.log('[v2] Loaded frozen v4 prompt');
      CACHED_PROMPT = prompt;
      PROMPT_CACHE_TIME = now;
      return prompt;
    }

    // Fallback: extract legacy section between [TITLE] and [OUTPUT SHAPE]
    const titleIndex = lines.findIndex(line => line.includes('[TITLE]'));
    if (titleIndex !== -1) {
      const promptLines: string[] = [];
      let inPrompt = false;
      for (let i = titleIndex; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('[TITLE]')) { inPrompt = true; continue; }
        if (line.includes('[OUTPUT SHAPE')) break;
        if (inPrompt) promptLines.push(line);
      }
      const prompt = promptLines.join('\n').trim();
      console.log('[v2] Loaded legacy prompt');
      CACHED_PROMPT = prompt;
      PROMPT_CACHE_TIME = now;
      return prompt;
    }
  } catch (e) {
    console.error('Failed to load prompt from file, using fallback', e);
  }

  // Fallback to embedded prompt if file read fails
  return getFallbackPrompt();
}

function getFallbackPrompt(): string {
  return `You are a TikTok Shop coach. Compare Video A (to improve) vs Video B (Pro reference), using the confirmed FAB as ground truth.
STRICTLY RETURN JSON ONLY. Do not include prose, explanations, markdown, or code fences.
If unsure about any field, output "" or [] but DO NOT omit keys.

Identify clear differences in: hook (0–3s), product display/proof, trust/credibility, CTA clarity, visuals/pacing.
Produce concise, actionable recommendations tied to the provided FAB (features/advantages/benefits).

Scoring: Hook 40%, Product Display/Proof 25%, Trust/Credibility 20%, CTA 15%.
Grade bands: S=90–100, A=80–89, B=70–79, C=60–69, D<60.
Fatal rules: No hook within 3s → cap at C. Poor visuals → cap at D. No product within 5s → cap at B.

Return JSON with exact shape as specified.`;
}

// -------------------- Mapping Functions --------------------
function mapSnakeToUI(snakeData: z.infer<typeof CompareOutputSnake>): z.infer<typeof CompareSchemaUI> {
  return {
    summary: snakeData.summary,
    perVideo: {
      A: snakeData.per_video.A,
      B: snakeData.per_video.B,
    },
    diff: snakeData.diff.map(d => `[${d.aspect.toUpperCase()}] ${d.note}`),
    actions: snakeData.actions as [string, string, string],
    timeline: snakeData.timeline.map(item => ({
      // labelA/B: 优先 t (时间标签), 空时用 phase
      labelA: item.A.t || item.A.phase || undefined,
      labelB: item.B.t || item.B.phase || undefined,
      description: formatTimelineDescription(item),
      // severity: critical → high
      severity: item.gap.severity === 'critical' ? 'high' : item.gap.severity as 'low' | 'medium' | 'high',
      // tip: 优先 A.fix_hint, 其次 B.fix_hint, 再次 gap.hint
      tip: item.A.fix_hint || item.B.fix_hint || item.gap.hint,
    })),
    improvementSummary: snakeData.improvement_summary,
  };
}

function formatTimelineDescription(item: z.infer<typeof TimelineItemSnake>): string {
  // 优先级合成 (控制长度 ≤160)
  // 1. A.issue || B.issue
  // 2. [gap.aspect] gap.hint
  // 3. A/B spoken/screen 摘要
  
  if (item.A.issue || item.B.issue) {
    const issueText = item.A.issue && item.B.issue 
      ? `A: ${item.A.issue} | B: ${item.B.issue}`
      : item.A.issue || item.B.issue;
    return issueText.substring(0, 160);
  }
  
  if (item.gap.aspect && item.gap.hint) {
    return `[${item.gap.aspect.toUpperCase()}] ${item.gap.hint}`.substring(0, 160);
  }
  
  // Fallback: spoken/screen summary
  const parts: string[] = [];
  if (item.A.spoken_excerpt) parts.push(`A: "${item.A.spoken_excerpt.substring(0, 30)}..."`);
  if (item.B.spoken_excerpt) parts.push(`B: "${item.B.spoken_excerpt.substring(0, 30)}..."`);
  if (item.A.screen_text) parts.push(`Text: "${item.A.screen_text.substring(0, 30)}..."`);
  
  return parts.join(' • ').substring(0, 160) || 'Compare segment details';
}

// -------------------- Gemini Setup --------------------
const genAI = new GoogleGenerativeAI(API_KEY);
const fileManager = new GoogleAIFileManager(API_KEY);

async function uploadFileToGemini(filePath: string, mimeType = 'video/mp4') {
  const up = await fileManager.uploadFile(filePath, { mimeType });
  
  // Wait for file to be in ACTIVE state
  let file = up.file;
  while (file.state === 'PROCESSING') {
    await new Promise(resolve => setTimeout(resolve, 1000));
    file = await fileManager.getFile(file.name);
  }
  
  if (file.state !== 'ACTIVE') {
    throw new Error(`File upload failed with state: ${file.state}`);
  }
  
  return { uri: file.uri, mimeType: file.mimeType };
}

async function callModel(
  prompt: string,
  fileA: { uri: string; mimeType: string }, 
  fileB: { uri: string; mimeType: string },
  fabJson: any,
  videoAMeta: any,
  videoBMeta: any
) {
  // Trim FAB data
  const trimmedFAB = {
    product_name: trimString(fabJson.product_name, 100) || 'N/A',
    features: trimFABArray(fabJson.features, 5, 100),
    advantages: trimFABArray(fabJson.advantages, 5, 100),
    benefits: trimFABArray(fabJson.benefits, 5, 100),
    note: trimString(fabJson.note, 100),
  };
  
  // Trim video metadata
  const trimmedMetaA = {
    ...videoAMeta,
    title: trimString(videoAMeta.title, 200),
    desc: trimString(videoAMeta.desc, 300),
  };
  
  const trimmedMetaB = {
    ...videoBMeta,
    title: trimString(videoBMeta.title, 200),
    desc: trimString(videoBMeta.desc, 300),
  };
  
  // Inject FAB and video metadata into prompt
  const fullPrompt = `${prompt}

FAB_JSON:
${JSON.stringify(trimmedFAB, null, 2)}

VIDEO_A_META:
${JSON.stringify(trimmedMetaA, null, 2)}

VIDEO_B_META:
${JSON.stringify(trimmedMetaB, null, 2)}`;
  
  // Log prompt size
  const promptBytes = Buffer.byteLength(fullPrompt, 'utf8');
  console.log(`[v2] Prompt size: ${promptBytes} bytes (${Math.round(promptBytes / 1024)}KB)`);

  // Define response schema for structured output (Gemini-supported subset, shallow)
  const responseSchema = {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      per_video: {
        type: 'object',
        properties: {
          A: {
            type: 'object',
            properties: {
              score: { type: 'number' },
              grade: { type: 'string' },
              highlights: { type: 'array', items: { type: 'string' } },
              issues: { type: 'array', items: { type: 'string' } },
            },
            required: ['score', 'grade', 'highlights', 'issues'],
          },
          B: {
            type: 'object',
            properties: {
              score: { type: 'number' },
              grade: { type: 'string' },
              highlights: { type: 'array', items: { type: 'string' } },
              issues: { type: 'array', items: { type: 'string' } },
            },
            required: ['score', 'grade', 'highlights', 'issues'],
          },
        },
        required: ['A', 'B'],
      },
      diff: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            aspect: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['aspect', 'note'],
        },
      },
      actions: {
        type: 'array',
        items: { type: 'string' },
      },
      timeline: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            A: {
              type: 'object',
              properties: {
                t: { type: 'string' },
                phase: { type: 'string' },
                score: { type: 'number' },
                spoken_excerpt: { type: 'string' },
                screen_text: { type: 'string' },
                visual_cue: { type: 'string' },
                severity: { type: 'string' },
                pillar_contrib: { type: 'string' },
                issue: { type: 'string' },
                fix_hint: { type: 'string' },
              },
              required: ['t', 'phase', 'score', 'spoken_excerpt', 'screen_text', 'visual_cue', 'severity', 'pillar_contrib', 'issue', 'fix_hint'],
            },
            B: {
              type: 'object',
              properties: {
                t: { type: 'string' },
                phase: { type: 'string' },
                score: { type: 'number' },
                spoken_excerpt: { type: 'string' },
                screen_text: { type: 'string' },
                visual_cue: { type: 'string' },
                severity: { type: 'string' },
                pillar_contrib: { type: 'string' },
                issue: { type: 'string' },
                fix_hint: { type: 'string' },
              },
              required: ['t', 'phase', 'score', 'spoken_excerpt', 'screen_text', 'visual_cue', 'severity', 'pillar_contrib', 'issue', 'fix_hint'],
            },
            gap: {
              type: 'object',
              properties: {
                aspect: { type: 'string' },
                severity: { type: 'string' },
                hint: { type: 'string' },
              },
              required: ['aspect', 'severity', 'hint'],
            },
          },
          required: ['A', 'B', 'gap'],
        },
      },
      improvement_summary: { type: 'string' },
    },
    required: ['summary', 'per_video', 'diff', 'actions', 'timeline', 'improvement_summary'],
  } as const;

  const model = genAI.getGenerativeModel({ 
    model: MODEL_ID, 
    generationConfig: { 
      temperature: 0.2, 
      responseMimeType: 'application/json',
      responseSchema: responseSchema as any, // Type assertion for SDK compatibility
      maxOutputTokens: 2500, // Increased from 1400
    } 
  });
  
  const res: GenerateContentResult = await model.generateContent([
    { text: fullPrompt },
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
    // 1) Validate URLs
    if (body?.A?.type !== 'url' || body?.B?.type !== 'url') {
      return { success: false, errorCode: 'UNKNOWN', message: 'Only URL type is supported for now' };
    }
    
    const urlA = String(body.A.value || '');
    const urlB = String(body.B.value || '');
    
    if (!isValidTikTokUrl(urlA) || !isValidTikTokUrl(urlB)) {
      return { success: false, errorCode: 'INVALID_URL', message: 'Only tiktok.com links are supported' };
    }

    // 2) Prepare FAB (use minimal if not provided)
    const fabJson = body.fab || {
      product_name: 'N/A',
      features: [],
      advantages: [],
      benefits: [],
      note: null,
    };

    // 3) Setup cache paths
    await ensureDir(VIDEO_CACHE_DIR);
    const tokenA = hash(urlA);
    const tokenB = hash(urlB);
    const rawA = join(VIDEO_CACHE_DIR, `${tokenA}.raw.mp4`);
    const rawB = join(VIDEO_CACHE_DIR, `${tokenB}.raw.mp4`);
    const sanA = join(VIDEO_CACHE_DIR, `${tokenA}.san.mp4`);
    const sanB = join(VIDEO_CACHE_DIR, `${tokenB}.san.mp4`);

    // 4) Get metadata + size check
    const meta0 = Date.now();
    const [mA, mB] = await Promise.all([
      withRetry(() => ytMetadata(urlA), 1, 1.5, 'metadata A'),
      withRetry(() => ytMetadata(urlB), 1, 1.5, 'metadata B')
    ]);
    log.metadataMs = Date.now() - meta0;
    console.log(`[v2] Metadata fetched in ${log.metadataMs}ms`);
    
    const szA = getEstimatedSize(mA);
    const szB = getEstimatedSize(mB);
    if ((szA && szA > MAX_SIZE) || (szB && szB > MAX_SIZE)) {
      return { success: false, errorCode: 'TOO_LARGE', message: 'Estimated size exceeds 50MB' };
    }

    // Prepare video metadata for prompt
    const videoAMeta = {
      type: 'tiktok',
      urlOrFile: urlA,
      sizeMB: szA ? Math.round(szA / 1024 / 1024) : null,
      title: mA.title || null,
      desc: mA.description || null,
      userNotes: null,
    };

    const videoBMeta = {
      type: 'tiktok',
      urlOrFile: urlB,
      sizeMB: szB ? Math.round(szB / 1024 / 1024) : null,
      title: mB.title || null,
      desc: mB.description || null,
      userNotes: null,
    };

    // 5) Download if not cached
    const d0 = Date.now();
    const downloads: Promise<void>[] = [];
    if (!existsSync(rawA)) {
      console.log(`[v2] Downloading video A from ${urlA}`);
      downloads.push(withRetry(() => ytDownload(urlA, rawA), 1, 1.5, 'download A'));
    } else {
      console.log(`[v2] Video A already cached`);
    }
    if (!existsSync(rawB)) {
      console.log(`[v2] Downloading video B from ${urlB}`);
      downloads.push(withRetry(() => ytDownload(urlB, rawB), 1, 1.5, 'download B'));
    } else {
      console.log(`[v2] Video B already cached`);
    }
    await Promise.all(downloads);
    log.downloadMs = Date.now() - d0;
    console.log(`[v2] Download phase completed in ${log.downloadMs}ms`);

    // 6) Check actual size
    const [stA, stB] = await Promise.all([stat(rawA), stat(rawB)]);
    if (stA.size > MAX_SIZE || stB.size > MAX_SIZE) {
      return { success: false, errorCode: 'TOO_LARGE', message: 'Downloaded size exceeds 50MB' };
    }

    // 7) Sanitize (process)
    const s0 = Date.now();
    const processes: Promise<void>[] = [];
    if (!existsSync(sanA)) {
      console.log(`[v2] Processing video A`);
      processes.push(sanitize(rawA, sanA));
    } else {
      console.log(`[v2] Video A already processed`);
    }
    if (!existsSync(sanB)) {
      console.log(`[v2] Processing video B`);
      processes.push(sanitize(rawB, sanB));
    } else {
      console.log(`[v2] Video B already processed`);
    }
    await Promise.all(processes);
    log.processMs = log.sanitizeMs = Date.now() - s0;
    console.log(`[v2] Process phase completed in ${log.processMs}ms`);

    // 8) Upload to Gemini
    const u0 = Date.now();
    console.log(`[v2] Uploading videos to Gemini`);
    const [fA, fB] = await Promise.all([
      withRetry(() => uploadFileToGemini(sanA), 1, 1.5, 'upload A'),
      withRetry(() => uploadFileToGemini(sanB), 1, 1.5, 'upload B')
    ]);
    log.uploadToGeminiMs = log.uploadMs = Date.now() - u0;
    console.log(`[v2] Upload to Gemini completed in ${log.uploadToGeminiMs}ms`);

    // 9) Load prompt and call model (llmAnalyze)
    const prompt = await loadComparePrompt();
    const c0 = Date.now();
    console.log(`[v2] Calling Gemini model for analysis`);
    const text = await withTimeout(
      withRetry(
        () => callModel(prompt, fA, fB, fabJson, videoAMeta, videoBMeta),
        2, // Using updated retry count
        1.8, // Slightly higher backoff
        'model call'
      ),
      REQUEST_TIMEOUT_MS,
      'model analysis'
    );
    log.llmAnalyzeMs = log.modelMs = Date.now() - c0;
    console.log(`[v2] LLM analysis completed in ${log.llmAnalyzeMs}ms`);

    // 10) Parse and validate
    const p0 = Date.now();
    let parsed: unknown;
    try {
      parsed = parseJsonStrict(text);
    } catch {
      return { success: false, errorCode: 'SCHEMA', message: 'Model returned non-JSON' };
    }

    const snakeResult = CompareOutputSnake.safeParse(parsed);
    log.parseMs = Date.now() - p0;
    
    // Aggregate timing
    const aggregateMs = Date.now() - t0;
    log.aggregateMs = aggregateMs;
    const durationMs = aggregateMs;
    
    // Log all stage timings
    const timelineLength = snakeResult.success ? (snakeResult.data.timeline?.length || 0) : 0;
    console.log(`[v2] Stage timings:`, {
      metadataMs: log.metadataMs || 0,
      downloadMs: log.downloadMs || 0,
      processMs: log.processMs || 0,
      uploadToGeminiMs: log.uploadToGeminiMs || 0,
      llmAnalyzeMs: log.llmAnalyzeMs || 0,
      parseMs: log.parseMs || 0,
      aggregateMs: log.aggregateMs || 0,
      totalMs: durationMs,
      timelineLength,
    });

    if (!snakeResult.success) {
      return { 
        success: false, 
        errorCode: 'SCHEMA', 
        message: snakeResult.error.message,
        _raw: parsed, // Include raw for debugging
      };
    }

    // 11) Map to UI schema
    const uiResult = mapSnakeToUI(snakeResult.data);
    
    // Validate UI schema
    const uiValidation = CompareSchemaUI.safeParse(uiResult);
    if (!uiValidation.success) {
      return { 
        success: false, 
        errorCode: 'SCHEMA', 
        message: 'Mapping to UI schema failed: ' + uiValidation.error.message,
        _raw: snakeResult.data,
      };
    }

    return {
      success: true,
      model: MODEL_ID,
      promptVersion: PROMPT_VERSION,
      durationMs,
      result: uiValidation.data,
      _metrics: log,
      _raw: snakeResult.data, // Include original snake_case for debugging
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

// -------------------- HTTP Server --------------------
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
  <title>Two-Video Compare V2 (FAB-Enhanced)</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica Neue, Arial; margin: 24px; color: #0f172a; }
    .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    .badge { display: inline-block; padding: 4px 8px; background: #22c55e; color: white; border-radius: 4px; font-size: 12px; margin-left: 8px; }
    h1 { margin-bottom: 8px; }
    .subtitle { color: #64748b; margin-bottom: 24px; }
  </style>
</head>
<body>
  <h1>Two-Video Compare V2 <span class="badge">FAB-Enhanced</span></h1>
  <p class="subtitle">Enhanced with TikTok Shop knowledge base and FAB constraints</p>
  
  <div class="card">
    <h3>API Endpoint</h3>
    <code>POST /compare2</code>
    
    <h3 style="margin-top: 16px;">Features</h3>
    <ul>
      <li>✅ FAB-based analysis (Features/Advantages/Benefits)</li>
      <li>✅ Built-in TikTok Shop knowledge base</li>
      <li>✅ Strict scoring system (Hook 40%, Product 25%, Trust 20%, CTA 15%)</li>
      <li>✅ Timeline diagnosis with severity levels</li>
      <li>✅ Snake_case to camelCase mapping</li>
      <li>✅ Raw output preservation for debugging</li>
    </ul>
    
    <h3 style="margin-top: 16px;">Version</h3>
    <code>${PROMPT_VERSION}</code>
  </div>
  
  <div class="card">
    <h3>Usage</h3>
    <pre style="background: #f1f5f9; padding: 12px; border-radius: 8px; overflow-x: auto;">
curl -X POST http://localhost:${PORT}/compare2 \\
  -H "Content-Type: application/json" \\
  -d '{
    "A": {"type": "url", "value": "https://www.tiktok.com/@user/video/123"},
    "B": {"type": "url", "value": "https://www.tiktok.com/@user/video/456"},
    "fab": {
      "product_name": "Product Name",
      "features": ["Feature 1", "Feature 2"],
      "advantages": ["Advantage 1", "Advantage 2"],
      "benefits": ["Benefit 1", "Benefit 2"]
    }
  }'</pre>
  </div>
</body>
</html>`;
}

async function startServer(port: number) {
  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(indexHtml());
      return;
    }

    if (req.method === 'POST' && req.url === '/compare2') {
      try {
        const body = await readJson(req);
        const result = await handleCompare(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result, null, 2));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: false, 
          errorCode: 'UNKNOWN', 
          message: String(e) 
        }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(port, () => {
    console.log(`[two-video-compare-v2] Listening on http://localhost:${port}`);
    console.log(`[two-video-compare-v2] Prompt version: ${PROMPT_VERSION}`);
  });
}

// Start server
startServer(PORT);
