import type { SearchFallbackPayload, SearchFallbackResult } from '../types.ts';
import { isMeaningfulText, sanitizeNarrativeText } from '../utils/webBookRender.ts';
import { calculateTextSimilarity } from './searchFallbackShared.ts';

const CJK_REGEX = /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

function countWords(text: string): number {
  const cjkCount = (text.match(/[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g) || []).length;
  const nonCjk = text.replace(/[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g, ' ').trim();
  const nonCjkWords = nonCjk ? nonCjk.split(/\s+/).filter(Boolean).length : 0;
  return cjkCount + nonCjkWords;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|(?<=[。！？][”’」』）)]*)(?![”’」』）)])\s*/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function dedupeSentences(text: string, maxSentences = Number.POSITIVE_INFINITY): string[] {
  const unique: string[] = [];

  for (const sentence of splitSentences(text)) {
    const minLen = CJK_REGEX.test(sentence) ? 8 : 35;
    if (sentence.length < minLen) {
      continue;
    }

    if (unique.some((existing) => calculateTextSimilarity(existing, sentence) >= 0.88)) {
      continue;
    }

    unique.push(sentence);
    if (unique.length >= maxSentences) {
      break;
    }
  }

  return unique;
}

function sanitizeFallbackEvidenceText(text: string, maxSentences = 4): string {
  const rawCollapsed = text
    .replace(/\s+/g, ' ')
    .replace(/\.\.\.\s*(?=[A-Z])/g, ' ')
    .trim();
  const cleaned = sanitizeNarrativeText(text)
    .replace(/\s+/g, ' ')
    .replace(/\.\.\.\s*(?=[A-Z])/g, ' ')
    .trim();
  const candidate = cleaned || rawCollapsed;
  const uniqueSentences = dedupeSentences(candidate, maxSentences);

  if (uniqueSentences.length > 0) {
    return uniqueSentences.join(' ');
  }

  return candidate;
}

function buildFallbackResultEvidenceText(result: SearchFallbackResult): string {
  return sanitizeNarrativeText([
    result.excerpt || '',
    result.snippet || '',
  ].join(' ')).replace(/\s+/g, ' ').trim();
}

export function hasUsableFallbackPayloadEvidence(
  payload?: SearchFallbackPayload,
  minWords = 35,
  maxSentences = 12
): boolean {
  if (!payload) {
    return false;
  }

  const summary = sanitizeFallbackEvidenceText(payload.summary, Math.min(6, maxSentences));
  if (countWords(summary) >= minWords && isMeaningfulText(summary)) {
    return true;
  }

  const aggregateEvidence = sanitizeFallbackEvidenceText(
    payload.results.map((result) => buildFallbackResultEvidenceText(result)).join(' '),
    maxSentences
  );

  return countWords(aggregateEvidence) >= minWords && isMeaningfulText(aggregateEvidence);
}
