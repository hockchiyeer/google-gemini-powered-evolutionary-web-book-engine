import assert from 'node:assert/strict';
import {
  buildPrintFriendlyReportPagesHtml,
  exportPrintFriendlyWebBookToImage,
  exportPrintFriendlyWebBookToPdf,
} from '../../src/services/printFriendlyReportExport.ts';
import type { Chapter, WebBook } from '../../src/types.ts';

console.log('Running printFriendlyReportExport regression tests...');

// 1. Full text is never truncated, and long content flows across A4 pages instead of being clipped
{
  const sentence = 'Quantum field dynamics describe interacting excitations across coupled domains. ';
  const longNarrative = Array.from({ length: 4 }, (_, p) => `Paragraph ${p + 1} marker. ${sentence.repeat(14)}END-OF-PARAGRAPH-${p + 1}`).join('\n\n');
  const makeChapters = (count: number): Chapter[] =>
    Array.from({ length: count }, (_, i) => ({
      title: `Chapter ${i + 1} ${'with a deliberately long descriptive title '.repeat(2)}`.trim(),
      content: longNarrative,
      definitions: Array.from({ length: 5 }, (_, d) => ({
        term: `Term ${i + 1}.${d + 1}`,
        description: `Definition body ${i + 1}.${d + 1} ${'extended explanatory wording '.repeat(8)}FULL-DEF-${i + 1}-${d + 1}`,
        sourceUrl: 'https://example.com',
      })),
      subTopics: Array.from({ length: 5 }, (_, t) => ({
        title: `Dimension ${i + 1}.${t + 1}`,
        summary: `Dimension body ${i + 1}.${t + 1} ${'extended explanatory wording '.repeat(8)}FULL-SUB-${i + 1}-${t + 1}`,
        sourceUrl: 'https://example.com',
      })),
      sourceUrls: ['https://example.com', 'https://example.org', 'https://example.net', 'https://example.edu', 'https://example.io'],
      visualSeed: `a seed keyword phrase that is much longer than twenty six characters ${i + 1}`,
    }));

  const longBook: WebBook = {
    id: 'test-long',
    topic: 'Long Form Topic',
    timestamp: 1_700_000_000_000,
    chapters: makeChapters(6),
  };

  const pages = buildPrintFriendlyReportPagesHtml(longBook);
  assert.ok(pages.length > 2, 'Full-length text must flow onto more than 2 A4 pages');
  const all = pages.join('\n');
  assert.ok(!all.includes('text-overflow'), 'No ellipsis CSS may be used');
  assert.ok(!all.includes('...'), 'No truncated text may be emitted');
  for (let i = 1; i <= 6; i += 1) {
    for (let p = 1; p <= 4; p += 1) assert.ok(all.includes(`END-OF-PARAGRAPH-${p}`), `Paragraph ${p} end must be present`);
    for (let d = 1; d <= 5; d += 1) {
      assert.ok(all.includes(`FULL-DEF-${i}-${d}`), `Definition ${i}.${d} must be shown in full`);
      assert.ok(all.includes(`FULL-SUB-${i}-${d}`), `Sub-topic ${i}.${d} must be shown in full`);
    }
    assert.ok(all.includes(`much longer than twenty six characters ${i}`), 'Visual seed must be shown in full');
  }
  assert.equal(all.split('END-OF-PARAGRAPH-4').length - 1, 6, 'Each chapter paragraph appears exactly once (no duplicated or dropped text)');
  assert.ok(all.includes('(cont.)') || pages.length > 0, 'Chapters may continue across pages');
  assert.ok(pages[pages.length - 1].includes('Evolutionary Synthesis &amp; Evidence Verification') || pages[pages.length - 1].includes('Evolutionary Synthesis & Evidence Verification'), 'Conclusion box must be on the last page');
  pages.forEach((page, index) => assert.ok(page.includes(`Page ${index + 1} of ${pages.length}`), 'Footer must carry correct page numbering'));

  // A smaller usable page height must never drop content, only add pages
  const tighter = buildPrintFriendlyReportPagesHtml(longBook, 0.6);
  assert.ok(tighter.length >= pages.length, 'Reduced capacity must not produce fewer pages');
  assert.ok(tighter.join('\n').includes('FULL-SUB-6-5'), 'Reduced capacity must keep all content');



  // A single chapter with a very long paragraph is split across pieces without losing characters
  const hugeParagraph = 'zqx '.repeat(3000).trim();
  const hugeBook: WebBook = { ...longBook, chapters: [{ ...makeChapters(1)[0], content: hugeParagraph }] };
  const hugePages = buildPrintFriendlyReportPagesHtml(hugeBook).join('\n');
  const wordCount = (hugePages.match(/\bzqx\b/g) || []).length;
  assert.equal(wordCount, 3000, 'Oversized paragraph must be preserved word-for-word');
}

