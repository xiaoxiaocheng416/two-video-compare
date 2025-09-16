"use client";
import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type FabInfo = {
  productName: string;
  collectionId: string;
  fabVersionId: string;
  version: number;
  summary: string;
  features?: string[];
  advantages?: string[];
  benefits?: string[];
};

type UploadResp = { success: true; data: { fileKey: string; sizeMB: number; mime: string } } | { success: false; errorCode: string };

const TIKTOK_RE = /^https?:\/\/([a-z0-9-]+\.)*tiktok\.com\/.+/i;

export default function ComparePage() {
  const params = useParams();
  const locale = (params as any).locale as string;
  const router = useRouter();
  const sp = useSearchParams();
  const collectionId = sp.get('collectionId') || '';
  const fabVersionId = sp.get('fabVersionId') || '';

  const [fab, setFab] = useState<FabInfo | null>(null);
  const [versions, setVersions] = useState<{ fabVersionId: string; version: number; summary: string }[]>([]);
  const [fabLoading, setFabLoading] = useState(true);

  // A/B form state
  const [typeA, setTypeA] = useState<'tiktok' | 'upload'>('tiktok');
  const [urlA, setUrlA] = useState('');
  const [fileA, setFileA] = useState<{ fileKey: string; name: string; sizeMB: number } | null>(null);
  const [notesA, setNotesA] = useState('');

  const [typeB, setTypeB] = useState<'tiktok' | 'upload'>('upload');
  const [urlB, setUrlB] = useState('');
  const [fileB, setFileB] = useState<{ fileKey: string; name: string; sizeMB: number } | null>(null);
  const [notesB, setNotesB] = useState('');

  const [uploadingA, setUploadingA] = useState(false);
  const [uploadingB, setUploadingB] = useState(false);
  const [running, setRunning] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editState, setEditState] = useState<{ summary: string; features: string[]; advantages: string[]; benefits: string[] } | null>(null);
  const [editDirty, setEditDirty] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStage, setJobStage] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);

  useEffect(() => {
    let abort = false;
    async function loadFab() {
      try {
        setFabLoading(true);
        setGlobalError(null);
        // pull from query or localStorage fallback
        let cId = collectionId || undefined;
        let vId = fabVersionId || undefined;
        if ((!cId || !vId) && typeof window !== 'undefined') {
          const raw = localStorage.getItem('lastFabRef');
          if (raw) {
            try {
              const saved = JSON.parse(raw);
              cId = cId ?? saved?.collectionId;
              vId = vId ?? saved?.fabVersionId;
            } catch {}
          }
        }

        if (!vId) throw new Error('MISSING_FAB_VERSION_ID');

        const [vRes, listRes] = await Promise.all([
          fetch(`/api/fab/version?fabVersionId=${encodeURIComponent(vId)}`),
          cId ? fetch(`/api/fab/versions?collectionId=${encodeURIComponent(cId)}`) : Promise.resolve(new Response(JSON.stringify({ success: true, data: [] }), { status: 200 })),
        ]);
        const vJson = await vRes.json();
        const listJson = await listRes.json();
        if (!abort) {
          if (vRes.ok && vJson?.success) {
            const d = vJson.data;
            setFab({
              productName: d.productName,
              collectionId: d.collectionId,
              fabVersionId: d.fabVersionId,
              version: d.version,
              summary: d.summary ?? '',
              features: d.features || [],
              advantages: d.advantages || [],
              benefits: d.benefits || [],
            });
          } else {
            setFab(null);
            setGlobalError('Failed to load FAB info');
          }
          if (listRes.ok && listJson?.success) setVersions(listJson.data);
        }
      } catch (e) {
        if (!abort) setGlobalError('Failed to load FAB info');
      } finally {
        setFabLoading(false);
      }
    }
    loadFab();
    return () => {
      abort = true;
    };
  }, [collectionId, fabVersionId]);

  const validA = useMemo(() => {
    if (typeA === 'tiktok') return TIKTOK_RE.test(urlA.trim());
    return !!fileA?.fileKey;
  }, [typeA, urlA, fileA]);
  const validB = useMemo(() => {
    if (typeB === 'tiktok') return TIKTOK_RE.test(urlB.trim());
    return !!fileB?.fileKey;
  }, [typeB, urlB, fileB]);

  // warn user about unsaved edit when leaving
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (editDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [editDirty]);

  async function saveNewVersion() {
    if (!fab || !editState) return;
    const okLen = (arr: string[]) => Array.isArray(arr) && arr.filter((x) => x && x.trim()).length >= 2 && arr.filter((x) => x && x.trim()).length <= 3;
    if (!okLen(editState.features) || !okLen(editState.advantages) || !okLen(editState.benefits)) {
      setGlobalError('Each section must have 2–3 items');
      return;
    }
    try {
      setRunning(true);
      const res = await fetch('/api/fab/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collectionId: fab.collectionId,
          productName: fab.productName,
          summary: editState.summary,
          features: editState.features,
          advantages: editState.advantages,
          benefits: editState.benefits,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        setGlobalError('Failed to save new version');
        return;
      }
      const { collectionId: cId, fabVersionId: vId, version } = json.data;
      const qs = new URLSearchParams(window.location.search);
      qs.set('collectionId', cId);
      qs.set('fabVersionId', vId);
      window.history.replaceState(null, '', `?${qs.toString()}`);
      try {
        localStorage.setItem('lastFabRef', JSON.stringify({ collectionId: cId, fabVersionId: vId, productName: fab.productName }));
      } catch {}
      setFab({
        productName: fab.productName,
        collectionId: cId,
        fabVersionId: vId,
        version,
        summary: editState.summary,
        features: editState.features,
        advantages: editState.advantages,
        benefits: editState.benefits,
      });
      setVersions((prev) => [{ fabVersionId: vId, version, summary: editState.summary }, ...prev.filter((x) => x.fabVersionId !== vId)]);
      setEditOpen(false);
      setEditDirty(false);
    } finally {
      setRunning(false);
    }
  }

  const [globalError, setGlobalError] = useState<string | null>(null);
  const [errorA, setErrorA] = useState<string | null>(null);
  const [errorB, setErrorB] = useState<string | null>(null);

  async function upload(which: 'A' | 'B', f: File) {
    const sizeMB = f.size / (1024 * 1024);
    const fd = new FormData();
    fd.append('file', f);
    which === 'A' ? setUploadingA(true) : setUploadingB(true);
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const json: UploadResp = await res.json();
      if (!res.ok || !('success' in json) || !json.success) {
        const msg = (json as any)?.errorCode === 'TOO_LARGE' ? 'File too large (>50MB)' : 'Upload failed';
        which === 'A' ? setErrorA(msg) : setErrorB(msg);
        return;
      }
      const { fileKey, sizeMB: serverMB } = json.data;
      const entry = { fileKey, name: f.name, sizeMB: Math.round((serverMB ?? sizeMB) * 100) / 100 };
      if (which === 'A') setFileA(entry);
      else setFileB(entry);
    } catch (e) {
      which === 'A' ? setErrorA('Upload failed') : setErrorB('Upload failed');
    } finally {
      which === 'A' ? setUploadingA(false) : setUploadingB(false);
    }
  }

  async function runCompare() {
    if (!fab) return;
    if (!validA || !validB) return;
    setRunning(true);
    try {
      const body: any = {
        collectionId: fab.collectionId,
        fabVersionId: fab.fabVersionId,
        A: typeA === 'tiktok' ? { type: 'tiktok', url: urlA.trim(), notes: notesA || undefined } : { type: 'upload', fileKey: fileA!.fileKey, notes: notesA || undefined },
        B: typeB === 'tiktok' ? { type: 'tiktok', url: urlB.trim(), notes: notesB || undefined } : { type: 'upload', fileKey: fileB!.fileKey, notes: notesB || undefined },
      };
      const res = await fetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        const code = json?.errorCode || 'SERVICE_ERROR';
        if (code === 'INVALID_URL') setGlobalError('Only TikTok links are supported (tiktok.com).');
        else if (code === 'TIMEOUT') setGlobalError('Request timed out — Retry');
        else setGlobalError('Service error — Retry');
        return;
      }
      const jid = json.data.jobId as string;
      setJobId(jid);
      setJobStatus('queued');
      setJobStage('queued');
      setJobError(null);
      // start local polling; navigation will occur on done
      pollJobUntilDone(jid);
    } catch (e) {
      setGlobalError('Service error — Retry');
    } finally {
      // keep running while polling
    }
  }

  async function pollJobUntilDone(id: string) {
    const deadline = Date.now() + 60000; // 60s UI timeout for bar
    const tick = async () => {
      const r = await fetch(`/api/jobs/${id}`, { cache: 'no-store' });
      const j = await r.json();
      if (r.ok && j?.success) {
        setJobStatus(j.data.status);
        setJobStage(j.data.meta?.stage || null);
        setJobError(j.data.errorCode || null);
        if (j.data.status === 'done') {
          setRunning(false);
          router.push(`/${locale}/jobs/${id}`);
          return;
        }
        if (j.data.status === 'error') {
          setRunning(false);
          return;
        }
      }
      if (Date.now() >= deadline) {
        setJobStatus('error');
        setJobError('TIMEOUT');
        setRunning(false);
        return;
      }
      setTimeout(tick, 1500);
    };
    setTimeout(tick, 0);
  }

  function resetForm() {
    setTypeA('tiktok');
    setUrlA('');
    setFileA(null);
    setNotesA('');
    setTypeB('upload');
    setUrlB('');
    setFileB(null);
    setNotesB('');
  }

  return (
    <div className="container max-w-5xl mx-auto py-8">
      {globalError && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 flex items-center gap-3">
          <div>{globalError}</div>
          <Button variant="link" className="px-0 h-auto" onClick={() => router.push(`/${locale}/fab`)}>
            Go to FAB
          </Button>
        </div>
      )}
      {/* Top bar */}
      <div className="mb-6">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium">
            {fab ? (
              <>
                FAB v{fab.version} — {fab.productName}
              </>
            ) : (
              'Loading FAB…'
            )}
          </div>
          <div>
            <select
              className="border rounded-md px-2 py-1 text-sm"
              value={fab?.fabVersionId || ''}
              onChange={(e) => {
                const nextId = e.target.value;
                if (!nextId || !fab) return;
                if (running || jobId) return; // disable switching while running
                if (editDirty) {
                  const ok = window.confirm('You have unsaved changes. Discard and switch version?');
                  if (!ok) return;
                  setEditDirty(false);
                }
                const qs = new URLSearchParams(window.location.search);
                qs.set('collectionId', fab.collectionId);
                qs.set('fabVersionId', nextId);
                router.push(`/${locale}/compare?${qs.toString()}`);
              }}
            >
              {(versions.length ? versions : fab ? [{ fabVersionId: fab.fabVersionId, version: fab.version, summary: fab.summary }] : []).map(
                (v) => (
                  <option key={v.fabVersionId} value={v.fabVersionId}>
                    v{v.version}
                  </option>
                )
              )}
            </select>
          </div>
        </div>
        <div className="mt-2 text-sm text-muted-foreground">
          Summary: {fab?.summary || '-'}
        </div>
        {jobId && (
          <div className="mt-3 rounded-md border bg-muted/30 px-3 py-2 text-sm flex items-center gap-3">
            <span className="animate-pulse">●</span>
            <span>
              Status: {jobStatus} {jobStage ? `(${jobStage})` : ''}
              {jobError ? ` — ${jobError}` : ''}
            </span>
            {jobError === 'TIMEOUT' && (
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  if (!jobId) return;
                  await fetch(`/api/jobs/${jobId}/retry`, { method: 'POST' });
                  setRunning(true);
                  setJobStatus('queued');
                  setJobStage('queued');
                  setJobError(null);
                  pollJobUntilDone(jobId);
                }}
              >
                Retry
              </Button>
            )}
          </div>
        )}
        {fab && (
          <div className="mt-2 flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setDetailsOpen((s) => !s)}>
              {detailsOpen ? 'Hide FAB details' : 'View FAB details'}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setEditState({
                  summary: fab.summary,
                  features: [...(fab.features || []).slice(0, 3)],
                  advantages: [...(fab.advantages || []).slice(0, 3)],
                  benefits: [...(fab.benefits || []).slice(0, 3)],
                });
                setEditDirty(false);
                setEditOpen(true);
              }}
            >
              Edit
            </Button>
          </div>
        )}
        {detailsOpen && fab && (
          <Card className="mt-3 p-4 space-y-3">
            <div>
              <div className="text-xs font-medium text-muted-foreground">Features</div>
              <ul className="list-disc pl-5 text-sm text-muted-foreground">
                {(fab.features || []).map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-xs font-medium text-muted-foreground">Advantages</div>
              <ul className="list-disc pl-5 text-sm text-muted-foreground">
                {(fab.advantages || []).map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-xs font-medium text-muted-foreground">Benefits</div>
              <ul className="list-disc pl-5 text-sm text-muted-foreground">
                {(fab.benefits || []).map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </div>
          </Card>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Video A */}
        <Card className="p-5 space-y-4">
          <div className="text-sm font-medium">Video A (to improve)</div>
          <div>
            <RadioGroup value={typeA} onValueChange={(v) => setTypeA(v as any)} className="flex gap-4">
              <div className="flex items-center gap-2">
                <RadioGroupItem value="tiktok" id="a-tiktok" />
                <Label htmlFor="a-tiktok">TikTok URL</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="upload" id="a-upload" />
                <Label htmlFor="a-upload">Upload</Label>
              </div>
            </RadioGroup>
          </div>
          {typeA === 'tiktok' ? (
            <div className="space-y-1">
              <Input placeholder="https://www.tiktok.com/@user/video/…" value={urlA} onChange={(e) => setUrlA(e.target.value)} />
              <div className="text-xs text-muted-foreground">Only *.tiktok.com is supported.</div>
              {!validA && urlA.trim() && (
                <div className="text-xs text-red-500">Only TikTok links are supported (tiktok.com).</div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {!fileA ? (
                <div>
                  <input
                    type="file"
                    accept="video/*"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) upload('A', f);
                    }}
                    disabled={running || !!jobId}
                  />
                  <div className="text-xs text-muted-foreground">Drop or click to select (≤50MB)</div>
                  {uploadingA && <div className="text-xs">Uploading…</div>}
                  {errorA && <div className="text-xs text-red-500">{errorA}</div>}
                </div>
              ) : (
                <div className="flex items-center justify-between text-sm">
                  <div>
                    {fileA.name} · {fileA.sizeMB}MB
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => setFileA(null)} disabled={running || !!jobId}>
                    Replace
                  </Button>
                </div>
              )}
            </div>
          )}
          <div>
            <label className="text-xs text-muted-foreground">Notes (optional)</label>
            <Input placeholder="e.g., Hook is weak" value={notesA} onChange={(e) => setNotesA(e.target.value)} />
          </div>
        </Card>

        {/* Video B */}
        <Card className="p-5 space-y-4">
          <div className="text-sm font-medium">Video B (reference / Pro)</div>
          <div>
            <RadioGroup value={typeB} onValueChange={(v) => setTypeB(v as any)} className="flex gap-4">
              <div className="flex items-center gap-2">
                <RadioGroupItem value="tiktok" id="b-tiktok" />
                <Label htmlFor="b-tiktok">TikTok URL</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="upload" id="b-upload" />
                <Label htmlFor="b-upload">Upload</Label>
              </div>
            </RadioGroup>
          </div>
          {typeB === 'tiktok' ? (
            <div className="space-y-1">
              <Input placeholder="https://www.tiktok.com/@user/video/…" value={urlB} onChange={(e) => setUrlB(e.target.value)} />
              <div className="text-xs text-muted-foreground">Only *.tiktok.com is supported.</div>
              {!validB && urlB.trim() && (
                <div className="text-xs text-red-500">Only TikTok links are supported (tiktok.com).</div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {!fileB ? (
                <div>
                  <input
                    type="file"
                    accept="video/*"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) upload('B', f);
                    }}
                    disabled={running || !!jobId}
                  />
                  <div className="text-xs text-muted-foreground">Drop or click to select (≤50MB)</div>
                  {uploadingB && <div className="text-xs">Uploading…</div>}
                  {errorB && <div className="text-xs text-red-500">{errorB}</div>}
                </div>
              ) : (
                <div className="flex items-center justify-between text-sm">
                  <div>
                    {fileB.name} · {fileB.sizeMB}MB
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => setFileB(null)} disabled={running || !!jobId}>
                    Replace
                  </Button>
                </div>
              )}
            </div>
          )}
          <div>
            <label className="text-xs text-muted-foreground">Notes (optional)</label>
            <Input placeholder="e.g., Great hook & pacing" value={notesB} onChange={(e) => setNotesB(e.target.value)} />
          </div>
        </Card>
      </div>

      <div className="mt-6 flex gap-3">
        <Button onClick={runCompare} disabled={!validA || !validB || running || !fab || fabLoading}>
          {running ? 'Running…' : 'Run Compare'}
        </Button>
        <Button variant="ghost" onClick={resetForm}>
          Reset
        </Button>
      </div>

      <Dialog
        open={editOpen}
        onOpenChange={(o) => {
          if (!o && editDirty) {
            const ok = window.confirm('Discard unsaved changes?');
            if (!ok) return;
          }
          setEditOpen(o);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit FAB (save as new version)</DialogTitle>
          </DialogHeader>
          {editState && (
            <div className="space-y-3 max-h-[60vh] overflow-auto pr-1">
              <div>
                <Label className="text-xs text-muted-foreground">Summary</Label>
                <Textarea
                  value={editState.summary}
                  onChange={(e) => {
                    setEditState({ ...editState, summary: e.target.value });
                    setEditDirty(true);
                  }}
                  rows={3}
                />
              </div>
              {(['features', 'advantages', 'benefits'] as const).map((k) => (
                <div key={k} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">{k}</Label>
                    <div className="text-xs text-muted-foreground">2–3 items</div>
                  </div>
                  {(editState[k] as string[]).map((val, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <Input
                        value={val}
                        onChange={(e) => {
                          const arr = [...(editState[k] as string[])];
                          arr[idx] = e.target.value;
                          setEditState({ ...editState, [k]: arr });
                          setEditDirty(true);
                        }}
                      />
                      {(editState[k] as string[]).length > 2 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            const arr = (editState[k] as string[]).filter((_, i) => i !== idx);
                            setEditState({ ...editState, [k]: arr });
                            setEditDirty(true);
                          }}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  ))}
                  {(editState[k] as string[]).length < 3 && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setEditState({ ...editState, [k]: [...(editState[k] as string[]), ''] });
                        setEditDirty(true);
                      }}
                    >
                      + Add
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveNewVersion} disabled={running || fabLoading}>
              Save as New Version
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
