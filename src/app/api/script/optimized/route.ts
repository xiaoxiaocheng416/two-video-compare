import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';

const MODEL_ID = process.env.MODEL_ID || 'gemini-2.5-pro';
const TIMEOUT_MS = Number(process.env.SCRIPT_TIMEOUT_MS || 30000);

function parseJsonStrict(text: string) {
  const t = text.trim().replace(/^```json\n|^```/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    const s = t.indexOf('{');
    const e = t.lastIndexOf('}');
    if (s !== -1 && e !== -1 && e > s) {
      return JSON.parse(t.slice(s, e + 1));
    }
    throw new Error('NON_JSON');
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number) {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(id); resolve(v); })
     .catch((e) => { clearTimeout(id); reject(e); });
  });
}

function buildPrompt(input: any) {
  const header = `Task: Fuse two transcripts (A/B) with existing compare outputs (summary, diff, timeline_pairs, actions, _key_clips, optional product_fab) to generate a shoot-ready ~45s script.\n` +
  `Steps:\n` +
  `(1) Extract key evidence from A and B (4–8 each) with timestamps [mm:ss–mm:ss], short quotes, and shot tags like [macro], sub:"...". Do not full-transcribe.\n` +
  `(2) Output _script with exactly 5 segments:\n` +
  `Hook 0–3s (curiosity/pain/urgency/social proof; overlay 8–10 words)\n` +
  `Body 3–12s (Selling point #1 + clear demo)\n` +
  `Trust 12–27s (before/after or close details or social proof)\n` +
  `Desire 27–41s (map benefits to real life)\n` +
  `CTA 41–45s (explicit action, e.g., “Tap the orange cart…”)\n` +
  `Voice: simple English, short sentences, total 90–110 words.\n` +
  `Overlay: ≤10 words; complement (not duplicate) VO.\n` +
  `Shot: choose from [close-up] [macro] [in-hand] [comparison] [text-overlay].\n` +
  `Evidence alignment: Put how each evidence item supports segments in notes.evidence with usedInPhase.\n` +
  `Gaps: If CTA/stock/price is missing, list in notes.issues but still deliver a complete script (use generic CTA).\n` +
  `Answer with JSON only following the contract: _script object and notes.\n\n`;

  const contract = `Output strictly this JSON contract (only _script and notes at top-level):\n` +
  `{"_script":{"durationTargetSec":45,"wordCount":0,"segments":[{"phase":"hook","startSec":0,"endSec":3,"vo":"","overlay":"","shot":"[close-up]"},{"phase":"body","startSec":3,"endSec":12,"vo":"","overlay":"","shot":"[in-hand]"},{"phase":"trust","startSec":12,"endSec":27,"vo":"","overlay":"","shot":"[comparison]"},{"phase":"desire","startSec":27,"endSec":41,"vo":"","overlay":"","shot":"[macro]"},{"phase":"cta","startSec":41,"endSec":45,"vo":"","overlay":"","shot":"[text-overlay]"}],"notes":{"evidence":[],"issues":[],"style":[]}}}`;

  return header + 'INPUT:\n' + JSON.stringify(input, null, 2) + '\n\n' + contract;
}

function buildPromptShort(input: any) {
  const header = `Generate a ~45s shoot-ready script from A/B transcripts and compare results. Return JSON with _script only (5 segments: hook, body, trust, desire, cta). 90–110 words, overlay ≤10 words, shot in [close-up|macro|in-hand|comparison|text-overlay].`;
  const contract = `{"_script":{"durationTargetSec":45,"wordCount":0,"segments":[{"phase":"hook","startSec":0,"endSec":3,"vo":"","overlay":"","shot":"[close-up]"},{"phase":"body","startSec":3,"endSec":12,"vo":"","overlay":"","shot":"[in-hand]"},{"phase":"trust","startSec":12,"endSec":27,"vo":"","overlay":"","shot":"[comparison]"},{"phase":"desire","startSec":27,"endSec":41,"vo":"","overlay":"","shot":"[macro]"},{"phase":"cta","startSec":41,"endSec":45,"vo":"","overlay":"","shot":"[text-overlay]"}]}}`;
  return header + '\nINPUT:\n' + JSON.stringify(input, null, 2) + '\n\n' + contract;
}