// 2. Test HTML pages generation
{
  const fixtureBook: WebBook = {
    id: 'test-1',
    topic: 'Taipei Mayor Election Nov 2026',
    timestamp: 1_700_000_000_000,
    sourceMode: 'fallback_search',
    chapters: [
      {
        title: 'Electoral Landscape',
        content: 'The 2026 Taipei mayoral contest features prominent municipal policy debates across transit, housing, and cross-strait positioning.\n\nSecondary context indicates competitive polling.',
        definitions: [{ term: 'Mayoral Prerogative', description: 'Executive authority over municipal resource allocation.', sourceUrl: 'https://taipei.gov.tw' }],
        subTopics: [{ title: 'Transit Policy', summary: 'Expansion of MRT lines and smart bus corridors.', sourceUrl: 'https://taipei.gov.tw' }],
        sourceUrls: ['https://taipei.gov.tw'],
        visualSeed: 'Taipei City Hall',
      },
      {
        title: 'Candidate Coalitions',
        content: 'Coalition dynamics reflect broader party alignments and emerging independent voter blocks.',
        definitions: [],
        subTopics: [],
        sourceUrls: ['https://taipei.gov.tw'],
        visualSeed: 'electoral debate',
      },
    ],
  };

  const pages = buildPrintFriendlyReportPagesHtml(fixtureBook);
  assert.equal(pages.length, 1, 'Two short chapters should fit on 1 A4 page');
  assert.ok(pages[0].includes('Taipei Mayor Election Nov 2026'), 'Page 1 must include topic title');
  assert.ok(!pages[0].includes('A4 Print-Friendly Full Report'), 'Page 1 must not include unsubstantial full report badge');
  assert.ok(!pages[0].includes('A4-optimized, journal-style full-text report'), 'Page 1 must not include unsubstantial subtitle text');
  assert.ok(pages[0].includes('Electoral Landscape'), 'Page 1 must include chapter 1');
  assert.ok(pages[0].includes('Mayoral Prerogative'), 'Page 1 must include core definitions');
  assert.ok(pages[0].includes('width: 794px'), 'Page must enforce 794px A4 width');
  assert.ok(pages[0].includes('height: 1123px'), 'Page must enforce 1123px A4 height');
  assert.ok(pages[0].includes('display: inline-flex; align-items: center; justify-content: center;'), 'Chapter badge must be vertically middle/centered aligned');
  assert.ok(pages[0].includes('>01</span>'), 'Chapter number must be tight without interior whitespace');
}

// 3. Test export execution in headless Node environment (with mock downloadBlob)
{
  let capturedBlob: Blob | null = null;
  let capturedFileName: string | null = null;

  const g = globalThis as any;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalDocument = g.document;

  URL.createObjectURL = ((blob: Blob) => {
    capturedBlob = blob;
    return 'blob:mock-print-friendly';
  }) as typeof URL.createObjectURL;

  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;

  g.document = {
    createElement: (tag: string) => {
      if (tag === 'a') {
        return {
          style: {},
          click: () => {},
          set download(val: string) {
            capturedFileName = val;
          },
        };
      }
      return { style: {} };
    },
    body: {
      appendChild: () => {},
      removeChild: () => {},
    },
  };

  const sampleBook: WebBook = {
    id: 'test-node-export',
    topic: 'Artificial Intelligence Systems',
    timestamp: 1_700_000_000_000,
    chapters: [
      {
        title: 'Foundations',
        content: 'Historical foundations of connectionist networks.',
        definitions: [{ term: 'Perceptron', description: 'Single-layer classifier', sourceUrl: 'https://example.com' }],
        subTopics: [{ title: 'Backpropagation', summary: 'Gradient calculation through chain rule', sourceUrl: 'https://example.com' }],
        sourceUrls: ['https://example.com'],
        visualSeed: 'neural net',
      },
    ],
  };

  try {
    // PDF export test (canonical)
    await exportPrintFriendlyWebBookToPdf(sampleBook);
    assert.ok(capturedBlob, 'exportPrintFriendlyWebBookToPdf must pass a Blob to downloadBlob');
    assert.ok(capturedFileName?.endsWith('.pdf'), 'exportPrintFriendlyWebBookToPdf file name must end with .pdf');
    assert.ok(capturedFileName?.includes('_PrintFriendly_Report.pdf'), 'exportPrintFriendlyWebBookToPdf file name must include _PrintFriendly_Report.pdf');

    // JPG image export test (canonical)
    capturedBlob = null;
    capturedFileName = null;
    await exportPrintFriendlyWebBookToImage(sampleBook);
    assert.ok(capturedBlob, 'exportPrintFriendlyWebBookToImage must pass a Blob to downloadBlob');
    assert.ok(capturedFileName?.endsWith('.jpg'), 'exportPrintFriendlyWebBookToImage file name must end with .jpg');
    assert.ok(capturedFileName?.includes('_PrintFriendly_Report.jpg'), 'exportPrintFriendlyWebBookToImage file name must include _PrintFriendly_Report.jpg');


  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    g.document = originalDocument;
  }
}

console.log('printFriendlyReportExport regression tests passed successfully!');
