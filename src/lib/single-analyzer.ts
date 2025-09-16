import { readFile } from 'node:fs/promises';

const BASE = process.env.SINGLE_ANALYZER_BASE_URL || '';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 90000);
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/tmp/uploads';

type SingleParsed = any; // parsed_data shape is external; we keep it flexible

export type SingleAnalyzeOk = {
  analysisResult?: {
    parsed_data?: SingleParsed;
    raw_response?: any;
    metadata?: any;
  };
  meta?: any;
};

export type CompareInput = {
  fab?: {
    productName?: string;
    summary?: string;
    features?: string[];
    advantages?: string[];
    benefits?: string[];
  };
  A: { type: 'url'; url: string; notes?: string } | { type: 'upload'; fileKey: string; notes?: string };
  B: { type: 'url'; url: string; notes?: string } | { type: 'upload'; fileKey: string; notes?: string };
};

export type TabsResult = {
  summary: string;
  perVideo: {
    A: { score: number; grade?: string; highlights: string[]; issues: string[] };
    B: { score: number; grade?: string; highlights: string[]; issues: string[] };
  };
  diff: Array<{ aspect: 'hook' | 'trust' | 'visual' | 'product_display' | 'cta' | string; note: string }>;
  actions: [string, string, string];
  timeline: Array<{ A: any; B: any; gap: any }>;
  improvementSummary?: string;
  _key_clips?: { A: Array<{ at: string; shot: string; sub: string }>; B: Array<{ at: string; shot: string; sub: string }> };
};

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

async function postJson(path: string, body: any) {
  if (!BASE) throw new Error('SINGLE_ANALYZER_BASE_URL is not set');
  const res = await withTimeout(
    fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    REQUEST_TIMEOUT_MS
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = (json?.code as string) || (json?.errorCode as string) || 'UNKNOWN';
    const err = new Error(code);
    (err as any).code = code;
    throw err;
  }
  return json as SingleAnalyzeOk;
}

async function postUpload(path: string, filePath: string, mime = 'video/mp4') {
  if (!BASE) throw new Error('SINGLE_ANALYZER_BASE_URL is not set');
  const buf = await readFile(filePath);
  const blob = new Blob([buf], { type: mime });
  const fd = new FormData();
  fd.append('video', blob, filePath.split('/').pop() || 'video.mp4');
  const res = await withTimeout(
    fetch(`${BASE}${path}`, { method: 'POST', body: fd }),
    REQUEST_TIMEOUT_MS
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = (json?.code as string) || (json?.errorCode as string) || 'UNKNOWN';
    const err = new Error(code);
    (err as any).code = code;
    throw err;
  }
  return json as SingleAnalyzeOk;
}

export async function callSingleUrl(url: string): Promise<SingleAnalyzeOk> {
  return postJson('/api/videos/analyze_url', { url });
}

export async function callSingleUpload(fileKey: string): Promise<SingleAnalyzeOk> {
  const abs = `${UPLOAD_DIR}/${fileKey}`;
  return postUpload('/api/videos/upload', abs);
}

function num(x: any): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function pickHighlights(pd: any): string[] {
  const out: string[] = [];
  const pillars = pd?.pillars || {};
  const entries = Object.entries(pillars)
    .filter(([, v]) => typeof v === 'number')
    .sort((a, b) => (b[1] as number) - (a[1] as number))
    .slice(0, 2)
    .map(([k, v]) => `${k}: ${v}`);
  out.push(...entries.map((s) => `Strong ${s}`));
  const tl: any[] = Array.isArray(pd?.timeline) ? pd.timeline : [];
  const good = tl.filter((t) => num(t.score) >= 8).slice(0, 2);
  out.push(...good.map((t) => `Good ${t.phase || 'segment'} (${t.segment || ''})`));
  return out.slice(0, 3);
}

function pickIssues(pd: any): string[] {
  const out: string[] = [];
  const tl: any[] = Array.isArray(pd?.timeline) ? pd.timeline : [];
  const bad = tl.filter((t) => (t.severity && String(t.severity).toLowerCase() !== 'none') || num(t.score) <= 6).slice(0, 3);
  out.push(
    ...bad.map((t) => t.issue || `Weak ${t.phase || 'segment'} (${t.segment || ''})`)
  );
  if (out.length < 2 && pd?.flags?.penalties?.length) {
    out.push(...pd.flags.penalties.slice(0, 2 - out.length));
  }
  return out.slice(0, 3);
}

function mapAspectKey(k: string): 'hook' | 'trust' | 'visual' | 'product_display' | 'cta' | string {
  const m: Record<string, any> = {
    hook_0_3s: 'hook',
    creator_trust: 'trust',
    display_clarity: 'product_display',
    cta_effectiveness: 'cta',
  };
  return m[k] || k;
}

function buildDiff(pa: any, pb: any): Array<{ aspect: string; note: string }> {
  const out: Array<{ aspect: string; note: string }> = [];
  const keys = ['hook_0_3s', 'display_clarity', 'creator_trust', 'cta_effectiveness'];
  for (const k of keys) {
    const a = num(pa?.pillars?.[k]);
    const b = num(pb?.pillars?.[k]);
    const d = a - b;
    if (Math.abs(d) >= 2) {
      out.push({ aspect: mapAspectKey(k), note: `A ${d > 0 ? 'higher' : 'lower'} by ${Math.abs(d)} (${a} vs ${b})` });
    }
  }
  const sa = num(pa?.overview?.score);
  const sb = num(pb?.overview?.score);
  if (Math.abs(sa - sb) >= 5) {
    out.push({ aspect: 'overall', note: `Overall score gap ${Math.abs(sa - sb)} (${sa} vs ${sb})` });
  }
  return out.slice(0, 6);
}

