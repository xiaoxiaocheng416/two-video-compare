import { NextResponse, type NextRequest } from 'next/server';
import { store } from '@/lib/store';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const collectionId = searchParams.get('collectionId');
  if (!collectionId) return NextResponse.json({ success: false, error: 'collectionId required' }, { status: 400 });
  const list = store.fabVersions
    .filter((f) => f.collectionId === collectionId)
    .sort((a, b) => b.version - a.version)
    .map((f) => ({ fabVersionId: f.id, version: f.version, summary: f.summary ?? '' }));
  return NextResponse.json({ success: true, data: list });
}

