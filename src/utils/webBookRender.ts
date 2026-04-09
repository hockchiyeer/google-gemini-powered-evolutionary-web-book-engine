import { Chapter, WebBookSourceMode } from "../types";

const POISON_KEYWORDS = [
  "copyright",
  "rights reserved",
  "terms of service",
  "privacy policy",
  "unauthorized access",
  "cybersecurity",
  "protected by",
  "cookie policy",
  "scrapping",
  "bot detection",
  "access denied",
  "legal notice",
  "disclaimer",
  "all rights",
  "terms of use",
  "security warning",
  "intellectual property",
  "proprietary information",
  "confidentiality",
  "amen so be it",
  "and so it shall be",
  "for all eternity",
  "grand design of the universe",
];

const REPEATED_SUBSTRING_PATTERN = /(.{4,})\1{2,}/;
const ASSEMBLY_HEURISTIC = /\b(mov|push|pop|jmp|call|ret|int|add|sub|xor|nop|lea|cmp)\b/i;
const MIN_CHAPTER_TEXT_PAGES = 3;
const SEARCH_FALLBACK_TEXT_PAGES = 1;
const TARGET_WORDS_PER_TEXT_PAGE = 250;

type DefinitionLike = {
  term?: string | null;
  description?: string | null;
};

type SubTopicLike = {
  title?: string | null;
  summary?: string | null;
};

export interface ChapterNarrativePage {
  pageNumber: number;
  content: string;
  pageKind: "opening" | "analysis" | "synthesis";
}

export interface ChapterRenderPlan {
  chapter: Chapter;
  titlePageNumber: number;
  textPages: ChapterNarrativePage[];
  glossaryPageNumber: number;
  renderableDefinitions: Chapter["definitions"];
  renderableSubTopics: Chapter["subTopics"];
}

export interface NormalizedSourceLink {
  title: string;
  url: string;
  hostname: string;
  isSearchResultsPage: boolean;
}

function normalizeChapterForRender(chapter: Chapter): Chapter {
  return {
    title: typeof chapter?.title === "string" && chapter.title.trim() ? chapter.title.trim() : "Untitled Chapter",
    content: typeof chapter?.content === "string" ? chapter.content : "",
    definitions: Array.isArray(chapter?.definitions) ? chapter.definitions : [],
    subTopics: Array.isArray(chapter?.subTopics) ? chapter.subTopics : [],
    sourceUrls: Array.isArray(chapter?.sourceUrls) ? chapter.sourceUrls : [],
    visualSeed: typeof chapter?.visualSeed === "string" && chapter.visualSeed.trim() ? chapter.visualSeed.trim() : "knowledge",
  };
}

export function isMeaningfulText(text?: string | null, description = ""): boolean {
  if (!text) return false;

  const normalizedText = text.trim();
  const normalizedDescription = description.trim();
  if (!normalizedText) return false;

  const clean = normalizedText.replace(/\s/g, "");
  const lowerText = normalizedText.toLowerCase();
  const lowerDesc = normalizedDescription.toLowerCase();

  if (/^\d+$/.test(clean)) return false;
  if (/(.)\1{8,}/.test(clean)) return false;
  if (/\d{10,}/.test(clean)) return false;
  if (normalizedText.length > 40 && !normalizedText.includes(" ")) return false;
  if (clean.length > 12 && !/[aeiou]/i.test(clean)) return false;

  const parts = clean.split(/[-_]/);
  if (parts.length > 3) {
    const uniqueParts = new Set(parts);
    if (uniqueParts.size < parts.length / 2) return false;
  }

  if (clean.includes("TCXGSD") && clean.length > 30) {
    const tcxCount = (clean.match(/TCXGSD/g) || []).length;
    if (tcxCount > 2) return false;
  }

  if (REPEATED_SUBSTRING_PATTERN.test(clean)) return false;
  if (POISON_KEYWORDS.some((word) => lowerText.includes(word) || lowerDesc.includes(word))) return false;
  if (normalizedDescription.length > 1000) return false;

  const words = lowerText
    .split(/\s+/)
    .concat(lowerDesc.split(/\s+/))
    .filter((word) => word.length > 0);

  if (words.length > 30) {
    const uniqueWords = new Set(words);
    const uniqueRatio = uniqueWords.size / words.length;
    if (uniqueRatio < 0.35) return false;

    const andItsCount = (lowerText.match(/and its/g) || []).length + (lowerDesc.match(/and its/g) || []).length;
    const andOurCount = (lowerText.match(/and our/g) || []).length + (lowerDesc.match(/and our/g) || []).length;
    const andTheCount = (lowerText.match(/and the/g) || []).length + (lowerDesc.match(/and the/g) || []).length;
    const andAllCount = (lowerText.match(/and all/g) || []).length + (lowerDesc.match(/and all/g) || []).length;
    if (andItsCount > 4 || andOurCount > 4 || andTheCount > 8 || andAllCount > 4) return false;

    for (let i = 0; i < words.length - 1; i += 1) {
      const phrase = `${words[i]} ${words[i + 1]}`;
      if (phrase.length < 5) continue;

      let count = 0;
      for (let j = 0; j < words.length - 1; j += 1) {
        if (`${words[j]} ${words[j + 1]}` === phrase) {
          count += 1;
        }
      }

      if (count > 3) return false;
    }
  }

  if (ASSEMBLY_HEURISTIC.test(normalizedText) || ASSEMBLY_HEURISTIC.test(normalizedDescription)) return false;
  if (/[0-9a-f]{2,}\s[0-9a-f]{2,}\s[0-9a-f]{2,}/i.test(normalizedText)) return false;

  return true;
}

