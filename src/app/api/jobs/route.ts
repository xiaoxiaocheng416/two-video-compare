import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { store } from '@/lib/store';
import { runJob } from '@/lib/job-runner';

const TikTokHosts = (process.env.ALLOWED_TIKTOK_HOSTS || 'tiktok.com,www.tiktok.com,vt.tiktok.com,vm.tiktok.com')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const SourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tiktok'), url: z.string().url(), notes: z.string().optional() }),
  z.object({ type: z.literal('upload'), fileKey: z.string().min(1), notes: z.string().optional() }),
]);

const CreateJobSchema = z.object({
  collectionId: z.string().min(1),
  fabVersionId: z.string().min(1),
  A: SourceSchema,
  B: SourceSchema,
  // legacy common notes no longer used; keep optional for backward-compat
  notes: z.string().optional(),
});

function isValidTikTokUrl(u: string): boolean {
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();
    return TikTokHosts.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
  const parsed = CreateJobSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ success: false, errorCode: 'INVALID_REQUEST' }, { status: 400 });
    }
    const { collectionId, fabVersionId, A, B, notes } = parsed.data;

    if (A.type === 'tiktok' && !isValidTikTokUrl((A as any).url)) {
      return NextResponse.json({ success: false, errorCode: 'INVALID_URL' }, { status: 400 });
    }
    if (B.type === 'tiktok' && !isValidTikTokUrl((B as any).url)) {
      return NextResponse.json({ success: false, errorCode: 'INVALID_URL' }, { status: 400 });
    }

    // sanitize notes length to avoid heavy payload
    const sanitizeNotes = (n?: string) => (typeof n === 'string' ? n.slice(0, 1500) : undefined);
    const aSan = { ...A, notes: sanitizeNotes((A as any).notes ?? notes) } as any;
    const bSan = { ...B, notes: sanitizeNotes((B as any).notes ?? notes) } as any;

    const job = store.createJob({ collectionId, fabVersionId, a: aSan, b: bSan });
    // run async without waiting; return immediately
    setTimeout(() => {
      runJob(job.id).catch(() => {});
    }, 0);
    return NextResponse.json({ success: true, data: { jobId: job.id } });
  } catch (err) {
    console.error('create job error', err);
    return NextResponse.json({ success: false, errorCode: 'UNKNOWN' }, { status: 500 });
  }
}
