import { NextResponse, type NextRequest } from 'next/server';
import { store } from '@/lib/store';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('fabVersionId');
  if (!id) return NextResponse.json({ success: false, error: 'fabVersionId required' }, { status: 400 });
  const fab = store.fabVersions.find((f) => f.id === id);
  if (!fab) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
  const col = store.collections.find((c) => c.id === fab.collectionId);
  return NextResponse.json({
    success: true,
    data: {
      fabVersionId: fab.id,
      version: fab.version,
      summary: fab.summary ?? '',
      features: fab.features,
      advantages: fab.advantages,
      benefits: fab.benefits,
      productName: col?.productName ?? '',
      collectionId: fab.collectionId,
    },
  });
}