export function getRenderableDefinitions<T extends DefinitionLike>(definitions: T[] = [], maxItems = Number.POSITIVE_INFINITY): T[] {
  const seenTerms = new Set<string>();

  return definitions
    .filter((definition) => {
      const term = definition.term?.trim() || "";
      const description = definition.description?.trim() || "";
      if (!term || !description) return false;

      const termKey = term.toLowerCase();
      if (seenTerms.has(termKey)) return false;
      if (!isMeaningfulText(term, description)) return false;

      seenTerms.add(termKey);
      return true;
    })
    .slice(0, maxItems);
}

export function getRenderableSubTopics<T extends SubTopicLike>(subTopics: T[] = []): T[] {
  const seenTitles = new Set<string>();

  return subTopics.filter((subTopic) => {
    const title = subTopic.title?.trim() || "";
    const summary = subTopic.summary?.trim() || "";
    if (!title || !summary) return false;

    const titleKey = title.toLowerCase();
    if (seenTitles.has(titleKey)) return false;
    if (!isMeaningfulText(title, summary)) return false;

    seenTitles.add(titleKey);
    return true;
  });
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function splitParagraphIntoTwo(paragraph: string): string[] {
  const normalized = paragraph.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }

  const sentences = splitIntoSentences(normalized);
  if (sentences.length >= 4) {
    const midpoint = Math.ceil(sentences.length / 2);
    return [
      sentences.slice(0, midpoint).join(" ").trim(),
      sentences.slice(midpoint).join(" ").trim(),
    ].filter(Boolean);
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length >= 30) {
    const midpoint = Math.ceil(words.length / 2);
    return [
      words.slice(0, midpoint).join(" ").trim(),
      words.slice(midpoint).join(" ").trim(),
    ].filter(Boolean);
  }

  return [normalized];
}

function ensureMinimumParagraphs(paragraphs: string[], minimumParagraphs: number): string[] {
  const result = paragraphs
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  let safetyCounter = 0;
  while (result.length < minimumParagraphs && safetyCounter < 16) {
    safetyCounter += 1;

    let longestIndex = -1;
    let longestWordCount = -1;

    result.forEach((paragraph, index) => {
      const wordCount = countWords(paragraph);
      if (wordCount > longestWordCount) {
        longestWordCount = wordCount;
        longestIndex = index;
      }
    });

    if (longestIndex === -1) {
      break;
    }

    const splitParagraph = splitParagraphIntoTwo(result[longestIndex]);
    if (splitParagraph.length < 2) {
      break;
    }

    result.splice(longestIndex, 1, ...splitParagraph);
  }

  return result;
}

function normalizeChapterParagraphs(content: string, minimumParagraphs = MIN_CHAPTER_TEXT_PAGES): string[] {
  const normalized = content.replace(/\r/g, "").trim();
  if (!normalized) {
    return [];
  }

  const explicitParagraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (explicitParagraphs.length >= minimumParagraphs) {
    return ensureMinimumParagraphs(explicitParagraphs, minimumParagraphs);
  }

  if (explicitParagraphs.length > 1) {
    return ensureMinimumParagraphs(explicitParagraphs, minimumParagraphs);
  }

  const sentences = splitIntoSentences(normalized);
  if (sentences.length === 0) {
    return [normalized];
  }

  const paragraphTarget = Math.max(6, Math.min(9, Math.ceil(sentences.length / 2)));
  const groupSize = Math.max(2, Math.ceil(sentences.length / paragraphTarget));
  const generatedParagraphs: string[] = [];

  for (let index = 0; index < sentences.length; index += groupSize) {
    generatedParagraphs.push(sentences.slice(index, index + groupSize).join(" ").trim());
  }

  return ensureMinimumParagraphs(generatedParagraphs, minimumParagraphs);
}

