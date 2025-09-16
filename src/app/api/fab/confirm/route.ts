import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { store } from '@/lib/store';

const ConfirmSchema = z.object({
  collectionId: z.string().optional(),
  productName: z.string().min(1),
  description: z.string().optional(),
  imageRef: z.string().optional(),
  summary: z.string().optional(),
  features: z.array(z.string()).min(2),
  advantages: z.array(z.string()).min(2),
  benefits: z.array(z.string()).min(2),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = ConfirmSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const { collectionId, productName, description, imageRef, summary, features, advantages, benefits } = parsed.data;

    // Create new collection if not provided
    const collection = collectionId
      ? store.collections.find((c) => c.id === collectionId) ||
        store.createCollection({ userId: null, productName, description: description ?? null, imageRef: imageRef ?? null })
      : store.createCollection({ userId: null, productName, description: description ?? null, imageRef: imageRef ?? null });

    const nextVer = store.latestVersionForCollection(collection.id) + 1;
    const fab = store.createFabVersion({
      collectionId: collection.id,
      version: nextVer,
      summary: summary ?? '',
      features,
      advantages,
      benefits,
    });

    return NextResponse.json({ success: true, data: { collectionId: collection.id, fabVersionId: fab.id, version: fab.version } });
  } catch (err) {
    console.error('FAB confirm error', err);
    return NextResponse.json({ success: false, errorCode: 'UNKNOWN' }, { status: 500 });
  }
}
