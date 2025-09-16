import { NextResponse, type NextRequest } from 'next/server';
import { store } from '@/lib/store';
import { runJob } from '@/lib/job-runner';

export async function POST(_req: NextRequest, context: any) {
  try {
    const { params } = (context || {}) as { params: { id: string } };
    const job = store.getJob(params.id);
    if (!job) return NextResponse.json({ success: false, errorCode: 'NOT_FOUND' }, { status: 404 });
    if (job.status === 'processing') {
      return NextResponse.json({ success: false, errorCode: 'ALREADY_RUNNING' }, { status: 409 });
    }
    // Reset and run async
    store.updateJob(job.id, { status: 'queued', errorCode: undefined, result: undefined, completedAt: undefined });
    setTimeout(() => {
      runJob(job.id).catch(() => {});
    }, 0);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('retry job error', err);
    return NextResponse.json({ success: false, errorCode: 'UNKNOWN' }, { status: 500 });
  }
}
