"use client";

import { useCallback, useMemo, useState } from 'react';
import { useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import ImagePasteArea from '@/components/ImagePasteArea';

type FabData = {
  summary: string;
  features: string[];
  advantages: string[];
  benefits: string[];
  note?: string;
};

type ConfirmResp = { success: true; data: { collectionId: string; fabVersionId: string } };

export default function FabPage() {
  const locale = useLocale();
  const router = useRouter();

  const [productName, setProductName] = useState('');
  const [description, setDescription] = useState('');
  const [images, setImages] = useState<{ mime: string; data: string }[]>([]);

  const [isGenerating, setIsGenerating] = useState(false);
  const [fab, setFab] = useState<FabData | null>(null);
  const [editSection, setEditSection] = useState<null | 'features' | 'advantages' | 'benefits'>(null);
  const [confirmInfo, setConfirmInfo] = useState<{ collectionId: string; fabVersionId: string } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [showRegenerateDialog, setShowRegenerateDialog] = useState(false);

  const canConfirm = useMemo(() => {
    if (!fab) return false;
    const ok = (a?: string[]) => Array.isArray(a) && a.filter((x) => x && x.trim()).length >= 2;
    return ok(fab.features) && ok(fab.advantages) && ok(fab.benefits);
  }, [fab]);

  const handleGenerate = useCallback(async () => {
    if (!productName.trim()) {
      toast.error('Product name is required');
      return;
    }
    setIsGenerating(true);
    setConfirmInfo(null);
    try {
      const res = await fetch('/api/fab/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productName,
          description: description || undefined,
          images,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        if (json?.errorCode === 'TIMEOUT') toast.error('Generation timed out — Retry');
        else toast.error('Service error — Retry');
        return;
      }
      setFab(json.data as FabData);
      toast.success('FAB generated');
    } catch (e: any) {
      toast.error('Service error — Retry');
    } finally {
      setIsGenerating(false);
    }
  }, [productName, description, images]);

  const handleConfirm = useCallback(async () => {
    if (!fab) return;
    try {
      setIsSaving(true);
      const res = await fetch('/api/fab/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productName,
          description: description || undefined,
          imageRef: images.length ? 'inline' : undefined,
          summary: fab.summary || undefined,
          features: fab.features,
          advantages: fab.advantages,
          benefits: fab.benefits,
        }),
      });
      const json: ConfirmResp | any = await res.json();
      if (!res.ok || !json?.success) {
        toast.error('Save failed — Retry');
        return;
      }
      const { collectionId, fabVersionId } = json.data;
      setConfirmInfo({ collectionId, fabVersionId });
      try {
        if (typeof window !== 'undefined') {
          localStorage.setItem(
            'lastFabRef',
            JSON.stringify({ collectionId, fabVersionId, productName })
          );
        }
      } catch {}
      toast.success('FAB saved');
    } catch (e) {
      toast.error('Service error — Retry');
    } finally {
      setIsSaving(false);
    }
  }, [fab, productName, description, images]);

  const handleReset = useCallback(() => {
    setProductName('');
    setDescription('');
    setImages([]);
    setFab(null);
    setConfirmInfo(null);
  }, []);

  const gotoCompare = useCallback(() => {
    if (!confirmInfo) return;
    router.push(`/${locale}/compare?collectionId=${confirmInfo.collectionId}&fabVersionId=${confirmInfo.fabVersionId}`);
  }, [confirmInfo, locale, router]);

  const Section = ({
    title,
    keyName,
  }: {
    title: string;
    keyName: 'features' | 'advantages' | 'benefits';
  }) => {
    if (!fab) return null;
    const editing = editSection === keyName;
    const values = fab[keyName] || [];

    const updateVal = (idx: number, val: string) => {
      setFab((prev) => {
        if (!prev) return prev;
        const arr = [...(prev[keyName] || [])];
        arr[idx] = val;
        return { ...prev, [keyName]: arr } as FabData;
      });
    };
    const addItem = () => {
      if (values.length >= 3) return;
      setFab((prev) => (prev ? { ...prev, [keyName]: [...values, ''] } : prev) as FabData);
    };
    const removeItem = (idx: number) => {
      if (values.length <= 2) return;
      setFab((prev) => {
        if (!prev) return prev;
        const arr = values.filter((_, i) => i !== idx);
        return { ...prev, [keyName]: arr } as FabData;
      });
    };

    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
          <Button variant="ghost" size="sm" onClick={() => setEditSection(editing ? null : keyName)}>
            {editing ? 'Done' : 'Edit'}
          </Button>
        </div>

        {!editing ? (
          <ul className="list-disc pl-5 space-y-2">
            {values.map((t, i) => (
              <li key={i} className="text-sm text-muted-foreground">
                {t || <span className="italic text-muted-foreground/70">(empty)</span>}
              </li>
            ))}
          </ul>
        ) : (
          <div className="space-y-2">
            {values.map((t, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={t}
                  placeholder={`Item ${i + 1}`}
                  onChange={(e) => updateVal(i, e.target.value)}
                />
                {values.length > 2 && (
                  <Button variant="ghost" size="sm" onClick={() => removeItem(i)}>
                    Remove
                  </Button>
                )}
              </div>
            ))}
            {values.length < 3 && (
              <Button variant="secondary" size="sm" onClick={addItem}>
                + Add
              </Button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="container max-w-4xl mx-auto py-8 pb-24">
      <header className="mb-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Product Compare (M1)</h1>
          <Badge variant="outline">EN / 中文</Badge>
        </div>
        <div className="mt-2 text-sm text-muted-foreground">Step ① Get FAB —— ② Confirm & Continue to Compare</div>
      </header>

      <div className="grid gap-6">
        {/* Product Info */}
        <Card className="p-5 space-y-4">
          <h2 className="text-sm font-medium">Product Info</h2>

          <div className="grid gap-2">
            <label className="text-xs text-muted-foreground">Product name *</label>
            <Input
              placeholder="Enter product name"
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
            />
          </div>

          <div className="grid gap-2">
            <label className="text-xs text-muted-foreground">Description (optional)</label>
            <Textarea
              placeholder="Add a brief description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>

          <div className="grid gap-2">
            <label className="text-xs text-muted-foreground">Images (optional)</label>
            <ImagePasteArea
              max={5}
              onImages={(arr) => setImages((prev) => [...prev, ...arr].slice(0, 5))}
            />
          </div>

          <div className="flex gap-2">
            <Button onClick={handleGenerate} disabled={isGenerating || !productName.trim()}>
              {isGenerating ? 'Generating…' : 'Generate FAB'}
            </Button>
            <Button variant="ghost" onClick={handleReset}>
              Reset
            </Button>
          </div>
        </Card>

        {/* Generated FAB */}
        {isGenerating && (
          <Card className="p-5 space-y-4">
            <h2 className="text-sm font-medium">Generated FAB</h2>
            <div className="grid gap-4">
              <div className="space-y-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-4 w-4/6" />
              </div>
            </div>
          </Card>
        )}

        {fab && !isGenerating && (
          <Card className="p-5 space-y-5">
            <h2 className="text-sm font-medium">Generated FAB</h2>

            {/* Summary */}
            <div>
              <h3 className="text-xs font-medium text-muted-foreground mb-1">Summary</h3>
              <p className="text-sm leading-6 text-foreground/90 whitespace-pre-line">{fab.summary || '-'}</p>
            </div>

            <Section title="Features (2–3)" keyName="features" />
            <Section title="Advantages (2–3)" keyName="advantages" />
            <Section title="Benefits (2–3)" keyName="benefits" />

            {fab.note && (
              <div className="text-xs text-muted-foreground">Note: {fab.note}</div>
            )}

            <div className="flex gap-2">
              <Button onClick={handleConfirm} disabled={!canConfirm || isSaving}>
                {isSaving ? 'Saving…' : 'Confirm FAB'}
              </Button>

              <Dialog open={showRegenerateDialog} onOpenChange={setShowRegenerateDialog}>
                <DialogTrigger asChild>
                  <Button variant="secondary">Regenerate</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Regenerate FAB?</DialogTitle>
                  </DialogHeader>
                  <div className="text-sm text-muted-foreground">
                    This will overwrite the current draft with a new generation. Continue?
                  </div>
                  <DialogFooter>
                    <Button variant="ghost" onClick={() => setShowRegenerateDialog(false)}>
                      Cancel
                    </Button>
                    <Button
                      onClick={async () => {
                        setShowRegenerateDialog(false);
                        await handleGenerate();
                      }}
                    >
                      Overwrite
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              {confirmInfo && (
                <div className="ml-auto" />
              )}
            </div>

            {confirmInfo && (
              <div className="mt-6 rounded-lg border bg-muted/30 p-4">
                <div className="mb-2 font-medium">FAB saved.</div>
                <div className="text-sm text-muted-foreground mb-3">
                  You can now compare two videos with this FAB version.
                </div>
                <Button
                  variant="default"
                  onClick={() =>
                    router.push(
                      `/${locale}/compare?collectionId=${confirmInfo.collectionId}&fabVersionId=${confirmInfo.fabVersionId}`
                    )
                  }
                >
                  Go to Compare A/B →
                </Button>
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