function buildActions(pa: any, pb: any): [string, string, string] {
  const arr: string[] = [];
  const recsA: any[] = Array.isArray(pa?.recommendations) ? pa.recommendations : [];
  const recsB: any[] = Array.isArray(pb?.recommendations) ? pb.recommendations : [];
  const pick = (r: any) => r?.solution || r?.problem || r?.examples?.oral?.[0]?.text || '';
  for (const r of recsA) if (arr.length < 3 && pick(r)) arr.push(pick(r));
  for (const r of recsB) if (arr.length < 3 && pick(r)) arr.push(pick(r));
  while (arr.length < 3) arr.push('');
  return [arr[0], arr[1], arr[2]];
}

function pairTimeline(pa: any, pb: any): Array<{ A: any; B: any; gap: any }> {
  const ph = ['hook', 'trust', 'desire', 'cta'];
  const findByPhase = (list: any[], phase: string) => list.find((x) => (x.phase || '').toLowerCase() === phase);
  const la: any[] = Array.isArray(pa?.timeline) ? pa.timeline : [];
  const lb: any[] = Array.isArray(pb?.timeline) ? pb.timeline : [];
  const out: Array<{ A: any; B: any; gap: any }> = [];
  for (const p of ph) {
    const a = findByPhase(la, p) || {};
    const b = findByPhase(lb, p) || {};
    out.push({
      A: a,
      B: b,
      gap: {
        aspect: p,
        severity: a?.severity || b?.severity || 'low',
        hint: a?.fix_hint || b?.fix_hint || '',
      },
    });
  }
  return out.slice(0, 8);
}

export function mapSinglesToTabs(pa: any, pb: any, fab?: CompareInput['fab']): TabsResult {
  const sa = num(pa?.overview?.score);
  const sb = num(pb?.overview?.score);
  const ga = pa?.overview?.grade;
  const gb = pb?.overview?.grade;
  const sumA = String(pa?.overview?.summary || '').slice(0, 250);
  const sumB = String(pb?.overview?.summary || '').slice(0, 250);
  const summary = `A: ${sa}${ga ? ` (${ga})` : ''}. B: ${sb}${gb ? ` (${gb})` : ''}. ${fab?.summary ? `FAB: ${fab.summary}` : ''} A: ${sumA} B: ${sumB}`.slice(0, 400);

  const base: TabsResult = {
    summary,
    perVideo: {
      A: { score: sa, grade: ga, highlights: pickHighlights(pa), issues: pickIssues(pa) },
      B: { score: sb, grade: gb, highlights: pickHighlights(pb), issues: pickIssues(pb) },
    },
    diff: buildDiff(pa, pb),
    actions: buildActions(pa, pb),
    timeline: pairTimeline(pa, pb),
    improvementSummary: '',
  };

  // Optional helper field _key_clips (env-gated)
  const enableClips = (process.env.KEY_CLIPS_ENABLED || '1') === '1';
  if (enableClips) {
    const toClips = (p: any) => {
      const list: Array<{ at: string; shot: string; sub: string }> = [];
      const tl: any[] = Array.isArray(p?.timeline) ? p.timeline : [];
      for (const t of tl) {
        if (list.length >= 8) break;
        const at = typeof t.t === 'string' && t.t ? t.t : '';
        const screenText = typeof t.screen_text === 'string' ? t.screen_text : '';
        const visual = String(t.visual_cue || '').toLowerCase();
        let shot = 'close-up';
        if (screenText) shot = 'text-overlay';
        else if (/screen|record/.test(visual)) shot = 'screen-record';
        else if (/hand|hold|holding|in hand/.test(visual)) shot = 'product-in-hand';
        else if (/macro/.test(visual)) shot = 'macro';
        list.push({ at, shot, sub: screenText || '' });
      }
      return list.slice(0, Math.max(4, Math.min(8, list.length)));
    };
    const clipsA = toClips(pa);
    const clipsB = toClips(pb);
    if (clipsA.length || clipsB.length) base._key_clips = { A: clipsA, B: clipsB };
    else if (base.improvementSummary !== undefined) {
      // strict fallback: append KEY_CLIPS_JSON line to improvementSummary
      try {
        const json = JSON.stringify({ A: clipsA, B: clipsB });
        base.improvementSummary = `${base.improvementSummary || ''}\n[KEY_CLIPS_JSON]: ${json}`.trim();
      } catch {}
    }
  }

  return base;
}

export async function compareViaSingleAnalyzer(input: CompareInput): Promise<TabsResult> {
  const callA = input.A.type === 'url' ? callSingleUrl(input.A.url) : callSingleUpload(input.A.fileKey);
  const callB = input.B.type === 'url' ? callSingleUrl(input.B.url) : callSingleUpload(input.B.fileKey);
  const [a, b] = await Promise.all([callA, callB]);
  const pa = a?.analysisResult?.parsed_data || {};
  const pb = b?.analysisResult?.parsed_data || {};
  return mapSinglesToTabs(pa, pb, input.fab);
}

export function mapSingleErrorToCode(err: any): 'INVALID_URL' | 'TOO_LARGE' | 'TIMEOUT' | 'UNKNOWN' | 'SCHEMA' {
  const c = (err?.code as string) || (err?.message as string) || '';
  if (/INVALID_URL|UNSUPPORTED_HOST/i.test(c)) return 'INVALID_URL';
  if (/TOO_LARGE/i.test(c)) return 'TOO_LARGE';
  if (/UPSTREAM_TIMEOUT|TIMEOUT/i.test(c)) return 'TIMEOUT';
  if (/PARSE_FAIL|SCHEMA/i.test(c)) return 'SCHEMA';
  return 'UNKNOWN';
}
