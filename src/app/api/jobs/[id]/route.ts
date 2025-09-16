import { NextResponse, type NextRequest } from 'next/server';
import { store } from '@/lib/store';
import { readTranscriptIfExists } from '@/lib/asr';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const VIDEO_CACHE_DIR = process.env.VIDEO_CACHE_DIR || '/var/tmp/video-cache';

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

function tokenFor(src: any): string {
  if (!src) return '';
  if (src.type === 'upload') return String(src.fileKey || '');
  if (src.type === 'tiktok') return sha1(String(src.url || ''));
  return '';
}

export async function GET(_req: NextRequest, context: any) {
  try {
    const { params } = (context || {}) as { params: { id: string } };
    const job = store.getJob(params.id);
    if (!job) return NextResponse.json({ success: false, errorCode: 'NOT_FOUND' }, { status: 404 });

    // Try inject transcripts from cache if available
    try {
      if (job.result) {
        const tokA = tokenFor(job.a);
        const tokB = tokenFor(job.b);
        const tr = (job.result as any).transcripts as any;
        const wantA = !!(tokA && (!tr || !tr.A));
        const wantB = !!(tokB && (!tr || !tr.B));
        let ta: string | null = null;
        let tb: string | null = null;
        if (wantA) ta = await readTranscriptIfExists(join(VIDEO_CACHE_DIR, `${tokA}.transcript.txt`));
        if (wantB) tb = await readTranscriptIfExists(join(VIDEO_CACHE_DIR, `${tokB}.transcript.txt`));
        if ((ta && ta.length) || (tb && tb.length)) {
          const prev = (job.result as any).transcripts || { A: '', B: '' };
          const merged = { A: ta || prev.A || '', B: tb || prev.B || '' };
          store.updateJob(job.id, { result: { ...(job.result as any), transcripts: merged } as any });
        }
      }
    } catch {}

    return NextResponse.json({
      success: true,
      data: {
        id: job.id,
        status: job.status,
        errorCode: job.errorCode,
        result: job.result,
        model: job.model,
        metrics: job.metrics,
        meta: job.meta,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
      },
    });
  } catch (err) {
    console.error('get job error', err);
    return NextResponse.json({ success: false, errorCode: 'UNKNOWN' }, { status: 500 });
  }
}
