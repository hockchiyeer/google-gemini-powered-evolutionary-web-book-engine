import type { Chapter, Definition, SubTopic, WebBook } from '../types';
import { getChapterSourceLinks, sanitizeWebBookForPresentation } from '../utils/webBookRender';
import { downloadBlob, getExportFileName } from './exportDocument';
import { getWebBookDocumentTitle } from './documentTitle';

function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getExecutiveOverview(webBook: WebBook): string {
  if (webBook.generationNote) {
    return webBook.generationNote;
  }
  return `Comprehensive evolutionary synthesis covering foundations, core mechanisms, and future horizons for "${webBook.topic}".`;
}

// ---------------------------------------------------------------------------
// A4 page geometry & Reader-mode typography (modelled on Edge / LinkedIn reader view)
// ---------------------------------------------------------------------------
// Design:
//   * Generous 15px text with 1.63 line-height, left-aligned for high readability
//   * Plain, accessible system sans-serif stack across all languages
//   * Clean headings, definition lists for core concepts, and source links
//   * Protected headings (never orphaned alone at the bottom of a page)
//   * 3x render scale (~288 DPI) for crisp text in both PDF & JPG exports

const PAGE_WIDTH_PX = 794;
const PAGE_HEIGHT_PX = 1123;
const PAGE_PADDING_X_PX = 44;
const PAGE_PADDING_Y_PX = 36;
const PAGE_BODY_WIDTH_PX = PAGE_WIDTH_PX - PAGE_PADDING_X_PX * 2;
const CARD_INNER_WIDTH_PX = PAGE_BODY_WIDTH_PX;
const DETAIL_COLUMN_WIDTH_PX = Math.floor((CARD_INNER_WIDTH_PX - 12) / 2);
const FOOTER_RESERVE_PX = 32;
const CARD_GAP_PX = 8;
const SEED_BADGE_MAX_WIDTH_PX = Math.floor(CARD_INNER_WIDTH_PX * 0.4);
const MAX_ITEMS_PER_DETAIL_BLOCK = 4;
const LATIN_CHAR_EM = 0.54;

const BODY_FONT_PX = 15;
const BODY_LINE_PX = 24.5;
const BODY_PARAGRAPH_GAP_PX = 10;
const DETAIL_FONT_PX = 12.5;
const DETAIL_LINE_PX = 17;
const MAX_PARAGRAPH_CHARS = 2400;
const MAX_CAPACITY_SCALE = 1.8;
const MIN_CAPACITY_SCALE = 0.5;
const CAPACITY_SEARCH_STEPS = 7;
const MAX_COMPOSITE_CANVAS_PIXELS = 24_000_000;
const MAX_COMPOSITE_CANVAS_SIDE_PX = 32_000;
const IMAGE_RENDER_SCALE = 3;
const JPEG_QUALITY = 0.95;

const READER_FONT_STACK = [
  "'Segoe UI'",
  '-apple-system',
  'BlinkMacSystemFont',
  'Roboto',
  "'Helvetica Neue'",
  'Arial',
  "'Noto Sans'",
  'system-ui',
  'sans-serif',
].join(', ');

const CONCLUSION_TITLE = 'Evolutionary Synthesis & Evidence Verification';
const CONCLUSION_TEXT =
  'This full-text report was produced using multi-generational genetic algorithms that evaluate informative novelty while pruning repetitive search fragments. All references have been normalized and validated against primary source hostnames.';

const WIDE_CHAR = /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

interface ReportBlock {
  html: string;
  height: number;
}

interface ChapterFragment {
  chapterIndex: number;
  chapter: Chapter;
  isContinuation: boolean;
  blocks: ReportBlock[];
}

interface ReportPageLayout {
  fragments: ChapterFragment[];
  includeConclusion: boolean;
}

function estimateLines(text: string, fontPx: number, widthPx: number): number {
  let lines = 0;
  for (const segment of text.split('\n')) {
    let textWidth = 0;
    for (const character of segment) {
      textWidth += WIDE_CHAR.test(character) ? fontPx : fontPx * LATIN_CHAR_EM;
    }
    lines += Math.max(1, Math.ceil((textWidth * 1.04) / widthPx));
  }
  return lines;
}

