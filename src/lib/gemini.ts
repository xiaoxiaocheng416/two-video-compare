import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateObject, type CoreMessage } from 'ai';
import { z } from 'zod';

const MODEL_ID = process.env.MODEL_ID || 'gemini-2.5-pro';

// FAB schema (Zod) to avoid ai-sdk typeName errors
export const fabSchema = z.object({
  summary: z.string(),
  features: z.array(z.string()).min(2).max(3),
  advantages: z.array(z.string()).min(2).max(3),
  benefits: z.array(z.string()).min(2).max(3),
  note: z.string().optional(),
});

export type FabSchema = z.infer<typeof fabSchema>;

export async function generateFabJSON(opts: {
  systemPrompt: string; // prompt text from prompt.md
  productName: string;
  description?: string;
  images?: { mime: string; data: string }[] | null;
}) {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is not set');
  const provider = createGoogleGenerativeAI({ apiKey });
  const modelId = process.env.MODEL_FAB_ID || process.env.MODEL_ID || 'gemini-2.5-pro';
  const model = provider.chat(modelId);

  const content: CoreMessage['content'] = [
    {
      type: 'text',
      text: `Product name: ${opts.productName}\nDescription: ${opts.description ?? ''}`,
    },
    ...((opts.images ?? []).map((img) => ({
      type: 'image' as const,
      image: Buffer.from(img.data, 'base64'),
      mimeType: img.mime,
    }))),
  ];

  const { object } = await generateObject({
    model,
    schema: fabSchema,
    temperature: 0.1,
    system: opts.systemPrompt,
    messages: [{ role: 'user', content }],
  });

  return object;
}

// Generic JSON generator kept for other endpoints (e.g., compare)
export async function generateJsonWithGeminiZod<T = any>(
  schema: z.ZodTypeAny,
  opts: { system?: string; prompt?: string; messages?: any[]; temperature?: number; maxOutputTokens?: number; modelId?: string }
): Promise<T> {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is not set');
  const provider = createGoogleGenerativeAI({ apiKey });
  const model = provider.chat(opts.modelId || process.env.MODEL_ID || 'gemini-2.5-pro');

  const { object } = await generateObject({
    model,
    schema,
    temperature: opts.temperature,
    maxOutputTokens: opts.maxOutputTokens,
    system: opts.system,
    prompt: opts.prompt,
    messages: opts.messages,
  });
  return object as T;
}
