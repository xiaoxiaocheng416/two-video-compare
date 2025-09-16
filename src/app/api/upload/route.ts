import { NextResponse, type NextRequest } from 'next/server';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 50);
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/tmp/uploads';

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, errorCode: 'INVALID_REQUEST' }, { status: 400 });
    }

    const sizeMB = file.size / (1024 * 1024);
    if (sizeMB > MAX_UPLOAD_MB) {
      return NextResponse.json({ success: false, errorCode: 'TOO_LARGE' }, { status: 413 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const id = `up_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const fileKey = `${id}_${file.name}`;
    const absPath = join(UPLOAD_DIR, fileKey);

    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, buf);

    return NextResponse.json({ success: true, data: { fileKey, sizeMB: Math.round(sizeMB * 100) / 100, mime: file.type } });
  } catch (err) {
    console.error('upload error', err);
    return NextResponse.json({ success: false, errorCode: 'UNKNOWN' }, { status: 500 });
  }
}

