import { readFile } from 'node:fs/promises';

const DEFAULT_PROMPTS_FILE = process.env.PROMPTS_FILE || 'prompt.md';
const FAB_ANCHOR = process.env.PROMPT_FAB_ANCHOR || 'FAB Prompt (Final English Version)';
const COMPARE_ANCHOR =
  process.env.PROMPT_COMPARE_ANCHOR ||
  '[TITLE] TikTok Shop Video Compare — Full Prompt with Built-in Knowledge Base (JSON-only)';

export async function readPromptsFile(): Promise<string> {
  const file = DEFAULT_PROMPTS_FILE;
  const content = await readFile(file, 'utf8');
  return content;
}

function sliceByAnchor(content: string, anchor: string, nextAnchor?: string): string {
  const start = content.indexOf(anchor);
  if (start === -1) throw new Error(`Prompt anchor not found: ${anchor}`);
  const sliceStart = start;
  if (!nextAnchor) return content.slice(sliceStart).trim();
  const end = content.indexOf(nextAnchor, sliceStart + anchor.length);
  return (end === -1 ? content.slice(sliceStart) : content.slice(sliceStart, end)).trim();
}

export async function getFabPrompt(): Promise<string> {
  const content = await readPromptsFile();
  // FAB section ends at first --- after anchor, if present
  const afterAnchor = content.slice(content.indexOf(FAB_ANCHOR));
  const dashIdx = afterAnchor.indexOf('\n---');
  if (dashIdx !== -1) {
    return afterAnchor.slice(0, dashIdx).trim();
  }
  return sliceByAnchor(content, FAB_ANCHOR);
}

export async function getComparePrompt(): Promise<string> {
  const content = await readPromptsFile();
  return sliceByAnchor(content, COMPARE_ANCHOR);
}

