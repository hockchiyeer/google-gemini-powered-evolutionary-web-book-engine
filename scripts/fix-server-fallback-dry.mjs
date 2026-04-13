/**
 * Applies the DRY fix to server/googleSearchFallback.ts:
 *  1. Adds calculateTextSimilarity to the import from searchFallbackShared.ts
 *  2. Removes the local FALLBACK_STOPWORDS duplicate
 *  3. Removes local tokenizeComparableText and calculateTextSimilarity duplicates
 *     (normalizeComparableText is kept because it is also used in
 *      buildSearchQueryVariants which is outside of calculateTextSimilarity)
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const filePath = resolve(__dirname, '../server/googleSearchFallback.ts');
let src = readFileSync(filePath, 'utf8');
const originalLength = src.length;

// ─── Fix 1: Add calculateTextSimilarity to the shared import ─────────────────
const importMarker = '  buildFallbackSearchUrl as buildSearchUrl,';
const importInsert  = '  buildFallbackSearchUrl as buildSearchUrl,\n  calculateTextSimilarity,';

if (src.includes(importInsert)) {
  console.log('Fix 1 already applied — skipping.');
} else if (src.includes(importMarker)) {
  src = src.replace(importMarker, importInsert);
  console.log('Fix 1 applied: calculateTextSimilarity added to shared import.');
} else {
  console.error('Fix 1 FAILED: import marker not found.');
  process.exit(1);
}

// ─── Fix 2: Remove local FALLBACK_STOPWORDS ───────────────────────────────────
// The block starts immediately after the NAVIGATION_NOISE constant closing ]);
const swOpen  = '\nconst FALLBACK_STOPWORDS = new Set([';
const swClose = '\n]);';

const swStart = src.indexOf(swOpen);
if (swStart === -1) {
  console.log('Fix 2: FALLBACK_STOPWORDS already removed — skipping.');
} else {
  // Find the FIRST closing ]); that belongs to FALLBACK_STOPWORDS
  const swEnd = src.indexOf(swClose, swStart + swOpen.length);
  if (swEnd === -1) {
    console.error('Fix 2 FAILED: closing ]); not found for FALLBACK_STOPWORDS.');
    process.exit(1);
  }
  // Cut from the opening \n through to the closing ]); (inclusive)
  src = src.slice(0, swStart) + src.slice(swEnd + swClose.length);
  console.log('Fix 2 applied: local FALLBACK_STOPWORDS removed.');
}

// ─── Fix 3: Remove local tokenizeComparableText ───────────────────────────────
// This function is only used inside the local calculateTextSimilarity below.
const tokFuncOpen  = '\nfunction tokenizeComparableText(';
const tokFuncEnd   = '\n}\n';

const tokStart = src.indexOf(tokFuncOpen);
if (tokStart === -1) {
  console.log('Fix 3a: tokenizeComparableText already removed — skipping.');
} else {
  const tokEnd = src.indexOf(tokFuncEnd, tokStart + tokFuncOpen.length);
  if (tokEnd === -1) {
    console.error('Fix 3a FAILED: closing brace of tokenizeComparableText not found.');
    process.exit(1);
  }
  src = src.slice(0, tokStart) + src.slice(tokEnd + tokFuncEnd.length - 1); // keep trailing \n
  console.log('Fix 3a applied: local tokenizeComparableText removed.');
}

// ─── Fix 4: Remove local calculateTextSimilarity ─────────────────────────────
// After removing tokenizeComparableText, the local calculateTextSimilarity is
// a plain duplicate of the one now imported from searchFallbackShared.ts.
const calcFuncOpen = '\nfunction calculateTextSimilarity(';
const calcFuncEnd  = '\n}\n';

const calcStart = src.indexOf(calcFuncOpen);
if (calcStart === -1) {
  console.log('Fix 4: local calculateTextSimilarity already removed — skipping.');
} else {
  const calcEnd = src.indexOf(calcFuncEnd, calcStart + calcFuncOpen.length);
  if (calcEnd === -1) {
    console.error('Fix 4 FAILED: closing brace of calculateTextSimilarity not found.');
    process.exit(1);
  }
  src = src.slice(0, calcStart) + src.slice(calcEnd + calcFuncEnd.length - 1);
  console.log('Fix 4 applied: local calculateTextSimilarity removed.');
}

writeFileSync(filePath, src, 'utf8');
console.log(`\nDone. File size: ${originalLength} → ${src.length} bytes.`);
