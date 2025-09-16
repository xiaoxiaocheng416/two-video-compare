export function toCamelCase(key: string): string {
  if (!key.includes('_')) return key;
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function keysToCamelDeep<T = any>(obj: any): T {
  if (Array.isArray(obj)) return obj.map((v) => keysToCamelDeep(v)) as any;
  if (obj && typeof obj === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[toCamelCase(k)] = keysToCamelDeep(v);
    }
    return out as T;
  }
  return obj as T;
}

export function limitString(s: string, max = 120): string {
  if (typeof s !== 'string') return '';
  return s.length <= max ? s : s.slice(0, max).trimEnd();
}

export function ensureArraySize(arr: string[], min: number, max: number): string[] {
  const a = Array.isArray(arr) ? [...arr] : [];
  if (a.length > max) return a.slice(0, max);
  if (a.length < min) {
    // pad with empty strings conservatively
    while (a.length < min) a.push('');
  }
  return a;
}

