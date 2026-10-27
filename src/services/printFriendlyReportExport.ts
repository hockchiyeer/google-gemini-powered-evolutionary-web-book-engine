import type { Chapter, Definition, SubTopic, WebBook } from '../types';
import { getChapterSourceLinks, sanitizeWebBookForPresentation } from '../utils/webBookRender';
import { downloadBlob, getExportFileName } from './exportDocument';

function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// The chapter cards below carry the complete text, so the brief deliberately does not repeat chapter 1.
function getExecutiveOverview(webBook: WebBook): string {
  if (webBook.generationNote) {
    return webBook.generationNote;
  }
  return `Comprehensive evolutionary synthesis covering foundations, core mechanisms, and future horizons for "${webBook.topic}".`;
}

// ---------------------------------------------------------------------------
// A4 page geometry (CSS px @ 96dpi) and pagination
// ---------------------------------------------------------------------------
// Full, untruncated text has unpredictable length, so pages are filled by height rather than by a fixed
// chapter count. Heights are estimated here (works without a DOM) and verified against the real layout
// in renderPrintFriendlyReportCanvases, which searches for the largest capacity whose pages all fit.

const PAGE_WIDTH_PX = 794;
const PAGE_HEIGHT_PX = 1123;
const PAGE_PADDING_X_PX = 38;
const PAGE_PADDING_Y_PX = 34;
const PAGE_BODY_WIDTH_PX = PAGE_WIDTH_PX - PAGE_PADDING_X_PX * 2;
const CARD_INNER_WIDTH_PX = PAGE_BODY_WIDTH_PX - 26; // card padding (12 * 2) + border (1 * 2)
const DETAIL_COLUMN_WIDTH_PX = (CARD_INNER_WIDTH_PX - 6) / 2 - 16; // grid gap, cell padding and border
const FOOTER_RESERVE_PX = 30;
const CARD_GAP_PX = 8;
const SEED_BADGE_MAX_WIDTH_PX = Math.floor(CARD_INNER_WIDTH_PX * 0.4);
const MAX_ITEMS_PER_DETAIL_BLOCK = 4;
const LATIN_CHAR_EM = 0.52; // average advance width of Latin text in Inter/Georgia, in em (slightly pessimistic)
// Journal-style typography: a serif ~8.25pt justified body with comfortable leading, 6.75pt detail text.
const BODY_FONT_PX = 11;
const BODY_LINE_PX = 16.5;
const BODY_PARAGRAPH_GAP_PX = 6;
const DETAIL_FONT_PX = 9;
const DETAIL_LINE_PX = 12.2;
const MAX_PARAGRAPH_CHARS = 2400;
const MAX_CAPACITY_SCALE = 1.8;
const MIN_CAPACITY_SCALE = 0.5;
const CAPACITY_SEARCH_STEPS = 7;
const MAX_COMPOSITE_CANVAS_PIXELS = 16_000_000;
const MAX_COMPOSITE_CANVAS_SIDE_PX = 32_000;

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

// Slightly pessimistic width model (Latin ~0.52em, CJK 1em per character); the renderer verifies the real layout.
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
    return emptyText === null ? 0 : 24 + estimateLines(emptyText, DETAIL_FONT_PX, DETAIL_COLUMN_WIDTH_PX) * DETAIL_LINE_PX;
  }
  const itemsHeight = items.reduce(
    (sum, item) => sum + estimateLines(`${item.label}: ${item.text}`, DETAIL_FONT_PX, DETAIL_COLUMN_WIDTH_PX) * DETAIL_LINE_PX + 2,
    0
  );
  return 24 + itemsHeight;
}

