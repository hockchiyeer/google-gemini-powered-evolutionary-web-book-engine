/**
 * Applies 4 precision fixes to evolutionService.ts:
 *  1. Imports calculateTextSimilarity from searchFallbackShared (DRY)
 *  2. Removes the local FALLBACK_STOPWORDS duplicate (DRY)
 *  3. Removes local normalizeComparableText / tokenizeComparableText /
 *     calculateTextSimilarity duplicates (DRY)
 *  4. Adds EvolveResult interface + rewrites evolve() to fix SE-1, SE-2, SE-3
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const filePath = resolve(__dirname, '../src/services/evolutionService.ts');
let src = readFileSync(filePath, 'utf8');
const originalLength = src.length;

// ─── Fix 1: Add calculateTextSimilarity to the shared import ─────────────────
const importMarker = '  buildFallbackSearchUrl as buildSearchUrl,';
const importInsert = '  buildFallbackSearchUrl as buildSearchUrl,\r\n  calculateTextSimilarity,';

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
const swStart = src.indexOf('\r\nconst FALLBACK_STOPWORDS = new Set([');
if (swStart === -1) {
  console.log('Fix 2: FALLBACK_STOPWORDS not found — already removed or missing.');
} else {
  // Find the closing ]);  The set literal ends at the first ']);' after the opening
  const swEnd = src.indexOf('\r\n]);', swStart);
  if (swEnd === -1) {
    console.error('Fix 2 FAILED: could not find closing ]); for FALLBACK_STOPWORDS.');
    process.exit(1);
  }
  // Remove from the leading \r\n through the closing ]);\r\n
  const endPos = swEnd + '\r\n]);'.length;
  src = src.slice(0, swStart) + src.slice(endPos);
  console.log('Fix 2 applied: local FALLBACK_STOPWORDS removed.');
}

// ─── Fix 3: Remove local normalizeComparableText / tokenizeComparableText /
//            calculateTextSimilarity ─────────────────────────────────────────
const funcBlock = '\r\nfunction normalizeComparableText(';
const funcBlockEnd = '\r\nfunction dedupeSentences(';
const fbStart = src.indexOf(funcBlock);
const fbEnd = src.indexOf(funcBlockEnd, fbStart);

if (fbStart === -1) {
  console.log('Fix 3: duplicate functions not found — already removed.');
} else if (fbEnd === -1) {
  console.error('Fix 3 FAILED: could not locate dedupeSentences after normalizeComparableText.');
  process.exit(1);
} else {
  src = src.slice(0, fbStart) + '\r\n' + src.slice(fbEnd);
  console.log('Fix 3 applied: local normalizeComparableText/tokenize/calculateTextSimilarity removed.');
}

// ─── Fix 4: Add EvolveResult interface + rewrite evolve() ────────────────────
const evolveSignatureOld = '\r\nexport async function evolve(population: WebPageGenotype[], generations = 3): Promise<WebPageGenotype[]> {';
const evolveEnd = '\r\ntype AssemblySourceContext =';

const evStart = src.indexOf(evolveSignatureOld);
const evEnd = src.indexOf(evolveEnd, evStart);

if (evStart === -1) {
  console.log('Fix 4: evolve() old signature not found — already rewritten.');
} else if (evEnd === -1) {
  console.error('Fix 4 FAILED: could not locate AssemblySourceContext after evolve().');
  process.exit(1);
} else {
  // Replacement block. Template literals in the generated TypeScript source
  // are encoded as escaped backticks to avoid breaking this script's own syntax.
  const BT = '`';
  const newEvolveBlock =
    '\r\nexport interface EvolveResult {\r\n'
  + '  population: WebPageGenotype[];\r\n'
  + '  completedGenerations: number;\r\n'
  + '  bestRedundancyPenalty: number;\r\n'
  + '}\r\n'
  + '\r\n'
  + 'export async function evolve(population: WebPageGenotype[], generations = 3): Promise<EvolveResult> {\r\n'
  + '  let currentPopulation = selectDistinctPopulationPages(population, CONSOLIDATED_SOURCE_POOL_SIZE);\r\n'
  + '  const targetPopulationSize = currentPopulation.length;\r\n'
  + '\r\n'
  + '  if (targetPopulationSize <= 2) {\r\n'
  + '    return { population: currentPopulation, completedGenerations: 0, bestRedundancyPenalty: 0 };\r\n'
  + '  }\r\n'
  + '\r\n'
  + '  for (let generation = 0; generation < generations; generation += 1) {\r\n'
  + '    // SE-3 fix: pass all other pages as optimalSet so the gamma redundancy\r\n'
  + '    // penalty is genuinely computed rather than always being zero.\r\n'
  + '    currentPopulation.forEach((page, _, arr) => {\r\n'
  + '      page.fitness = calculateFitness(page, arr.filter(p => p !== page), EVOLUTION_WEIGHTS);\r\n'
  + '    });\r\n'
  + '\r\n'
  + '    currentPopulation.sort((left, right) => right.fitness - left.fitness);\r\n'
  + '    const survivors = currentPopulation.slice(0, Math.max(2, Math.ceil(targetPopulationSize / 2)));\r\n'
  + '\r\n'
  + '    const nextPopulation = survivors.map((page) => ({ ...page }));\r\n'
  + '    let offspringIndex = 0;\r\n'
  + '\r\n'
  + '    while (nextPopulation.length < targetPopulationSize && survivors.length > 0) {\r\n'
  + '      const parentA = survivors[offspringIndex % survivors.length];\r\n'
  + '      const parentB = survivors[(offspringIndex + generation + 1) % survivors.length] || parentA;\r\n'
  + '      const mergedDefinitions = getRenderableDefinitions([\r\n'
  + '        ...(parentA.definitions || []).slice(0, 4),\r\n'
  + '        ...(parentB.definitions || []).slice(0, 4),\r\n'
  + '      ], 8);\r\n'
  + '      const mergedSubTopics = getRenderableSubTopics([\r\n'
  + '        ...(parentA.subTopics || []).slice(0, 4),\r\n'
  + '        ...(parentB.subTopics || []).slice(0, 4),\r\n'
  + '      ]).slice(0, 8);\r\n'
  + `      const hybridContent = dedupeSentences(${BT}\${parentA.content} \${parentB.content}${BT}, 8).join(' ')\r\n`
  + `        || ${BT}\${parentA.content.substring(0, 500)} \${parentB.content.substring(0, 500)}${BT}.trim();\r\n`
  + '\r\n'
  + '      nextPopulation.push({\r\n'
  + `        id: ${BT}offspring-\${generation}-\${offspringIndex}${BT},\r\n`
  + "        url: 'hybrid-source',\r\n"
  + `        title: ${BT}Synthesized: \${parentA.title} & \${parentB.title}${BT},\r\n`
  + '        content: hybridContent,\r\n'
  + '        definitions: mergedDefinitions,\r\n'
  + '        subTopics: mergedSubTopics,\r\n'
  + '        informativeScore: (parentA.informativeScore + parentB.informativeScore) / 2,\r\n'
  + '        authorityScore: (parentA.authorityScore + parentB.authorityScore) / 2,\r\n'
  + '        fitness: 0,\r\n'
  + '      });\r\n'
  + '\r\n'
  + '      offspringIndex += 1;\r\n'
  + '    }\r\n'
  + '\r\n'
  + '    currentPopulation = nextPopulation.slice(0, targetPopulationSize);\r\n'
  + '  }\r\n'
  + '\r\n'
  + '  // Final ranking pass — again use real optimalSet so the top-ranked page\r\n'
  + '  // receives an accurate fitness score before assembly source selection.\r\n'
  + '  currentPopulation.forEach((page, _, arr) => {\r\n'
  + '    page.fitness = calculateFitness(page, arr.filter(p => p !== page), EVOLUTION_WEIGHTS);\r\n'
  + '  });\r\n'
  + '  currentPopulation.sort((left, right) => right.fitness - left.fitness);\r\n'
  + '\r\n'
  + '  // SE-2 fix: compute the redundancy penalty for the top-ranked page so the\r\n'
  + '  // UI\'s gamma R(w,S) term reflects a real measured value.\r\n'
  + '  let bestRedundancyPenalty = 0;\r\n'
  + '  const bestPage = currentPopulation[0];\r\n'
  + '  if (bestPage && currentPopulation.length > 1) {\r\n'
  + '    const otherTerms = new Set(\r\n'
  + '      currentPopulation.slice(1)\r\n'
  + "        .flatMap(p => (p.definitions || []).map(d => (d.term || '').toLowerCase()))\r\n"
  + '    );\r\n'
  + "    const pageTerms = (bestPage.definitions || []).map(d => (d.term || '').toLowerCase());\r\n"
  + '    const overlap = pageTerms.filter(t => t && otherTerms.has(t)).length;\r\n'
  + '    bestRedundancyPenalty = overlap / Math.max(pageTerms.length, 1);\r\n'
  + '  }\r\n'
  + '\r\n'
  + '  return { population: currentPopulation, completedGenerations: generations, bestRedundancyPenalty };\r\n'
  + '}';

  src = src.slice(0, evStart) + newEvolveBlock + src.slice(evEnd);
  console.log('Fix 4 applied: EvolveResult interface added, evolve() rewritten with real optimalSet and redundancy reporting.');
}

writeFileSync(filePath, src, 'utf8');
console.log(`\nDone. File size: ${originalLength} → ${src.length} bytes.`);