function buildNarrativePageContents(content: string, pageCount = MIN_CHAPTER_TEXT_PAGES): string[] {
  const paragraphs = normalizeChapterParagraphs(content, pageCount);
  if (paragraphs.length === 0) {
    return Array.from({ length: pageCount }, () => "");
  }

  const balancedParagraphs = ensureMinimumParagraphs(paragraphs, pageCount);
  const totalWords = balancedParagraphs.reduce((sum, paragraph) => sum + countWords(paragraph), 0);
  const targetWords = Math.max(TARGET_WORDS_PER_TEXT_PAGE, Math.ceil(totalWords / pageCount));
  const pages = Array.from({ length: pageCount }, () => [] as string[]);

  let pageIndex = 0;
  let currentPageWords = 0;

  for (let index = 0; index < balancedParagraphs.length; index += 1) {
    const paragraph = balancedParagraphs[index];
    const words = countWords(paragraph);
    const paragraphsRemaining = balancedParagraphs.length - index;
    const pagesRemaining = pageCount - pageIndex;

    if (
      pageIndex < pageCount - 1 &&
      pages[pageIndex].length > 0 &&
      (currentPageWords >= targetWords || paragraphsRemaining <= pagesRemaining - 1)
    ) {
      pageIndex += 1;
      currentPageWords = 0;
    }

    pages[pageIndex].push(paragraph);
    currentPageWords += words;
  }

  for (let index = 1; index < pages.length; index += 1) {
    if (pages[index].length > 0) {
      continue;
    }

    for (let donorIndex = index - 1; donorIndex >= 0; donorIndex -= 1) {
      if (pages[donorIndex].length > 1) {
        const movedParagraph = pages[donorIndex].pop();
        if (movedParagraph) {
          pages[index].push(movedParagraph);
          break;
        }
      }
    }
  }

  return pages.map((page, index) => {
    if (page.length > 0) {
      return page.join("\n\n");
    }

    return balancedParagraphs[index] || balancedParagraphs[balancedParagraphs.length - 1] || content.trim();
  });
}

function getNarrativePageCount(sourceMode?: WebBookSourceMode): number {
  return sourceMode === "search-fallback" ? SEARCH_FALLBACK_TEXT_PAGES : MIN_CHAPTER_TEXT_PAGES;
}

export function buildChapterRenderPlan(
  chapters: Chapter[],
  options: { sourceMode?: WebBookSourceMode } = {}
): ChapterRenderPlan[] {
  const narrativePageCount = getNarrativePageCount(options.sourceMode);
  const safeChapters = Array.isArray(chapters) ? chapters.map(normalizeChapterForRender) : [];
  let nextPageNumber = 3;
  const pageKinds: ChapterNarrativePage["pageKind"][] = ["opening", "analysis", "synthesis"];

  return safeChapters.map((chapter) => {
    const renderableDefinitions = getRenderableDefinitions(chapter.definitions || [], 8);
    const renderableSubTopics = getRenderableSubTopics(chapter.subTopics || []).slice(0, 4);
    const textPageContents = buildNarrativePageContents(chapter.content, narrativePageCount);
    const titlePageNumber = nextPageNumber;
    const textPages = textPageContents.map((content, index) => ({
      pageNumber: titlePageNumber + index,
      content,
      pageKind: pageKinds[index] || "synthesis",
    }));

    nextPageNumber += textPages.length;
    const glossaryPageNumber = nextPageNumber;
    nextPageNumber += 1;

    return {
      chapter,
      titlePageNumber,
      textPages,
      glossaryPageNumber,
      renderableDefinitions,
      renderableSubTopics,
    };
  });
}

function buildReadableSourceTitle(url: URL): string {
  const hostname = url.hostname.replace(/^www\./, "");
  return hostname.split(".")[0]?.replace(/[-_]/g, " ") || hostname;
}

function isSearchResultsPage(url: URL): boolean {
  const hostname = url.hostname.replace(/^www\./, "");
  return (
    ((hostname === "google.com" || hostname.endsWith(".google.com")) && url.pathname === "/search") ||
    (hostname === "duckduckgo.com" && (url.pathname === "/" || url.pathname === "/html/" || url.pathname === "/html" || url.pathname === "/lite/" || url.pathname === "/lite"))
  );
}

export function normalizeSourceLink(source: Chapter["sourceUrls"][number]): NormalizedSourceLink | null {
  const rawUrl = typeof source === "string" ? source : source.url;
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl);
    if (!/^https?:$/.test(url.protocol)) {
      return null;
    }

    const title = typeof source === "string"
      ? buildReadableSourceTitle(url)
      : (source.title?.trim() || buildReadableSourceTitle(url));

    return {
      title,
      url: url.toString(),
      hostname: url.hostname.replace(/^www\./, ""),
      isSearchResultsPage: isSearchResultsPage(url),
    };
  } catch {
    return null;
  }
}

export function getChapterSourceLinks(
  chapter: Chapter,
  options: { includeSearchResults?: boolean; maxItems?: number } = {}
): NormalizedSourceLink[] {
  const { includeSearchResults = true, maxItems = Number.POSITIVE_INFINITY } = options;
  const links: NormalizedSourceLink[] = [];

  const sourceUrls = Array.isArray(chapter?.sourceUrls) ? chapter.sourceUrls : [];

  sourceUrls.forEach((source) => {
    const normalized = normalizeSourceLink(source);
    if (!normalized) return;
    if (!includeSearchResults && normalized.isSearchResultsPage) return;
    if (links.some((existing) => existing.url === normalized.url)) return;

    links.push(normalized);
  });

  return links.slice(0, maxItems);
}