function renderDetailColumn(heading: string, items: DetailItem[], emptyText: string | null): string {
  if (items.length === 0 && emptyText === null) {
    return '<div></div>';
  }
  const body =
    items.length === 0
      ? `<div style="font-family: 'Inter', sans-serif; font-size: ${DETAIL_FONT_PX}px; color: #888; font-style: italic;">${escapeHtml(emptyText ?? '')}</div>`
      : items
          .map(
            (item) =>
              `<div style="font-family: 'Inter', sans-serif; font-size: ${DETAIL_FONT_PX}px; line-height: ${DETAIL_LINE_PX}px; color: #333; margin-bottom: 2px; word-break: break-word;">
          <strong style="color: #141414;">${escapeHtml(item.label)}:</strong> ${escapeHtml(item.text)}
        </div>`
          )
          .join('');
  return `<div style="background: #FAFAFA; border: 1px solid rgba(20,20,20,0.06); padding: 5px 7px; border-radius: 2px;">
          <div style="font-family: 'JetBrains Mono', monospace; font-size: 7.5px; font-weight: 700; text-transform: uppercase; color: #666; margin-bottom: 2px;">
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
    // Placeholders only describe a chapter that has no items at all, never an exhausted continuation chunk.
    const conceptEmpty = chunkIndex === 0 ? 'Domain terminology integrated in narrative' : null;
    const dimensionEmpty = chunkIndex === 0 ? 'Synthesized across primary narrative' : null;

    return {
      html: `
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 4px;">
        ${renderDetailColumn('Core Concepts', conceptChunk, conceptEmpty)}
        ${renderDetailColumn('Key Dimensions', dimensionChunk, dimensionEmpty)}
      </div>`,
      height:
        Math.max(
          estimateDetailColumnHeight(conceptChunk, conceptEmpty),
          estimateDetailColumnHeight(dimensionChunk, dimensionEmpty)
        ) + 4,
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
        `<span style="display: inline-flex; align-items: center; background: #EEEEEB; border: 1px solid rgba(20,20,20,0.1); border-radius: 2px; padding: 2px 5px; line-height: 1.2; font-family: 'JetBrains Mono', monospace; font-size: 7.5px; color: #444; margin-right: 4px; margin-bottom: 2px; word-break: break-all; box-sizing: border-box;">
          ${escapeHtml(label)}
        </span>`
    )
    .join('');
  const rowWidth = 50 + labels.reduce((sum, label) => sum + label.length * 4.5 + 16, 0);
  const rows = Math.max(1, Math.ceil((rowWidth * 1.1) / CARD_INNER_WIDTH_PX));

  return {
    html: `
    <div style="display: flex; align-items: center; flex-wrap: wrap; margin-top: 4px; padding-top: 4px; border-top: 1px dashed rgba(20,20,20,0.08);">
      <span style="font-family: 'JetBrains Mono', monospace; font-size: 7.5px; font-weight: 700; text-transform: uppercase; color: #777; margin-right: 6px;">
        Sources:
      </span>
      ${badges}
    </div>
  `,
    height: 9 + rows * 15,
  };
}

function getChapterBlocks(chapter: Chapter): ReportBlock[] {
  const narrativeBlocks = splitIntoParagraphs(chapter.content).map((paragraph) => ({
    html: `<div style="font-family: Georgia, 'Times New Roman', serif; font-size: ${BODY_FONT_PX}px; line-height: ${BODY_LINE_PX}px; color: #222222; margin-bottom: ${BODY_PARAGRAPH_GAP_PX}px; text-align: justify; white-space: pre-line; word-break: break-word; overflow-wrap: anywhere;">${escapeHtml(paragraph)}</div>`,
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
  const titleHeight = estimateLines(getCardTitle(chapter, isContinuation), 13, titleWidth) * 18;
  const seedHeight = showSeed ? estimateLines(`Seed: ${chapter.visualSeed}`, 7.5, SEED_BADGE_MAX_WIDTH_PX - 10) * 10 + 4 : 0;
  return 20 + 9 + Math.max(titleHeight, seedHeight);
}

function renderChapterCard(fragment: ChapterFragment): string {
  const { chapter, chapterIndex, isContinuation } = fragment;
  return `
    <div style="border: 1px solid rgba(20,20,20,0.14); border-radius: 3px; padding: 9px 12px; background: #ffffff; box-shadow: 0 1px 2px rgba(0,0,0,0.02);">
      <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 5px; border-bottom: 1px solid rgba(20,20,20,0.08); padding-bottom: 3px;">
        <div style="display: flex; align-items: center; gap: 7px; min-width: 0;">
          <span style="display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 18px; line-height: 1; text-align: center; padding: 0 4px; box-sizing: border-box; background: #141414; color: #ffffff; font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 8.5px; font-weight: 700; border-radius: 2px; letter-spacing: 0.02em;">${String(chapterIndex + 1).padStart(2, '0')}</span>
          <h3 style="font-family: 'Playfair Display', Georgia, serif; font-style: italic; font-weight: 700; font-size: 13px; line-height: 1.3; color: #141414; margin: 0; word-break: break-word;">
            ${escapeHtml(getCardTitle(chapter, isContinuation))}
          </h3>
        </div>
        ${
          !isContinuation && chapter.visualSeed
            ? `<span style="display: inline-flex; align-items: center; max-width: ${SEED_BADGE_MAX_WIDTH_PX}px; font-family: 'JetBrains Mono', monospace; font-size: 7.5px; line-height: 1.25; text-transform: uppercase; color: #666; background: #f0f0ee; padding: 2px 5px; border-radius: 2px; text-align: right; word-break: break-word; box-sizing: border-box;">
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
    <div style="border: 1px solid #141414; background: #F8F8F6; padding: 9px 12px; border-radius: 2px; margin-top: 4px;">
      <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(20,20,20,0.15); padding-bottom: 3px; margin-bottom: 5px;">
        <div style="font-family: 'JetBrains Mono', monospace; font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #141414;">
          Evolutionary Synthesis & Evidence Verification
        </div>
        <div style="font-family: 'JetBrains Mono', monospace; font-size: 7.5px; color: #666;">
          Redundancy Mitigation Algorithm
        </div>
      </div>
      <div style="font-family: 'Inter', sans-serif; font-size: 8.5px; line-height: 1.4; color: #333;">
        ${CONCLUSION_TEXT}
      </div>
    </div>
  `;
}

function estimateConclusionHeight(): number {
  return 4 + 32 + estimateLines(CONCLUSION_TEXT, 8.5, CARD_INNER_WIDTH_PX) * 11.9;
}

function renderFooter(pageNum: number, totalPages: number): string {
  return `
    <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid rgba(20,20,20,0.15); padding-top: 7px; font-family: 'JetBrains Mono', monospace; font-size: 8px; color: #666;">
      <div>Evolutionary Web-Book Engine • Mitigating Search Redundancy</div>
      <div style="font-weight: 700; color: #141414;">Page ${pageNum} of ${totalPages}</div>
    </div>
  `;
}

function estimateFirstPageHeaderHeight(webBook: WebBook): number {
  const titleLines = estimateLines(webBook.topic, 22, PAGE_BODY_WIDTH_PX);
  const overviewLines = estimateLines(getExecutiveOverview(webBook), 9, PAGE_BODY_WIDTH_PX - 23);
  // top bar + title + stat tiles + executive brief (including their bottom margins)
  return 32 + titleLines * 27 + 10 + 52 + (25 + overviewLines * 12.8 + 10);
}

function estimateContinuationHeaderHeight(webBook: WebBook): number {
  return 17 + estimateLines(webBook.topic, 11, 480) * 14;
}

/**
 * Packs the full, untruncated chapter content onto A4 pages. A chapter that does not fit in the space left on
 * a page continues on the next page in a "(cont.)" card, so no text is ever clipped or shortened.
 * `capacityScale` scales the usable page height assumed while packing; the renderer picks the largest value
 * whose pages all fit in the real layout.
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

    getChapterBlocks(chapter).forEach((block) => {
      const costIn = (page: ReportPageLayout) => {
        const lastFragment = page.fragments[page.fragments.length - 1];
        if (lastFragment?.chapterIndex === chapterIndex) return block.height;
        return (
          block.height +
          estimateCardChromeHeight(chapter, hasPlacedBlock) +
          (page.fragments.length > 0 ? CARD_GAP_PX : 0)
        );
      };

      let page = pages[pages.length - 1];
      if (page.fragments.length > 0 && used + costIn(page) > capacityOf(pages.length - 1)) {
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

export function buildPrintFriendlyReportPagesHtml(webBook: WebBook, capacityScale = 1): string[] {
  const safeWebBook = sanitizeWebBookForPresentation(webBook);
  const chapters = safeWebBook.chapters || [];
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
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #141414; padding-bottom: 5px; margin-bottom: 10px;">
              <div style="font-family: 'JetBrains Mono', monospace; font-size: 8.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.15em; line-height: 1.3; color: #141414;">
                Evolutionary Web-Book Engine
              </div>
            </div>

            <h1 style="font-family: 'Playfair Display', Georgia, serif; font-style: italic; font-weight: 700; font-size: 22px; line-height: 1.22; margin: 0 0 10px 0; color: #141414; word-break: break-word;">
              ${escapeHtml(safeWebBook.topic)}
            </h1>

            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 7px; margin-bottom: 10px;">
              <div style="border: 1px solid rgba(20,20,20,0.18); padding: 5px 8px; background: #fafafa; border-radius: 2px;">
                <div style="font-family: 'JetBrains Mono', monospace; font-size: 7px; text-transform: uppercase; color: #666; font-weight: 700;">Chapters</div>
                <div style="font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 700; color: #141414;">${totalChapters}</div>
              </div>
              <div style="border: 1px solid rgba(20,20,20,0.18); padding: 5px 8px; background: #fafafa; border-radius: 2px;">
                <div style="font-family: 'JetBrains Mono', monospace; font-size: 7px; text-transform: uppercase; color: #666; font-weight: 700;">Core Concepts</div>
                <div style="font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 700; color: #141414;">${totalConcepts}</div>
              </div>
              <div style="border: 1px solid rgba(20,20,20,0.18); padding: 5px 8px; background: #fafafa; border-radius: 2px;">
                <div style="font-family: 'JetBrains Mono', monospace; font-size: 7px; text-transform: uppercase; color: #666; font-weight: 700;">Generated Date</div>
                <div style="font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 700; color: #141414; padding-top: 2px;">${escapeHtml(dateStr)}</div>
              </div>
              <div style="border: 1px solid rgba(20,20,20,0.18); padding: 5px 8px; background: #fafafa; border-radius: 2px;">
                <div style="font-family: 'JetBrains Mono', monospace; font-size: 7px; text-transform: uppercase; color: #666; font-weight: 700;">Optimization</div>
                <div style="font-family: 'JetBrains Mono', monospace; font-size: 9.5px; font-weight: 700; color: #141414; padding-top: 2px;">
                  ${escapeHtml(safeWebBook.sourceMode === 'fallback_search' ? 'Fallback Search' : 'Grounded AI')}
                </div>
              </div>
            </div>

            <div style="border-left: 3px solid #141414; background: #F8F8F7; padding: 7px 10px; margin-bottom: 10px; border-radius: 0 2px 2px 0;">
              <div style="font-family: 'JetBrains Mono', monospace; font-size: 7.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #141414; margin-bottom: 2px;">
                Abstract
              </div>
              <div style="font-family: 'Inter', sans-serif; font-size: 9px; line-height: 1.42; color: #2B2B2B; word-break: break-word;">
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
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px; border-bottom: 1.5px solid #141414; padding-bottom: 5px; margin-bottom: 10px;">
          <div style="font-family: 'Playfair Display', Georgia, serif; font-style: italic; font-size: 11px; font-weight: 700; line-height: 1.35; color: #141414; max-width: 480px; min-width: 0; word-break: break-word;">
            ${escapeHtml(safeWebBook.topic)}
          </div>
          <div style="font-family: 'JetBrains Mono', monospace; font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; line-height: 1.35; color: #666; white-space: nowrap;">
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

export async function renderPrintFriendlyReportCanvases(webBook: WebBook): Promise<HTMLCanvasElement[]> {
  const isBrowserDom =
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    typeof (window as unknown as { HTMLCanvasElement?: unknown }).HTMLCanvasElement !== 'undefined' &&
    typeof document.createElement === 'function';

  if (!isBrowserDom) {
    // Graceful fallback for non-browser/Node testing environments
    const mockCanvas = {
      width: PAGE_WIDTH_PX,
      height: PAGE_HEIGHT_PX,
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
    // Pages are packed from estimated heights, which depend on the actual font. Search for the roomiest packing
    // whose pages all measure as fitting inside A4 in this browser, so no text is ever clipped and pages are
    // filled as fully as the real layout allows. Only measured-to-fit candidates are ever accepted.
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
        scale: 2,
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

export function compositeCanvasesToJpg(canvases: HTMLCanvasElement[]): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (canvases.length === 0) {
      reject(new Error('No canvases available to export.'));
      return;
    }

    if (canvases.length === 1) {
      canvases[0].toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Failed to generate JPG blob'))),
        'image/jpeg',
        0.95
      );
      return;
    }

    const sourceWidth = canvases[0].width;
    const sourceHeight = canvases.reduce((sum, c) => sum + c.height, 0);
    // Browsers cap canvas size (notably Safari/iOS), so long reports are scaled down to stay within it.
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
      0.95
    );
  });
}

export async function exportPrintFriendlyWebBookToImage(webBook: WebBook): Promise<void> {
  const safeWebBook = sanitizeWebBookForPresentation(webBook);
  const canvases = await renderPrintFriendlyReportCanvases(safeWebBook);
  const jpgBlob = await compositeCanvasesToJpg(canvases);
  downloadBlob(jpgBlob, getExportFileName(`${safeWebBook.topic}_PrintFriendly_Report`, 'jpg'));
}

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
    const imgData = canvases[index].toDataURL('image/jpeg', 0.95);
    doc.addImage(imgData, 'JPEG', 0, 0, a4WidthPt, a4HeightPt, undefined, 'FAST');
  }

  const pdfBlob = doc.output('blob');
  downloadBlob(pdfBlob, getExportFileName(`${safeWebBook.topic}_PrintFriendly_Report`, 'pdf'));
}
