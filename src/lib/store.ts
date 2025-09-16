// Minimal in-memory store for M1 local development.
// Note: data resets on server restart.

export type Collection = {
  id: string;
  userId?: string | null;
  productName: string;
  description?: string | null;
  imageRef?: string | null; // fileKey or data URL ref
  createdAt: string;
};

export type FabVersion = {
  id: string;
  collectionId: string;
  version: number;
  summary?: string;
  features: string[];
  advantages: string[];
  benefits: string[];
  note?: string | null;
  createdAt: string;
};

export type JobSource = { type: 'tiktok' | 'upload'; url?: string; fileKey?: string };

export type JobResult = {
  summary: string;
  perVideo: {
    A: { score: number; grade?: 'S' | 'A' | 'B' | 'C' | 'D'; highlights: string[]; issues: string[] };
    B: { score: number; grade?: 'S' | 'A' | 'B' | 'C' | 'D'; highlights: string[]; issues: string[] };
  };
  diff: Array<{ aspect: 'hook' | 'trust' | 'cta' | 'visual' | 'product_display' | string; note: string }>;
  actions: [string, string, string];
  timeline: Array<{
    A: any;
    B: any;
    gap: any;
  }>;
  improvementSummary?: string;
  transcripts?: { A?: string; B?: string };
  _key_clips?: { A?: Array<{ at: string; shot: string; sub: string }>; B?: Array<{ at: string; shot: string; sub: string }> };
};

export type CompareJob = {
  id: string;
  collectionId: string;
  fabVersionId: string;
  a: JobSource;
  b: JobSource;
  status: 'queued' | 'processing' | 'done' | 'error';
  errorCode?: 'TIMEOUT' | 'TOO_LARGE' | 'INVALID_URL' | 'UNKNOWN' | 'SCHEMA';
  model?: string;
  metrics?: { startedAt?: string; completedAt?: string; durationMs?: number };
  meta?: { stage?: string; t0?: string; t1?: string };
  result?: JobResult;
  createdAt: string;
  completedAt?: string;
};

let collections: Collection[] = [];
let fabVersions: FabVersion[] = [];
let jobs: CompareJob[] = [];

function genId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export const store = {
  collections,
  fabVersions,
  jobs,
  createCollection(input: Omit<Collection, 'id' | 'createdAt'>): Collection {
    const rec: Collection = { id: genId('col'), createdAt: new Date().toISOString(), ...input };
    collections.push(rec);
    return rec;
  },
  createFabVersion(input: Omit<FabVersion, 'id' | 'createdAt'>): FabVersion {
    const rec: FabVersion = { id: genId('fab'), createdAt: new Date().toISOString(), ...input };
    fabVersions.push(rec);
    return rec;
  },
  latestVersionForCollection(collectionId: string): number {
    const versions = fabVersions.filter((v) => v.collectionId === collectionId).map((v) => v.version);
    return versions.length ? Math.max(...versions) : 0;
  },
  createJob(input: Omit<CompareJob, 'id' | 'status' | 'createdAt'>): CompareJob {
    const rec: CompareJob = {
      id: genId('job'),
      status: 'queued',
      createdAt: new Date().toISOString(),
      ...input,
    };
    jobs.push(rec);
    return rec;
  },
  getJob(id: string): CompareJob | undefined {
    return jobs.find((j) => j.id === id);
  },
  updateJob(id: string, patch: Partial<CompareJob>): CompareJob | undefined {
    const j = jobs.find((x) => x.id === id);
    if (!j) return undefined;
    Object.assign(j, patch);
    return j;
  },
};
