// CJK support for the jsPDF "High Res" export.
//
// jsPDF's built-in fonts (helvetica/times/courier) have no CJK glyphs, so CJK Web-books used to be rerouted to the
// reader-mode print export. Instead, a real Unicode TrueType font is registered in the jsPDF document and every
// setFont() call is mapped onto it, which keeps the editorial layout (cover, TOC, cards, images, link annotations)
// and produces selectable/searchable text.

export const CJK_FONT_FAMILY = 'NotoSansSC';
const CJK_FONT_FILE = 'NotoSansSC-Subset.ttf';

export function getCjkFontUrl(): string {
  const base = (import.meta as any)?.env?.BASE_URL ?? '/';
  return `${base}fonts/${CJK_FONT_FILE}`;
}

const CJK_CHARS = '\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\uff00-\uffef';
// Punctuation that must not start a line / must not end a line (simple kinsoku rules).
const NO_LINE_START = new Set('，。₄；：！？）］｝〉》」』】〕”’…—·,.;:!?)]}%'.split(''));
const NO_LINE_END = new Set('（［｛〈《「『【〔“‘([{'.split(''));
const TOKEN_PATTERN = new RegExp(`[${CJK_CHARS}]|[^\\s${CJK_CHARS}]+|\\s+`, 'g');

/**
 * Greedy line wrapper that can break between any two CJK characters (jsPDF only breaks at spaces) while keeping
 * Latin words intact. `measure` returns the rendered width of a string in the current font/size.
 */
export function wrapMixedText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const paragraph of String(text ?? '').split(/\r?\n/)) {
    const tokens = paragraph.match(TOKEN_PATTERN) || [];
    let line = '';
    const flush = () => {
      if (line.trim()) out.push(line.replace(/\s+$/, ''));
      line = '';
    };
    for (const rawToken of tokens) {
      const isSpace = /^\s+$/.test(rawToken);
      if (isSpace && !line) continue;
      const token = isSpace ? ' ' : rawToken;

      if (!isSpace && measure(token) > maxWidth) {
        // A single Latin run wider than the line (long URL etc.): split it per character.
        for (const ch of token) {
          if (line && measure(line + ch) > maxWidth) flush();
          line += ch;
        }
        continue;
      }

      if (line && measure(line + token) > maxWidth) {
        if (isSpace) continue;
        const prevChar = line.slice(-1);
        if (NO_LINE_START.has(token[0]) || NO_LINE_END.has(prevChar)) {
          line += token; // keep the punctuation attached rather than orphaning it
          continue;
        }
        flush();
      }
      line += token;
    }
    flush();
    if (!paragraph.trim()) out.push('');
  }
  return out.length ? out : [''];
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Rejects HTML (Vite's SPA fallback answers 200 for missing files), CFF/OTF fonts and truncated data. */
export function assertUsableTrueType(bytes: Uint8Array): void {
  if (bytes.length < 1024) throw new Error('CJK font file is missing or truncated.');
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const isTrueType = (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) || tag === 'true';
  if (tag === 'OTTO') throw new Error('CJK font is a CFF-based OpenType file; jsPDF needs a TrueType (glyf) .ttf.');
  if (!isTrueType) throw new Error('CJK font file is not a TrueType font (is it missing from /public/fonts?).');
}

let cachedFontBase64: string | null = null;

export async function loadCjkFontBase64(): Promise<string> {
  if (cachedFontBase64) return cachedFontBase64;
  const response = await fetch(getCjkFontUrl());
  if (!response.ok) throw new Error(`CJK font request failed (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assertUsableTrueType(bytes);
  cachedFontBase64 = toBase64(bytes);
  return cachedFontBase64;
}

/**
 * Registers the font and routes every setFont()/splitTextToSize() call of the existing drawing code through it.
 * The font has a single weight, so bold/italic requests render in the regular weight (hierarchy is carried by size
 * and colour).
 */
export function registerCjkFont(doc: any, fontBase64: string): void {
  doc.addFileToVFS(CJK_FONT_FILE, fontBase64);
  doc.addFont(CJK_FONT_FILE, CJK_FONT_FAMILY, 'normal');

  const originalSetFont = doc.setFont.bind(doc);
  doc.setFont = (..._args: unknown[]) => originalSetFont(CJK_FONT_FAMILY, 'normal');
  doc.setFont(CJK_FONT_FAMILY, 'normal');

  doc.splitTextToSize = (text: string | string[], maxWidth: number): string[] => {
    const measure = (s: string) => doc.getTextWidth(s);
    const parts = Array.isArray(text) ? text : [text];
    return parts.flatMap((part) => wrapMixedText(part, maxWidth, measure));
  };
}
