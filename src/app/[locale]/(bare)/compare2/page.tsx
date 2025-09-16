"use client";
import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
// Tabs removed (revert to card layout)

const TIKTOK_RE = /^https?:\/\/([a-z0-9-]+\.)*tiktok\.com\/.+/i;

export default function Compare2Page() {
  const [urlA, setUrlA] = useState('');
  const [urlB, setUrlB] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');

  const validA = TIKTOK_RE.test(urlA.trim());
  const validB = TIKTOK_RE.test(urlB.trim());

  async function runCompare() {
    if (!validA || !validB) return;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const base = (process.env.NEXT_PUBLIC_COMPARE_API_BASE as string) || '';
      const endpoint = base ? `${base.replace(/\/$/, '')}/compare2` : '/api/compare2';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ A: { type: 'url', value: urlA.trim() }, B: { type: 'url', value: urlB.trim() } }),
      });
      const data = await response.json();
      if (data?.success) setResult(data);
      else setError(data?.message || data?.errorCode || 'Unknown error');
    } catch (err: any) {
      setError(err?.message || 'Network error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container mx-auto p-6 max-w-6xl">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Two-Video Compare (v4)</h1>
        <p className="text-muted-foreground">Compare two TikTok videos with AI analysis</p>
      </header>

      <Card className="p-6 mb-6">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">Video A (TikTok URL)</label>
            <Input value={urlA} onChange={(e) => setUrlA(e.target.value)} placeholder="https://www.tiktok.com/@user/video/123..." />
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">Video B (TikTok URL)</label>
            <Input value={urlB} onChange={(e) => setUrlB(e.target.value)} placeholder="https://www.tiktok.com/@user/video/456..." />
          </div>
          <Button onClick={runCompare} disabled={!validA || !validB || loading} className="w-full">
            {loading ? 'Analyzing… up to ~90s' : 'Compare Videos'}
          </Button>
        </div>
      </Card>

      {error && (
        <Card className="p-4 mb-6 border-red-200 bg-red-50">
          <p className="text-red-600">Error: {error}</p>
        </Card>
      )}

      {result && (
        <div className="space-y-6">
          <Card className="p-6">
            <h2 className="text-xl font-semibold mb-3">Summary</h2>
            <p className="text-sm leading-relaxed">{result.result.summary}</p>
            <div className="mt-3 flex gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">Model: {result.model}</Badge>
              <Badge variant="outline">Duration: {result.durationMs}ms</Badge>
            </div>
          </Card>

          <div className="grid md:grid-cols-2 gap-6">
            <Card className="p-6">
              <h3 className="text-lg font-semibold mb-3">Video A</h3>
              <div className="mb-3">
                <Badge className="mr-2">Score: {result.result.perVideo.A.score}</Badge>
                <Badge variant="outline">Grade: {result.result.perVideo.A.grade}</Badge>
              </div>
              <div className="space-y-3">
                <div>
                  <h4 className="font-medium text-green-600">Highlights</h4>
                  <ul className="list-disc list-inside text-sm space-y-1">
                    {result.result.perVideo.A.highlights.map((h: string, i: number) => (
                      <li key={i}>{h}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h4 className="font-medium text-red-600">Issues</h4>
                  <ul className="list-disc list-inside text-sm space-y-1">
                    {result.result.perVideo.A.issues.map((issue: string, i: number) => (
                      <li key={i}>{issue}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </Card>

            <Card className="p-6">
              <h3 className="text-lg font-semibold mb-3">Video B</h3>
              <div className="mb-3">
                <Badge className="mr-2">Score: {result.result.perVideo.B.score}</Badge>
                <Badge variant="outline">Grade: {result.result.perVideo.B.grade}</Badge>
              </div>
              <div className="space-y-3">
                <div>
                  <h4 className="font-medium text-green-600">Highlights</h4>
                  <ul className="list-disc list-inside text-sm space-y-1">
                    {result.result.perVideo.B.highlights.map((h: string, i: number) => (
                      <li key={i}>{h}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h4 className="font-medium text-red-600">Issues</h4>
                  <ul className="list-disc list-inside text-sm space-y-1">
                    {result.result.perVideo.B.issues.map((issue: string, i: number) => (
                      <li key={i}>{issue}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </Card>
          </div>

          <Card className="p-6">
            <h2 className="text-xl font-semibold mb-3">Key Differences</h2>
            <ul className="list-disc list-inside space-y-1">
              {result.result.diff.map((d: string, i: number) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          </Card>

          <Card className="p-6">
            <h2 className="text-xl font-semibold mb-3">Recommended Actions</h2>
            <ol className="list-decimal list-inside space-y-1">
              {result.result.actions.map((action: string, i: number) => (
                <li key={i}>{action}</li>
              ))}
            </ol>
          </Card>

          <Card className="p-6 overflow-hidden">
            <h2 className="text-xl font-semibold mb-3">Timeline Analysis</h2>
            <div className="space-y-4 overflow-x-auto">
              {result.result.timeline.map((item: any, i: number) => {
                if (item.A && item.B) {
                  return (
                    <div key={i} className="border rounded-lg p-4 bg-gray-50 dark:bg-gray-900">
                      <div className="grid md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline">A: {item.A.phase}</Badge>
                            <Badge variant={item.A.severity === 'critical' || item.A.severity === 'high' ? 'destructive' : 'secondary'}>
                              {item.A.severity}
                            </Badge>
                          </div>
                          <p className="text-sm break-words"><strong>Time:</strong> {item.A.t}</p>
                          {item.A.spoken_excerpt && <p className="text-sm break-words italic">"{item.A.spoken_excerpt}"</p>}
                          {item.A.screen_text && <p className="text-sm break-words"><strong>Text:</strong> {item.A.screen_text}</p>}
                          {item.A.issue && <p className="text-sm text-red-600 break-words">Issue: {item.A.issue}</p>}
                          {item.A.fix_hint && <p className="text-sm text-blue-600 break-words">💡 {item.A.fix_hint}</p>}
                        </div>
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline">B: {item.B.phase}</Badge>
                            <Badge variant="secondary">{item.B.severity}</Badge>
                          </div>
                          <p className="text-sm break-words"><strong>Time:</strong> {item.B.t}</p>
                          {item.B.spoken_excerpt && <p className="text-sm break-words italic">"{item.B.spoken_excerpt}"</p>}
                          {item.B.screen_text && <p className="text-sm break-words"><strong>Text:</strong> {item.B.screen_text}</p>}
                          {item.B.visual_cue && <p className="text-sm break-words"><strong>Visual:</strong> {item.B.visual_cue}</p>}
                        </div>
                      </div>
                      {item.gap && (
                        <div className="mt-3 pt-3 border-t">
                          <p className="text-sm font-medium">Key Difference: {item.gap.aspect}</p>
                          <p className="text-sm text-muted-foreground break-words">{item.gap.hint}</p>
                        </div>
                      )}
                    </div>
                  );
                }
                return (
                  <div key={i} className="border-l-4 border-blue-200 pl-4">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      {item.labelA && <Badge variant="outline">A: {item.labelA}</Badge>}
                      {item.labelB && <Badge variant="outline">B: {item.labelB}</Badge>}
                      <Badge variant={item.severity === 'high' ? 'destructive' : item.severity === 'medium' ? 'default' : 'secondary'}>
                        {item.severity}
                      </Badge>
                    </div>
                    <p className="text-sm mb-1 break-words">{item.description}</p>
                    <p className="text-xs text-muted-foreground break-words">💡 {item.tip}</p>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card className="p-6 overflow-hidden">
            <h2 className="text-xl font-semibold mb-3">Improvement Summary</h2>
            <p className="whitespace-pre-wrap break-words">{result.result.improvementSummary}</p>
          </Card>

          {process.env.NEXT_PUBLIC_DEBUG_TABS && (
            <Card className="p-6">
              <h2 className="text-xl font-semibold mb-3">Debug Info</h2>
              <div className="text-sm space-y-2">
                <div>Metadata: {result._metrics?.metadataMs}ms</div>
                <div>Download: {result._metrics?.downloadMs}ms</div>
                <div>Sanitize: {result._metrics?.sanitizeMs}ms</div>
                <div>Upload: {result._metrics?.uploadMs}ms</div>
                <div>Model: {result._metrics?.modelMs}ms</div>
                <div>Parse: {result._metrics?.parseMs}ms</div>
              </div>
              <details className="mt-4">
                <summary className="cursor-pointer font-medium">Raw JSON</summary>
                <pre className="mt-2 p-3 bg-gray-100 rounded text-xs overflow-auto">{JSON.stringify(result, null, 2)}</pre>
              </details>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