function splitLongParagraph(paragraph: string): string[] {
  const pieces: string[] = [];
  let rest = paragraph;
  while (rest.length > MAX_PARAGRAPH_CHARS) {
    const head = rest.slice(0, MAX_PARAGRAPH_CHARS);
    const sentenceEnd = Math.max(
      head.lastIndexOf('. '),
      head.lastIndexOf('! '),
      head.lastIndexOf('? '),
      head.lastIndexOf('。'),
      head.lastIndexOf('！'),
      head.lastIndexOf('？'),
      head.lastIndexOf('\n')
    );
    const lastSpace = head.lastIndexOf(' ');
    const cut =
      sentenceEnd > MAX_PARAGRAPH_CHARS * 0.5
        ? sentenceEnd + 1
        : lastSpace > MAX_PARAGRAPH_CHARS * 0.5
          ? lastSpace
          : MAX_PARAGRAPH_CHARS;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

function splitIntoParagraphs(content: string): string[] {
  return (content || '')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .flatMap(splitLongParagraph);
}

interface DetailItem {
  label: string;
  text: string;
}

function estimateDetailColumnHeight(items: DetailItem[], emptyText: string | null): number {
  if (items.length === 0) {
    return emptyText === null ? 0 : 26 + estimateLines(emptyText, DETAIL_FONT_PX, DETAIL_COLUMN_WIDTH_PX) * DETAIL_LINE_PX;
  }
  const itemsHeight = items.reduce(
    (sum, item) => sum + estimateLines(`${item.label}: ${item.text}`, DETAIL_FONT_PX, DETAIL_COLUMN_WIDTH_PX) * DETAIL_LINE_PX + 4,
    0
  );
  return 26 + itemsHeight;
}

function renderDetailColumn(heading: string, items: DetailItem[], emptyText: string | null): string {
  if (items.length === 0 && emptyText === null) {
    return '<div></div>';
  }
  const body =
    items.length === 0
      ? `<div style="font-family: ${READER_FONT_STACK}; font-size: ${DETAIL_FONT_PX}px; color: #777; font-style: italic;">${escapeHtml(emptyText ?? '')}</div>`
      : items
          .map(
            (item) =>
              `<div style="font-family: ${READER_FONT_STACK}; font-size: ${DETAIL_FONT_PX}px; line-height: ${DETAIL_LINE_PX}px; color: #222; margin-bottom: 4px; word-break: break-word;">
          <strong style="color: #111;">${escapeHtml(item.label)}:</strong> ${escapeHtml(item.text)}
        </div>`
          )
          .join('');
  return `<div style="background: #fafaf9; border-left: 3px solid #141414; padding: 6px 10px; border-radius: 0 2px 2px 0;">
          <div style="font-family: ${READER_FONT_STACK}; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #555; margin-bottom: 4px;">
            ${escapeHtml(heading)}
          </div>
          ${body}
        </div>`;
}

function buildDetailBlocks(chapter: Chapter): ReportBlock[] {
  const concepts: DetailItem[] = (chapter.definitions || []).map((d: Definition) => ({ label: d.term, text: d.description }));
  const dimensions: DetailItem[] = (chapter.subTopics || []).map((s: SubTopic) => ({ label: s.title, text: s.summary }));
  const chunkCount = Math.max(1, Math.ceil(Math.max(concepts.length, dimensions.length) / MAX_ITEMS_PER_DETAIL_BLOCK));

  return Array.from({ length: chunkCount }, (_, chunkIndex) => {
    const from = chunkIndex * MAX_ITEMS_PER_DETAIL_BLOCK;
    const to = from + MAX_ITEMS_PER_DETAIL_BLOCK;
    const conceptChunk = concepts.slice(from, to);
    const dimensionChunk = dimensions.slice(from, to);
    const conceptEmpty = chunkIndex === 0 ? 'Domain terminology integrated in narrative' : null;
    const dimensionEmpty = chunkIndex === 0 ? 'Synthesized across primary narrative' : null;

    return {
      html: `
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 6px;">
        ${renderDetailColumn('Core Concepts', conceptChunk, conceptEmpty)}
        ${renderDetailColumn('Key Dimensions', dimensionChunk, dimensionEmpty)}
      </div>`,
      height:
        Math.max(
          estimateDetailColumnHeight(conceptChunk, conceptEmpty),
          estimateDetailColumnHeight(dimensionChunk, dimensionEmpty)
        ) + 6,
    };
  });
}

function buildSourcesBlock(chapter: Chapter): ReportBlock | null {
  const links = getChapterSourceLinks(chapter);
  if (links.length === 0) return null;

  const labels = links.map((link) => link.hostname || link.title);
  const badges = labels
    .map(
      (label) =>
        `<span style="display: inline-flex; align-items: center; background: #f0f0ee; border: 1px solid rgba(20,20,20,0.12); border-radius: 2px; padding: 2px 6px; line-height: 1.25; font-family: ${READER_FONT_STACK}; font-size: 10.5px; color: #333; margin-right: 5px; margin-bottom: 3px; word-break: break-all; box-sizing: border-box;">
          ${escapeHtml(label)}
        </span>`
    )
    .join('');
  const rowWidth = 60 + labels.reduce((sum, label) => sum + label.length * 6.2 + 18, 0);
  const rows = Math.max(1, Math.ceil((rowWidth * 1.05) / CARD_INNER_WIDTH_PX));

  return {
    html: `
    <div style="display: flex; align-items: center; flex-wrap: wrap; margin-top: 6px; padding-top: 6px; border-top: 1px dashed rgba(20,20,20,0.12);">
      <span style="font-family: ${READER_FONT_STACK}; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #555; margin-right: 6px;">
        Sources:
      </span>
      ${badges}
    </div>
  `,
    height: 12 + rows * 20,
  };
}

function getChapterBlocks(chapter: Chapter): ReportBlock[] {
  const narrativeBlocks = splitIntoParagraphs(chapter.content).map((paragraph) => ({
    html: `<div style="font-family: ${READER_FONT_STACK}; font-size: ${BODY_FONT_PX}px; line-height: ${BODY_LINE_PX}px; color: #1f1f1f; margin-bottom: ${BODY_PARAGRAPH_GAP_PX}px; text-align: left; white-space: pre-line; word-break: break-word; overflow-wrap: anywhere;">${escapeHtml(paragraph)}</div>`,
    height: estimateLines(paragraph, BODY_FONT_PX, CARD_INNER_WIDTH_PX) * BODY_LINE_PX + BODY_PARAGRAPH_GAP_PX,
  }));
  const sourcesBlock = buildSourcesBlock(chapter);
  return [...narrativeBlocks, ...buildDetailBlocks(chapter), ...(sourcesBlock ? [sourcesBlock] : [])];
}

function getCardTitle(chapter: Chapter, isContinuation: boolean): string {
  return isContinuation ? `${chapter.title} (cont.)` : chapter.title;
}

function estimateCardChromeHeight(chapter: Chapter, isContinuation: boolean): number {
  const showSeed = !isContinuation && Boolean(chapter.visualSeed);
  const titleWidth = CARD_INNER_WIDTH_PX - 45 - (showSeed ? SEED_BADGE_MAX_WIDTH_PX : 0);
  const titleHeight = estimateLines(getCardTitle(chapter, isContinuation), 16, titleWidth) * 21;
  const seedHeight = showSeed ? estimateLines(`Seed: ${chapter.visualSeed}`, 10, SEED_BADGE_MAX_WIDTH_PX - 12) * 13 + 4 : 0;
  return 18 + 6 + Math.max(titleHeight, seedHeight);
}

function renderChapterCard(fragment: ChapterFragment): string {
  const { chapter, chapterIndex, isContinuation } = fragment;
  const badgeNum = String(chapterIndex + 1).padStart(2, '0');
  const titleText = getCardTitle(chapter, isContinuation);
  return `
    <div style="margin-bottom: 4px;">
      <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 6px; border-bottom: 1.5px solid rgba(20,20,20,0.12); padding-bottom: 4px;">
        <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
          <span style="display: inline-flex; align-items: center; justify-content: center; min-width: 24px; height: 20px; line-height: 1; text-align: center; padding: 0 4px; box-sizing: border-box; background: #141414; color: #ffffff; font-family: ${READER_FONT_STACK}; font-size: 10px; font-weight: 700; border-radius: 2px; letter-spacing: 0.02em;">${badgeNum}</span>
          <h2 style="font-family: ${READER_FONT_STACK}; font-weight: 700; font-size: 16px; line-height: 1.3; color: #111111; margin: 0; word-break: break-word;">
            ${escapeHtml(titleText)}
          </h2>
        </div>
        ${
          !isContinuation && chapter.visualSeed
            ? `<span style="display: inline-flex; align-items: center; max-width: ${SEED_BADGE_MAX_WIDTH_PX}px; font-family: ${READER_FONT_STACK}; font-size: 10px; line-height: 1.25; color: #666; background: #f0f0ee; padding: 2px 6px; border-radius: 2px; text-align: right; word-break: break-word; box-sizing: border-box;">
                Seed: ${escapeHtml(chapter.visualSeed)}
              </span>`
            : ''
        }
      </div>

      ${fragment.blocks.map((block) => block.html).join('')}
    </div>
  `;
}

function renderConclusionBox(): string {
  return `
    <div style="border-top: 2px solid #141414; background: #fafaf9; padding: 8px 12px; border-radius: 0 0 2px 2px; margin-top: 6px;">
      <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(20,20,20,0.12); padding-bottom: 3px; margin-bottom: 4px;">
        <div style="font-family: ${READER_FONT_STACK}; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #141414;">
          ${escapeHtml(CONCLUSION_TITLE)}
        </div>
        <div style="font-family: ${READER_FONT_STACK}; font-size: 9.5px; color: #666;">
          Redundancy Mitigation Algorithm
        </div>
      </div>
      <div style="font-family: ${READER_FONT_STACK}; font-size: 11.5px; line-height: 1.45; color: #333;">
        ${escapeHtml(CONCLUSION_TEXT)}
      </div>
    </div>
  `;
}

function estimateConclusionHeight(): number {
  return 12 + 24 + estimateLines(CONCLUSION_TEXT, 11.5, CARD_INNER_WIDTH_PX) * 16.5;
}

function renderFooter(pageNum: number, totalPages: number): string {
  return `
    <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid rgba(20,20,20,0.15); padding-top: 6px; font-family: ${READER_FONT_STACK}; font-size: 10px; color: #666;">
      <div>Evolutionary Web-Book Engine • Mitigating Search Redundancy</div>
      <div style="font-weight: 700; color: #141414;">Page ${pageNum} of ${totalPages}</div>
    </div>
  `;
}

function estimateFirstPageHeaderHeight(webBook: WebBook): number {
  const titleLines = estimateLines(webBook.topic, 24, PAGE_BODY_WIDTH_PX);
  const overviewLines = estimateLines(getExecutiveOverview(webBook), 12, PAGE_BODY_WIDTH_PX - 20);
  return 24 + titleLines * 30 + 8 + 24 + (20 + overviewLines * 17.5 + 10);
}

function estimateContinuationHeaderHeight(webBook: WebBook): number {
  return 16 + estimateLines(webBook.topic, 12, 500) * 16 + 8;
}

/**
 * Packs the full, untruncated chapter content onto A4 pages. A chapter that does not fit in the space left on
 * a page continues on the next page in a "(cont.)" card, so no text is ever clipped or shortened.
 * Heading orphan protection ensures a chapter title is never stranded at the bottom of a page alone.
 */
function paginatePrintFriendlyReport(webBook: WebBook, capacityScale = 1): ReportPageLayout[] {
  const chapters = webBook.chapters || [];
  const firstPageHeader = estimateFirstPageHeaderHeight(webBook);
  const continuationHeader = estimateContinuationHeaderHeight(webBook);
  const capacityOf = (pageIndex: number) =>
    Math.floor(
      (PAGE_HEIGHT_PX -
        PAGE_PADDING_Y_PX * 2 -
        FOOTER_RESERVE_PX -
        (pageIndex === 0 ? firstPageHeader : continuationHeader)) *
        capacityScale
    );

  const pages: ReportPageLayout[] = [{ fragments: [], includeConclusion: false }];
  let used = 0;
  const startNewPage = () => {
    pages.push({ fragments: [], includeConclusion: false });
    used = 0;
  };

  chapters.forEach((chapter, chapterIndex) => {
    let hasPlacedBlock = false;
    const blocks = getChapterBlocks(chapter);

    blocks.forEach((block) => {
      let page = pages[pages.length - 1];
      const isFirstBlockOfChapter = !hasPlacedBlock;
      const chromeHeight = estimateCardChromeHeight(chapter, hasPlacedBlock);
      const gap = page.fragments.length > 0 ? CARD_GAP_PX : 0;

      const costIn = (pageLayout: ReportPageLayout) => {
        const lastFragment = pageLayout.fragments[pageLayout.fragments.length - 1];
        if (lastFragment?.chapterIndex === chapterIndex) return block.height;
        return block.height + chromeHeight + gap;
      };

      // Heading orphan protection: keep heading together with initial content
      const orphanReserve = isFirstBlockOfChapter && blocks.length > 1 ? Math.min(blocks[1].height, 80) : 0;

      if (page.fragments.length > 0 && used + costIn(page) + orphanReserve > capacityOf(pages.length - 1)) {
        startNewPage();
        page = pages[pages.length - 1];
      }

      let fragment = page.fragments[page.fragments.length - 1];
      used += costIn(page);
      if (fragment?.chapterIndex !== chapterIndex) {
        fragment = { chapterIndex, chapter, isContinuation: hasPlacedBlock, blocks: [] };
        page.fragments.push(fragment);
      }
      fragment.blocks.push(block);
      hasPlacedBlock = true;
    });
  });

  const lastPage = pages[pages.length - 1];
  if (lastPage.fragments.length > 0 && used + CARD_GAP_PX + estimateConclusionHeight() > capacityOf(pages.length - 1)) {
    startNewPage();
  }
  pages[pages.length - 1].includeConclusion = true;

  return pages;
}

export function buildPrintFriendlyReportPagesHtml(
  webBook: WebBook,
  capacityScaleOrHeights: number | number[] = 1
): string[] {
  const safeWebBook = sanitizeWebBookForPresentation(webBook);
  const chapters = safeWebBook.chapters || [];
  const capacityScale = typeof capacityScaleOrHeights === 'number' ? capacityScaleOrHeights : 1;
  const layouts = paginatePrintFriendlyReport(safeWebBook, capacityScale);
  const totalPages = layouts.length;

  const dateStr = new Date(safeWebBook.timestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const totalChapters = chapters.length;
  const totalConcepts = chapters.reduce(
    (acc, ch) => acc + (Array.isArray(ch.definitions) ? ch.definitions.length : 0),
    0
  );

  return layouts.map((layout, pageIndex) => {
    const pageNum = pageIndex + 1;
    const isFirstPage = pageIndex === 0;

    const cardsHtml = layout.fragments.map(renderChapterCard).join('');

    if (isFirstPage) {
      return `
        <div class="a4-report-page" style="width: ${PAGE_WIDTH_PX}px; height: ${PAGE_HEIGHT_PX}px; min-height: ${PAGE_HEIGHT_PX}px; max-height: ${PAGE_HEIGHT_PX}px; box-sizing: border-box; padding: ${PAGE_PADDING_Y_PX}px ${PAGE_PADDING_X_PX}px; background-color: #ffffff; color: #141414; display: flex; flex-direction: column; justify-content: space-between; overflow: hidden; position: relative;">
          <div>
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #141414; padding-bottom: 4px; margin-bottom: 8px;">
              <div style="font-family: ${READER_FONT_STACK}; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em; line-height: 1.3; color: #141414;">
                Evolutionary Web-Book Engine
              </div>
            </div>

            <h1 style="font-family: ${READER_FONT_STACK}; font-weight: 700; font-size: 24px; line-height: 1.25; margin: 0 0 8px 0; color: #111111; word-break: break-word;">
              ${escapeHtml(safeWebBook.topic)}
            </h1>

            <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; font-family: ${READER_FONT_STACK}; font-size: 12px; color: #555;">
              <span style="font-weight: 600; color: #111;">${totalChapters} ${totalChapters === 1 ? 'chapter' : 'chapters'}</span>
              <span>•</span>
              <span style="font-weight: 600; color: #111;">${totalConcepts} core concepts</span>
              <span>•</span>
              <span>${escapeHtml(dateStr)}</span>
              <span>•</span>
              <span style="background: #eef2f6; color: #1e3a5f; padding: 1px 6px; border-radius: 2px; font-weight: 600; font-size: 10.5px;">
                ${escapeHtml(safeWebBook.sourceMode === 'fallback_search' ? 'Fallback Search' : 'Grounded AI')}
              </span>
            </div>

            <div style="border-left: 3px solid #141414; background: #fafaf9; padding: 6px 10px; margin-bottom: 10px; border-radius: 0 2px 2px 0;">
              <div style="font-family: ${READER_FONT_STACK}; font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #141414; margin-bottom: 2px;">
                Abstract
              </div>
              <div style="font-family: ${READER_FONT_STACK}; font-size: 12px; line-height: 1.45; color: #2b2b2b; word-break: break-word;">
                ${escapeHtml(getExecutiveOverview(safeWebBook))}
              </div>
            </div>
          </div>

          <div style="display: flex; flex-direction: column; gap: ${CARD_GAP_PX}px; flex: 1; justify-content: flex-start;">
            ${cardsHtml}
            ${layout.includeConclusion ? renderConclusionBox() : ''}
          </div>

          ${renderFooter(pageNum, totalPages)}
        </div>
      `;
    }

    return `
      <div class="a4-report-page" style="width: ${PAGE_WIDTH_PX}px; height: ${PAGE_HEIGHT_PX}px; min-height: ${PAGE_HEIGHT_PX}px; max-height: ${PAGE_HEIGHT_PX}px; box-sizing: border-box; padding: ${PAGE_PADDING_Y_PX}px ${PAGE_PADDING_X_PX}px; background-color: #ffffff; color: #141414; display: flex; flex-direction: column; justify-content: space-between; overflow: hidden; position: relative;">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px; border-bottom: 1.5px solid #141414; padding-bottom: 4px; margin-bottom: 8px;">
          <div style="font-family: ${READER_FONT_STACK}; font-size: 12px; font-weight: 700; line-height: 1.3; color: #141414; max-width: 500px; min-width: 0; word-break: break-word;">
            ${escapeHtml(safeWebBook.topic)}
          </div>
          <div style="font-family: ${READER_FONT_STACK}; font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; line-height: 1.35; color: #666; white-space: nowrap;">
            A4 Full Report • Section ${pageNum}
          </div>
        </div>

        <div style="display: flex; flex-direction: column; gap: ${CARD_GAP_PX}px; flex: 1; justify-content: flex-start;">
          ${cardsHtml}
          ${layout.includeConclusion ? renderConclusionBox() : ''}
        </div>

        ${renderFooter(pageNum, totalPages)}
      </div>
    `;
  });
}

/** Standalone HTML document for the reader-mode report. */
export function buildPrintFriendlyReportHtml(webBook: WebBook): string {
  const safeWebBook = sanitizeWebBookForPresentation(webBook);
  const title = getWebBookDocumentTitle(safeWebBook.topic);
  const pagesHtml = buildPrintFriendlyReportPagesHtml(safeWebBook);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; padding: 20px; background: #f0f0f0; display: flex; flex-direction: column; align-items: center; gap: 20px; }
  .a4-report-page { background: #ffffff; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  @media print {
    body { margin: 0; padding: 0; background: none; }
    .a4-report-page { box-shadow: none; page-break-after: always; }
  }
</style>
</head>
<body>
${pagesHtml.join('\n')}
</body>
</html>`;
}

export async function renderPrintFriendlyReportCanvases(webBook: WebBook): Promise<HTMLCanvasElement[]> {
  const isBrowserDom =
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    typeof (window as unknown as { HTMLCanvasElement?: unknown }).HTMLCanvasElement !== 'undefined' &&
    typeof document.createElement === 'function';

  if (!isBrowserDom) {
    // Graceful fallback for non-browser/Node testing environments
    const mockCanvas = {
      width: PAGE_WIDTH_PX * IMAGE_RENDER_SCALE,
      height: PAGE_HEIGHT_PX * IMAGE_RENDER_SCALE,
      toDataURL: () => 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
      toBlob: (callback: (blob: Blob | null) => void) =>
        callback(new Blob(['mock-print-friendly-report'], { type: 'image/jpeg' })),
    } as unknown as HTMLCanvasElement;
    return [mockCanvas];
  }

  const html2canvasModule = await import('html2canvas');
  const html2canvas = (html2canvasModule.default || html2canvasModule) as unknown as (
    element: HTMLElement,
    options?: Record<string, unknown>
  ) => Promise<HTMLCanvasElement>;

  const container = document.createElement('div');
  container.id = 'a4-print-friendly-report-staging';
  container.style.position = 'fixed';
  container.style.top = '0';
  container.style.left = '0';
  container.style.width = `${PAGE_WIDTH_PX}px`;
  container.style.zIndex = '-99999';
  container.style.opacity = '0.01';
  container.style.pointerEvents = 'none';
  container.style.backgroundColor = '#ffffff';

  document.body.appendChild(container);

  const canvases: HTMLCanvasElement[] = [];

  try {
    container.innerHTML = buildPrintFriendlyReportPagesHtml(webBook)[0];
    if (document.fonts?.ready) {
      await document.fonts.ready;
    }
    const fitsA4 = (pages: string[]) =>
      pages.every((pageHtml) => {
        container.innerHTML = pageHtml;
        return (container.firstElementChild as HTMLElement).scrollHeight <= PAGE_HEIGHT_PX;
      });

    let pagesHtml = buildPrintFriendlyReportPagesHtml(webBook, MAX_CAPACITY_SCALE);
    if (!fitsA4(pagesHtml)) {
      let low = MIN_CAPACITY_SCALE;
      let high = MAX_CAPACITY_SCALE;
      pagesHtml = buildPrintFriendlyReportPagesHtml(webBook, low);
      for (let step = 0; step < CAPACITY_SEARCH_STEPS; step += 1) {
        const mid = (low + high) / 2;
        const candidate = buildPrintFriendlyReportPagesHtml(webBook, mid);
        if (fitsA4(candidate)) {
          pagesHtml = candidate;
          low = mid;
        } else {
          high = mid;
        }
      }
    }

    for (let index = 0; index < pagesHtml.length; index += 1) {
      container.innerHTML = pagesHtml[index];
      const pageEl = container.firstElementChild as HTMLElement;

      const canvas = await html2canvas(pageEl, {
        scale: IMAGE_RENDER_SCALE,
        useCORS: true,
        allowTaint: true,
        logging: false,
        backgroundColor: '#ffffff',
        windowWidth: PAGE_WIDTH_PX,
        windowHeight: PAGE_HEIGHT_PX,
      });

      canvases.push(canvas);
    }
  } finally {
    if (container.parentNode) {
      container.parentNode.removeChild(container);
    }
  }

  return canvases;
}

function canvasToJpgBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Failed to generate JPG blob'))),
      'image/jpeg',
      JPEG_QUALITY
    );
  });
}

export function compositeCanvasesToJpg(canvases: HTMLCanvasElement[]): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (canvases.length === 0) {
      reject(new Error('No canvases available to export.'));
      return;
    }

    if (canvases.length === 1) {
      canvasToJpgBlob(canvases[0]).then(resolve, reject);
      return;
    }

    const sourceWidth = canvases[0].width;
    const sourceHeight = canvases.reduce((sum, c) => sum + c.height, 0);
    const shrink = Math.min(
      1,
      Math.sqrt(MAX_COMPOSITE_CANVAS_PIXELS / (sourceWidth * sourceHeight)),
      MAX_COMPOSITE_CANVAS_SIDE_PX / sourceHeight
    );
    const width = Math.floor(sourceWidth * shrink);
    const totalHeight = Math.floor(sourceHeight * shrink);
    const compositeCanvas = document.createElement('canvas');
    compositeCanvas.width = width;
    compositeCanvas.height = totalHeight;
    const ctx = compositeCanvas.getContext('2d');
    if (!ctx) {
      reject(new Error('Failed to initialize composite 2D canvas context'));
      return;
    }

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, totalHeight);

    let currentY = 0;
    for (const c of canvases) {
      const drawHeight = c.height * shrink;
      ctx.drawImage(c, 0, currentY, width, drawHeight);
      currentY += drawHeight;
    }

    compositeCanvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Failed to generate composite JPG blob'))),
      'image/jpeg',
      JPEG_QUALITY
    );
  });
}

/**
 * JPG export: outputs crisp A4 images (~288 DPI). Single-page reports download as
 * `<topic>_PrintFriendly_Report.jpg`; multi-page reports download high-resolution individual page files.
 */
export async function exportPrintFriendlyWebBookToImage(webBook: WebBook): Promise<void> {
  const safeWebBook = sanitizeWebBookForPresentation(webBook);
  const canvases = await renderPrintFriendlyReportCanvases(safeWebBook);
  if (canvases.length === 0) {
    throw new Error('No canvases available to export.');
  }

  const baseName = `${safeWebBook.topic}_PrintFriendly_Report`;
  const pad = (n: number) => String(n).padStart(2, '0');

  if (canvases.length === 1) {
    const blob = await canvasToJpgBlob(canvases[0]);
    downloadBlob(blob, getExportFileName(baseName, 'jpg'));
    return;
  }

  for (let index = 0; index < canvases.length; index += 1) {
    const blob = await canvasToJpgBlob(canvases[index]);
    const name = getExportFileName(
      `${baseName}_page_${pad(index + 1)}_of_${pad(canvases.length)}`,
      'jpg'
    );
    downloadBlob(blob, name);
    if (index < canvases.length - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  }
}

/**
 * PDF export: writes crisp, high-resolution 3x canvases into a standard A4 PDF document
 * and downloads directly as `<topic>_PrintFriendly_Report.pdf`.
 */
export async function exportPrintFriendlyWebBookToPdf(webBook: WebBook): Promise<void> {
  const safeWebBook = sanitizeWebBookForPresentation(webBook);
  const canvases = await renderPrintFriendlyReportCanvases(safeWebBook);
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait' });
  const a4WidthPt = 595.28;
  const a4HeightPt = 841.89;

  for (let index = 0; index < canvases.length; index += 1) {
    if (index > 0) {
      doc.addPage('a4', 'portrait');
    }
    const imgData = canvases[index].toDataURL('image/jpeg', JPEG_QUALITY);
    doc.addImage(imgData, 'JPEG', 0, 0, a4WidthPt, a4HeightPt, undefined, 'FAST');
  }

  const pdfBlob = doc.output('blob');
  downloadBlob(pdfBlob, getExportFileName(`${safeWebBook.topic}_PrintFriendly_Report`, 'pdf'));
}