export async function POST(req: NextRequest) {
  if ((process.env.SCRIPT_ENABLED || '0') === '0') {
    return NextResponse.json({ _script: null, error: 'disabled' }, { status: 200 });
  }
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ _script: null, notes: { issues: ['missing_api_key'] } }, { status: 500 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ _script: null, notes: { issues: ['invalid_json'] } }, { status: 400 });
  }
  // basic validation & missing evidence
  const Req = z.object({
    compare_id: z.string().optional(),
    transcripts: z.object({ A: z.string().optional(), B: z.string().optional() }).optional(),
    analysis: z.object({
      summary: z.string().optional(),
      diff: z.any().optional(),
      timeline_pairs: z.array(z.any()).optional(),
      actions: z.array(z.any()).optional(),
      _key_clips: z.object({ A: z.array(z.any()).optional(), B: z.array(z.any()).optional() }).optional(),
    }).optional(),
    product_fab: z.any().optional(),
    options: z.object({ durationTargetSec: z.number().optional(), wordRange: z.tuple([z.number(), z.number()]).optional() }).optional(),
  });
  const parsed = Req.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ _script: null, error: 'bad_request', details: parsed.error.format() }, { status: 400 });
  }
  const input = {
    compare_id: parsed.data.compare_id || null,
    transcripts: parsed.data.transcripts || { A: '', B: '' },
    analysis: parsed.data.analysis || {},
    product_fab: parsed.data.product_fab || null,
    options: parsed.data.options || { durationTargetSec: 45, wordRange: [90, 110] },
  };

  // Evidence priority: key_clips -> KEY_CLIPS_JSON in improvementSummary -> transcripts
  const { transcripts, analysis } = input as any;
  const hasClips = !!analysis?._key_clips && (((analysis._key_clips.A || []).length + (analysis._key_clips.B || []).length) > 0);
  let parsedClips: any = null;
  if (!hasClips) {
    // Look for [KEY_CLIPS_JSON]: {...}
    const imps = (analysis?.improvementSummary || analysis?.improvement_summary || '') as string;
    const m = imps.match(/\[KEY_CLIPS_JSON\]:\s*(\{[\s\S]*\})\s*$/);
    if (m) {
      try { parsedClips = JSON.parse(m[1]); } catch {}
    }
  }
  const hasTranscripts = !!(transcripts?.A && transcripts.A.trim().length >= 10) || !!(transcripts?.B && transcripts.B.trim().length >= 10);
  if (!hasClips && !parsedClips && !hasTranscripts) {
    return NextResponse.json({ _script: null, error: 'missing_evidence' }, { status: 200 });
  }

  const prompt = buildPrompt({ ...input, key_clips: hasClips ? analysis._key_clips : (parsedClips || undefined) });

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: MODEL_ID,
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1200,
        responseMimeType: 'application/json',
      },
    });

    const res = await withTimeout(model.generateContent([{ text: prompt }]), TIMEOUT_MS);
    let text = res.response.text();
    let json: any;
    try {
      json = parseJsonStrict(text);
    } catch {
      // one short retry
      const res2 = await withTimeout(model.generateContent([{ text: buildPromptShort(input) }]), TIMEOUT_MS);
      text = res2.response.text();
      try {
        json = parseJsonStrict(text);
      } catch {
        return NextResponse.json({ _script: null, error: 'script_generation_failed' }, { status: 200 });
      }
    }
    if (!json || typeof json !== 'object' || !('_script' in json)) {
      return NextResponse.json({ _script: null, error: 'script_generation_failed' }, { status: 200 });
    }
    return NextResponse.json(json, { status: 200 });

  } catch (e: any) {
    return NextResponse.json({ _script: null, error: 'script_generation_failed' }, { status: 200 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, service: 'script-optimized' });
}
