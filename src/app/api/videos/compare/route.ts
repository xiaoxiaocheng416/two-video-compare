import { NextResponse, type NextRequest } from 'next/server';
import { compareViaSingleAnalyzer, mapSingleErrorToCode, type CompareInput } from '@/lib/single-analyzer';
import { generateJsonWithGeminiZod } from '@/lib/gemini';
import { z } from 'zod';

const fallbackSchema = z.object({
  summary: z.string(),
  per_video: z.object({
    A: z.object({
      score: z.number().int(),
      grade: z.string().optional(),
      highlights: z.array(z.string()),
      issues: z.array(z.string())
    }).passthrough(),
    B: z.object({
      score: z.number().int(),
      grade: z.string().optional(),
      highlights: z.array(z.string()),
      issues: z.array(z.string())
    }).passthrough()
  }).passthrough(),
  diff: z.array(z.object({
    aspect: z.string(),
    note: z.string()
  }).passthrough()),
  actions: z.array(z.string()).length(3),
  timeline: z.array(z.object({
    A: z.record(z.string(), z.any()),
    B: z.record(z.string(), z.any()),
    gap: z.record(z.string(), z.any())
  }).passthrough()),
  improvement_summary: z.string().optional()
}).passthrough();

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as CompareInput;
    try {
      const result = await compareViaSingleAnalyzer(body);
      return NextResponse.json({ success: true, data: result });
    } catch (e: any) {
      const code = mapSingleErrorToCode(e);
      // fallback to existing model path if analyzer fails: return shape compatible with 5 tabs
      if (code !== 'TIMEOUT') {
        try {
          const prompt = `Return JSON for a quick A/B video comparison based on FAB and notes only.`;
          const obj = await generateJsonWithGeminiZod<any>(fallbackSchema, { prompt, temperature: 0.2 });
          return NextResponse.json({ success: true, data: obj });
        } catch {}
      }
      return NextResponse.json({ success: false, errorCode: code }, { status: 500 });
    }
  } catch (err) {
    return NextResponse.json({ success: false, errorCode: 'UNKNOWN' }, { status: 500 });
  }
}
