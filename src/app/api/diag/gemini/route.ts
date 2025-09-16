import { NextResponse } from 'next/server';
import { z } from 'zod';
import { generateJsonWithGeminiZod } from '@/lib/gemini';

export async function GET() {
  const model = process.env.MODEL_COMPARE_ID || process.env.MODEL_ID || 'gemini-2.5-pro';
  const schema = z.object({ ok: z.string() });
  const started = Date.now();
  try {
    const obj = await generateJsonWithGeminiZod(schema, {
      prompt: 'Return strictly JSON: {"ok":"pong"}',
      temperature: 0,
      modelId: model,
    });
    const latencyMs = Date.now() - started;
    return NextResponse.json({ ok: true, model, latencyMs, data: obj });
  } catch (e: any) {
    const latencyMs = Date.now() - started;
    return NextResponse.json({ ok: false, model, latencyMs, error: e?.message || String(e) }, { status: 500 });
  }
}

