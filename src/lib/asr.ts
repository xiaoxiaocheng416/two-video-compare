import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import ffmpegPathRaw from 'ffmpeg-static';

type Job = { wav: string; video: string; outTxt: string; resolve: (v: any)=>void; reject:(e:any)=>void };

const ASR_ENABLED = process.env.ASR_ENABLED === '1';
const ASR_CLI = process.env.ASR_CLI || 'faster-whisper';
const ASR_MODEL = process.env.ASR_MODEL || 'medium';
const ASR_CONCURRENCY = Number(process.env.ASR_CONCURRENCY || 1);
const ASR_TIMEOUT_MS = Number(process.env.ASR_TIMEOUT_MS || 120000);

let active = 0;
const queue: Job[] = [];

function run(cmd: string, args: string[], cwd?: string, timeout = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: 'ignore' });
    const to = timeout > 0 ? setTimeout(() => {
      try { p.kill('SIGKILL'); } catch {}
    }, timeout) : null;
    p.on('exit', (code) => {
      if (to) clearTimeout(to);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}`));
    });
    p.on('error', (e) => {
      if (to) clearTimeout(to);
      reject(e);
    });
  });
}

export async function extractAudioWav(mp4Path: string, wavPath: string): Promise<void> {
  const t0 = Date.now();
  const FFMPEG_BIN = process.env.FFMPEG_PATH || (ffmpegPathRaw as any as string) || 'ffmpeg';
  await run(FFMPEG_BIN, ['-y', '-i', mp4Path, '-ac', '1', '-ar', '16000', '-vn', '-c:a', 'pcm_s16le', wavPath], undefined, ASR_TIMEOUT_MS);
  const dt = Date.now() - t0;
  console.log(`[ASR] extract ok ${Math.round(dt)}ms → ${wavPath}`);
}

export async function transcribeWavToJson(wavPath: string, outDir: string): Promise<string> {
  // faster-whisper will write JSON into outDir
  await fs.mkdir(outDir, { recursive: true }).catch(() => {});
  const t0 = Date.now();
  await run(ASR_CLI, ['transcribe', wavPath, '--model', ASR_MODEL, '--timestamps', 'true', '--vad', 'true', '--output_format', 'json', '--output_dir', outDir], undefined, ASR_TIMEOUT_MS);
  const dt = Date.now() - t0;
  // Find first json
  const files = await fs.readdir(outDir);
  const jsonFile = files.find((f) => f.endsWith('.json'));
  if (!jsonFile) throw new Error('asr_json_missing');
  console.log(`[ASR] transcribe ok model=${ASR_MODEL} ${Math.round(dt)}ms → ${join(outDir, jsonFile)}`);
  return join(outDir, jsonFile);
}

export async function formatTranscript(jsonPath: string): Promise<string> {
  const raw = await fs.readFile(jsonPath, 'utf-8');
  let data: any;
  try { data = JSON.parse(raw); } catch { throw new Error('asr_bad_json'); }
  const segs: any[] = data.segments || data; // some tools dump array directly
  function mmss(t: number) {
    const m = Math.floor(t);
    const min = Math.floor(m / 60); const sec = m % 60;
    return `${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  }
  const lines: string[] = [];
  for (const s of segs) {
    const start = typeof s.start === 'number' ? s.start : (s.start_time ?? 0);
    const end = typeof s.end === 'number' ? s.end : (s.end_time ?? (start+2));
    const text = String(s.text ?? s.transcript ?? '').trim();
    if (!text) continue;
    lines.push(`[${mmss(start)}–${mmss(end)}] ${text}`);
  }
  const out = lines.join('\n');
  console.log(`[ASR] formatted ${lines.length} lines, ${out.length} chars`);
  return out;
}

async function worker() {
  if (active >= ASR_CONCURRENCY) return;
  const job = queue.shift();
  if (!job) return;
  active++;
  try {
    const t0 = Date.now();
    await extractAudioWav(job.video, job.wav);
    const tmpOut = join(dirname(job.wav), `.asr-${basename(job.wav)}.d`);
    const jsonPath = await transcribeWavToJson(job.wav, tmpOut);
    const text = await formatTranscript(jsonPath);
    await fs.writeFile(job.outTxt, text, 'utf-8');
    const dt = Date.now() - t0;
    console.log(`[ASR] done total=${Math.round(dt)}ms → ${job.outTxt}`);
    job.resolve(text);
  } catch (e: any) {
    console.warn(`[ASR] failed: ${e?.message || e}`);
    job.reject(e);
  } finally {
    active--;
    // schedule next
    setImmediate(worker);
  }
}

export function scheduleASR(videoPath: string, outWav: string, outTxt: string): Promise<string> {
  if (!ASR_ENABLED) return Promise.reject(new Error('asr_disabled'));
  return new Promise((resolve, reject) => {
    queue.push({ video: videoPath, wav: outWav, outTxt, resolve, reject });
    setImmediate(worker);
  });
}

export async function readTranscriptIfExists(txtPath: string): Promise<string | null> {
  try { const s = await fs.readFile(txtPath, 'utf-8'); return s; } catch { return null; }
}
