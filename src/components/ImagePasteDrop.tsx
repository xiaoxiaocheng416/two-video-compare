'use client';

import { useCallback, useRef, useState } from 'react';

export default function ImagePasteDrop({
  onImages,
  max = 5,
}: {
  onImages: (imgs: { mime: string; data: string }[]) => void;
  max?: number;
}) {
  const [previews, setPreviews] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fileToB64 = (file: File) =>
    new Promise<{ mime: string; data: string }>((res, rej) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = String(reader.result).split(',')[1] ?? '';
        res({ mime: file.type, data: base64 });
      };
      reader.onerror = rej;
      reader.readAsDataURL(file);
    });

  const handleFiles = useCallback(
    async (list: FileList | File[]) => {
      const files = Array.from(list).filter((f) => f.type.startsWith('image/')).slice(0, max);
      if (!files.length) return;
      const b64s = await Promise.all(files.map(fileToB64));
      setPreviews(files.map((f) => URL.createObjectURL(f)));
      onImages(b64s);
    },
    [max, onImages]
  );

  return (
    <div>
      <div
        className="border-input placeholder:text-muted-foreground focus:border-ring focus:ring-ring/50 focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 flex field-sizing-content min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none focus:ring-[3px] focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
        tabIndex={0}
        role="textbox"
        onClick={() => {
          // focus handled by browser; paste works when focused
        }}
        onDoubleClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          handleFiles(e.dataTransfer.files);
        }}
        onPaste={(e) => {
          const items = Array.from(e.clipboardData.items).filter((i) => i.type.startsWith('image/'));
          const files = items.map((i) => i.getAsFile()).filter(Boolean) as File[];
          if (files.length) handleFiles(files);
        }}
        aria-label="Paste or drag images"
      >
        <div className="text-sm text-muted-foreground/70 select-none">
          Paste (⌘/Ctrl+V) or drag & drop images here. Double‑click to choose files.
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => e.target.files && handleFiles(e.target.files)}
      />
      {previews.length > 0 && (
        <div className="mt-2 flex gap-2 flex-wrap">
          {previews.map((src, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={src} alt="" className="h-16 w-16 rounded-md object-cover border" />
          ))}
        </div>
      )}
      <div className="mt-2 text-xs text-muted-foreground/60">
        Supports multiple images. M1 sends all; server may limit to {max}.
      </div>
    </div>
  );
}
