'use client';
import { useCallback, useRef, useState } from 'react';

type B64 = { mime: string; data: string };

export default function ImagePasteArea({
  onImages,
  max = 5,
}: { onImages: (imgs: B64[]) => void; max?: number }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [previews, setPreviews] = useState<string[]>([]);

  const fileToB64 = (file: File) =>
    new Promise<B64>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res({ mime: file.type, data: String(r.result).split(',')[1] ?? '' });
      r.onerror = rej;
      r.readAsDataURL(file);
    });

  const handleFiles = useCallback(
    async (list: FileList | File[]) => {
      const files = Array.from(list).filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      const remain = Math.max(0, max - previews.length);
      const take = files.slice(0, remain);
      if (!take.length) return;

      const b64s = await Promise.all(take.map(fileToB64));
      setPreviews((prev) => [...prev, ...take.map((f) => URL.createObjectURL(f))].slice(0, max));
      onImages(b64s);
    },
    [max, previews.length, onImages]
  );

  return (
    <div className="space-y-2">
      <div
        tabIndex={0}
        className="rounded-md border border-input bg-background px-3 py-2 ring-offset-background transition hover:border-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 min-h-[128px]"
        onClick={(e) => (e.currentTarget as HTMLDivElement).focus()}
        onDoubleClick={() => fileRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          handleFiles(e.dataTransfer.files);
        }}
        onPaste={(e) => {
          const items = Array.from(e.clipboardData.items).filter(
            (i) => i.kind === 'file' && i.type.startsWith('image/')
          );
          const files = items.map((i) => i.getAsFile()).filter(Boolean) as File[];
          if (files.length) {
            e.preventDefault();
            handleFiles(files);
          }
        }}
      >
        {previews.length === 0 && (
          <div className="text-sm text-muted-foreground/60 select-none">
            Paste (⌘/Ctrl+V) or drag & drop images here. Double-click to choose files.
          </div>
        )}
        {previews.length > 0 && (
          <div className="mt-1 grid grid-cols-6 gap-2 md:grid-cols-8">
            {previews.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={src} alt="" className="h-16 w-16 rounded-md object-cover border" />
            ))}
          </div>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => e.target.files && handleFiles(e.target.files)}
      />

      <div className="text-xs text-muted-foreground/60">
        Supports multiple images. We’ll send up to {max}.
      </div>
    </div>
  );
}

