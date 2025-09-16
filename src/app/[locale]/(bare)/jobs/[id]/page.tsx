"use client";
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';

type JobData = {
  id: string;
  status: 'queued' | 'processing' | 'done' | 'error';
  errorCode?: string;
  result?: {
    summary: string;
    perVideo: {
      A: { score: number; grade?: string; highlights: string[]; issues: string[] };
      B: { score: number; grade?: string; highlights: string[]; issues: string[] };
    };
    diff: { aspect: string; note: string }[];
    actions: string[];
    timeline: any[];
    improvementSummary?: string;
    transcripts?: { A?: string; B?: string };
  };
  createdAt: string;
  completedAt?: string;
};

export default function JobResultPage() {
  const params = useParams();
  const id = (params as any).id as string;

  const [data, setData] = useState<JobData | null>(null);
  const [polling, setPolling] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number>(Date.now());
  // Script tab: only display transcripts (no generation or manual input)

  async function load() {
    const res = await fetch(`/api/jobs/${id}`, { cache: 'no-store' });
    const json = await res.json();
    if (res.ok && json?.success) {
      setData(json.data);
      if (json.data.status === 'done' || json.data.status === 'error') setPolling(false);
    }
  }

  useEffect(() => {
    let alive = true;
    let elapsed = 0;
    let timer: any;
    const tick = async () => {
      const res = await fetch(`/api/jobs/${id}`, { cache: 'no-store' });
      const json = await res.json();
      if (!alive) return;
      if (res.ok && json?.success) {
        setData(json.data);
        setLastUpdated(Date.now());
        if (json.data.status === 'done' || json.data.status === 'error') {
          setPolling(false);
          return;
        }
      }
      elapsed += 1500;
      if (elapsed >= 60000) {
        setData((prev) => ({ ...(prev || { id, createdAt: new Date().toISOString() }), status: 'error', errorCode: 'TIMEOUT' } as any));
        setPolling(false);
        return;
      }
      timer = setTimeout(tick, 1500);
    };
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  const isLoading = !data || data.status === 'queued' || data.status === 'processing';
  const isError = data?.status === 'error';
  const result = data?.result;

  async function onRetry() {
    setRetrying(true);
    try {
      await fetch(`/api/jobs/${id}/retry`, { method: 'POST' });
      setPolling(true);
      load();
    } finally {
      setRetrying(false);
    }
  }

  function DebugRaw({ job }: { job: any }) {
    if (!job) return null;
    const payload = job.result ?? job;
    const json = JSON.stringify(payload, null, 2);
    const copy = () => navigator.clipboard.writeText(json);
    const download = () => {
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${job.id || 'job'}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    };
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <code>jobId: {job.id}</code>
          <span>status: {job.status}</span>
          {job.errorCode && <span className="text-destructive">error: {job.errorCode}</span>}
          {job.model && <span>model: {job.model}</span>}
          {job.metrics?.durationMs && <span>duration: {job.metrics.durationMs}ms</span>}
          <span>updated: {new Date(lastUpdated).toLocaleTimeString()}</span>
          <Button variant="secondary" size="sm" onClick={copy}>Copy JSON</Button>
          <Button variant="secondary" size="sm" onClick={download}>Download</Button>
        </div>
        <pre className="bg-muted rounded-md p-4 text-xs overflow-auto max-h-[60vh]">{json}</pre>
      </div>
    );
  }

  // No script generation in this view per requirement

  return (
    <div className="container max-w-6xl mx-auto py-8">
      <div className="mb-5 flex items-center justify-between">
        <div className="text-sm font-medium">Job: {id}</div>
        <div className="text-xs text-muted-foreground">Status: {data?.status || '...'}</div>
      </div>

      {isError && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 flex items-center justify-between">
          <div>Error: {data?.errorCode || 'UNKNOWN'}</div>
          <Button size="sm" onClick={onRetry} disabled={retrying}>
            {retrying ? 'Retrying…' : 'Retry'}
          </Button>
        </div>
      )}

      {isLoading && (
        <Card className="p-6 space-y-4">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-4 w-1/2" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
          <Skeleton className="h-6 w-40" />
          <div className="grid grid-cols-3 gap-2">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
        </Card>
      )}

      {!isLoading && result && (
        <>
          <Card className="p-6 mb-6">
            <div className="text-sm font-medium mb-2">Summary</div>
            <div className="text-sm text-foreground/90 whitespace-pre-line">{result.summary}</div>
          </Card>

          <Tabs defaultValue="per" className="space-y-4">
            <TabsList>
              <TabsTrigger value="per">Per-Video</TabsTrigger>
              <TabsTrigger value="diff">Diff</TabsTrigger>
              <TabsTrigger value="actions">Actions</TabsTrigger>
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
              {process.env.NEXT_PUBLIC_DEBUG_TABS === '1' && (
                <TabsTrigger value="raw">Raw</TabsTrigger>
              )}
            </TabsList>

            <TabsContent value="per">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Card className="p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium">Video A</div>
                    <div className="text-xs text-muted-foreground">Score: {result.perVideo.A.score}{result.perVideo.A.grade ? ` (${result.perVideo.A.grade})` : ''}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium">Highlights</div>
                    <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
                      {result.perVideo.A.highlights.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <div className="text-xs font-medium">Issues</div>
                    <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
                      {result.perVideo.A.issues.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ul>
                  </div>
                </Card>

                <Card className="p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium">Video B</div>
                    <div className="text-xs text-muted-foreground">Score: {result.perVideo.B.score}{result.perVideo.B.grade ? ` (${result.perVideo.B.grade})` : ''}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium">Highlights</div>
                    <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
                      {result.perVideo.B.highlights.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <div className="text-xs font-medium">Issues</div>
                    <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
                      {result.perVideo.B.issues.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ul>
                  </div>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="diff">
              <Card className="p-4">
                {result.diff.length === 0 ? (
                  <div className="text-sm text-muted-foreground">No differences captured.</div>
                ) : (
                  <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
                    {result.diff.map((d, i) => (
                      <li key={i}>
                        <span className="font-medium">[{d.aspect}]</span> {d.note}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </TabsContent>

            <TabsContent value="actions">
              <Card className="p-4">
                <ol className="list-decimal pl-5 text-sm text-muted-foreground space-y-1">
                  {result.actions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ol>
              </Card>
            </TabsContent>

            <TabsContent value="timeline">
              <Card className="p-4">
                {result.timeline.length === 0 ? (
                  <div className="text-sm text-muted-foreground">No timeline items.</div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-full">
                    {result.timeline.map((t: any, i: number) => (
                      <div key={i} className="rounded-xl border p-4 bg-white shadow-sm max-w-full text-sm">
                        <div className="mb-2 text-xs text-muted-foreground">Item {i + 1}</div>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                          <div>
                            <div className="font-medium mb-1">A</div>
                            <div className="text-muted-foreground">{t.A?.phase ? `phase: ${t.A.phase}` : ''}</div>
                            {t.A?.issue && <div className="text-muted-foreground whitespace-pre-wrap break-words">issue: {t.A.issue}</div>}
                            {t.A?.fix_hint && <div className="text-muted-foreground whitespace-pre-wrap break-words">fix: {t.A.fix_hint}</div>}
                          </div>
                          <div>
                            <div className="font-medium mb-1">B</div>
                            <div className="text-muted-foreground">{t.B?.phase ? `phase: ${t.B.phase}` : ''}</div>
                            {t.B?.issue && <div className="text-muted-foreground whitespace-pre-wrap break-words">issue: {t.B.issue}</div>}
                            {t.B?.fix_hint && <div className="text-muted-foreground whitespace-pre-wrap break-words">fix: {t.B.fix_hint}</div>}
                          </div>
                          <div>
                            <div className="font-medium mb-1">Gap</div>
                            <div className="text-muted-foreground">{t.gap?.aspect ? `aspect: ${t.gap.aspect}` : ''}</div>
                            {t.gap?.severity && <div className="text-muted-foreground">severity: {t.gap.severity}</div>}
                            {t.gap?.hint && <div className="text-muted-foreground whitespace-pre-wrap break-words">hint: {t.gap.hint}</div>}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </TabsContent>
            
            {process.env.NEXT_PUBLIC_DEBUG_TABS === '1' && (
              <TabsContent value="raw">
                <DebugRaw job={data} />
              </TabsContent>
            )}
          </Tabs>

          {result.improvementSummary && (
            <Card className="p-6 mt-6">
              <div className="text-sm font-medium mb-2">Improvement Summary</div>
              <div className="text-sm text-foreground/90 whitespace-pre-line">
                {result.improvementSummary}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
