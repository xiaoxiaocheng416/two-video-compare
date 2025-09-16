import { z } from 'zod';
import { store, type JobResult } from './store';
import { getComparePrompt } from './prompt';
import { generateJsonWithGeminiZod } from './gemini';
import { compareViaSingleAnalyzer, mapSingleErrorToCode } from './single-analyzer';
import { keysToCamelDeep, limitString } from './json-utils';
import { scheduleASR, readTranscriptIfExists } from './asr';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const schema = z.object({
  summary: z.string(),
  per_video: z.object({
    A: z.object({
      score: z.number().int(),
      grade: z.string().optional(),
      highlights: z.array(z.string()),
      issues: z.array(z.string()),
    }),
    B: z.object({
      score: z.number().int(),
      grade: z.string().optional(),
      highlights: z.array(z.string()),
      issues: z.array(z.string()),
    }),
  }),
  diff: z.array(
    z.object({
      aspect: z.string(),
      note: z.string(),
    })
  ),
  actions: z.array(z.string()).length(3),
  timeline: z.array(
    z.object({
      A: z.record(z.string(), z.any()),
      B: z.record(z.string(), z.any()),
      gap: z.record(z.string(), z.any()),
    })
  ),
  improvement_summary: z.string(),
});

const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 55000);
const VIDEO_CACHE_DIR = process.env.VIDEO_CACHE_DIR || '/var/tmp/video-cache';
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/tmp/uploads';

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

function tokenFor(src: any): string {
  if (src?.type === 'upload') return String(src.fileKey || '');
  if (src?.type === 'tiktok') return sha1(String(src.url || ''));
  return '';
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function tryScheduleAsrForSource(src: any): Promise<void> {
  const tok = tokenFor(src);
  if (!tok) return;
  const outWav = join(VIDEO_CACHE_DIR, `${tok}.wav`);
  const outTxt = join(VIDEO_CACHE_DIR, `${tok}.transcript.txt`);

  // Upload branch
  if (src.type === 'upload' && src.fileKey) {
    const mp4 = join(UPLOAD_DIR, src.fileKey);
    const ok = await pathExists(mp4);
    if (!ok) {
      console.log(`[ASR_SKIP] upload file missing token=${tok} path=${mp4}`);
      return;
    }
    scheduleASR(mp4, outWav, outTxt).catch(()=>{});
    console.log(`[ASR_SCHEDULED] type=upload token=${tok} path=${mp4}`);
    return;
  }

  // URL branch: try whitelist of candidate sanitized paths
  if (src.type === 'tiktok' && src.url) {
    const candidates: string[] = [
      join(VIDEO_CACHE_DIR, tok, 'san.mp4'),
      join(VIDEO_CACHE_DIR, `${tok}.mp4`),
    ];
    // If folder exists, include any .mp4 inside as fallback
    const folder = join(VIDEO_CACHE_DIR, tok);
    try {
      const st = await fs.stat(folder).catch(() => null as any);
      if (st && st.isDirectory()) {
        const files = await fs.readdir(folder).catch(() => [] as string[]);
        for (const f of files) if (f.endsWith('.mp4')) candidates.push(join(folder, f));
      }
    } catch {}

    let matched = '';
    for (const c of candidates) {
      if (await pathExists(c)) { matched = c; break; }
    }
    if (!matched) {
      console.log(`[ASR_SKIP] type=url token=${tok} url=${src.url} reasons=[no_sanmp4_found] candidates=${JSON.stringify(candidates)}`);
      return;
    }
    scheduleASR(matched, outWav, outTxt).catch(()=>{});
    console.log(`[ASR_SCHEDULED] type=url token=${tok} path=${matched}`);
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

export async function runJob(jobId: string): Promise<void> {
  const job = store.getJob(jobId);
  if (!job) return;
  try {
    const modelId = process.env.MODEL_COMPARE_ID || process.env.MODEL_ID || 'gemini-2.5-pro';
    const startedAt = new Date().toISOString();
    store.updateJob(jobId, {
      status: 'processing',
      errorCode: undefined,
      result: undefined,
      model: modelId,
      metrics: { startedAt },
      meta: { stage: 'preparing', t0: startedAt },
    });

    const fab = store.fabVersions.find((f) => f.id === job.fabVersionId);
    const col = store.collections.find((c) => c.id === job.collectionId);
    if (!fab || !col) {
      store.updateJob(jobId, { status: 'error', errorCode: 'UNKNOWN' });
      return;
    }

    // calling_model stage (single analyzer aggregation)
    const callStart = new Date().toISOString();
    store.updateJob(jobId, { meta: { stage: 'calling_model', t0: callStart } });
    const a = job.a as any;
    const b = job.b as any;
    // schedule ASR in background (non-blocking)
    tryScheduleAsrForSource(job.a).catch(()=>{});
    tryScheduleAsrForSource(job.b).catch(()=>{});

    const result = await withTimeout(
      compareViaSingleAnalyzer({
        fab: {
          productName: col.productName,
          summary: fab.summary ?? '',
          features: fab.features,
          advantages: fab.advantages,
          benefits: fab.benefits,
        },
        A:
          a.type === 'tiktok'
            ? { type: 'url', url: a.url, notes: a.notes }
            : { type: 'upload', fileKey: a.fileKey, notes: a.notes },
        B:
          b.type === 'tiktok'
            ? { type: 'url', url: b.url, notes: b.notes }
            : { type: 'upload', fileKey: b.fileKey, notes: b.notes },
      }),
      REQUEST_TIMEOUT_MS
    );
    const callEnd = new Date().toISOString();
    store.updateJob(jobId, { meta: { stage: 'parsing', t0: callEnd } });

    const completedAt = new Date().toISOString();
    const durationMs = Date.parse(completedAt) - Date.parse(startedAt);
    // try injecting transcripts if available
    let transcripts: any = undefined;
    try {
      const tokA = tokenFor(job.a);
      const tokB = tokenFor(job.b);
      const ta = tokA ? await readTranscriptIfExists(join(VIDEO_CACHE_DIR, `${tokA}.transcript.txt`)) : null;
      const tb = tokB ? await readTranscriptIfExists(join(VIDEO_CACHE_DIR, `${tokB}.transcript.txt`)) : null;
      if (ta || tb) transcripts = { A: ta || '', B: tb || '' };
    } catch {}

    store.updateJob(jobId, {
      status: 'done',
      result: transcripts ? ({ ...(result as any), transcripts } as any) : (result as any),
      completedAt,
      metrics: { startedAt, completedAt, durationMs },
      meta: { stage: 'done', t1: completedAt },
    });
  } catch (e: any) {
    const msg = e?.message || '';
    const isTimeout = /timeout|timed out|abort|TIMEOUT/i.test(msg);
    const completedAt = new Date().toISOString();
    const prev = store.getJob(jobId);
    const startedAt = prev?.metrics?.startedAt || new Date().toISOString();
    const durationMs = Date.parse(completedAt) - Date.parse(startedAt);
    let errorCode: 'TIMEOUT' | 'SCHEMA' | 'UNKNOWN' = 'UNKNOWN';
    let stage = 'error_unknown';
    if (isTimeout) {
      errorCode = 'TIMEOUT';
      stage = 'error_timeout';
    } else if (/zod|schema|validation|PARSE_FAIL/i.test(msg)) {
      errorCode = 'SCHEMA';
      stage = 'error_schema';
    }
    store.updateJob(jobId, {
      status: 'error',
      errorCode,
      metrics: { startedAt, completedAt, durationMs },
      meta: { stage },
    });
  }
}
