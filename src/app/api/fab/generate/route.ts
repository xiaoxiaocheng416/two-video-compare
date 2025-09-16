import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getFabPrompt } from '@/lib/prompt';
import { generateFabJSON } from '@/lib/gemini';
// no length enforcement in M1

const ImageSchema = z.object({ mime: z.string().min(1), data: z.string().min(1) });
const FabRequestSchema = z.object({
  productName: z.string().min(1),
  description: z.string().optional(),
  // New preferred field: images (array)
  images: z.array(ImageSchema).optional(),
  // Back-compat: single imageBase64
  imageBase64: ImageSchema.optional(),
});

const FabResponseSchema = z.object({
  summary: z.string(),
  features: z.array(z.string()),
  advantages: z.array(z.string()),
  benefits: z.array(z.string()),
  note: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = FabRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const { productName, description, images, imageBase64 } = parsed.data;
    const prompt = await getFabPrompt();

    const imgs = images ?? (imageBase64 ? [imageBase64] : []);
    const object = await generateFabJSON({
      systemPrompt: prompt,
      productName,
      description,
      images: imgs,
    });

    // Keep items as returned; only cap to 3 max per section, no length limit in M1
    const norm = {
      summary: object.summary,
      features: Array.isArray(object.features) ? object.features.slice(0, 3) : [],
      advantages: Array.isArray(object.advantages) ? object.advantages.slice(0, 3) : [],
      benefits: Array.isArray(object.benefits) ? object.benefits.slice(0, 3) : [],
      note: object.note,
    };

    return NextResponse.json({ success: true, data: norm });
  } catch (err) {
    console.error('FAB generate error', err);
    const msg = err instanceof Error ? err.message : 'Internal error';
    const isTimeout = /timeout|timed out|abort/i.test(msg);
    return NextResponse.json(
      { success: false, errorCode: isTimeout ? 'TIMEOUT' : 'UNKNOWN', message: msg },
      { status: 500 }
    );
  }
}
