import type { Chapter, WebBook, WebBookSourceMode } from "../types.ts";

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
const STRUCTURED_EXPORT_HEADING_PATTERN = /^(?:VISUAL CONCEPT|CORE CONCEPTS|SUB-TOPICS|SOURCES|DEFINITIONS|GLOSSARY|TECHNICAL GLOSSARY)\s*:/i;
const EXPORT_METADATA_LINE_PATTERN = /^(?:Generated on:|CHAPTER\s+\d+\s*:)/i;
const JSONISH_KEY_PATTERN = /"(?:url|title|content|definitions|subTopics|summary|term|description|sourceUrl|priorityScore|informativeScore|authorityScore)"\s*:/i;
const DOMAINISH_PATTERN = /\b(?:https?:\/\/|www\.|(?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|io|co(?:\.[a-z]{2})?|ac\.uk|co\.uk))\S*/gi;
const URLISH_INLINE_PATTERN = /\b(?:https?:\/\/|www\.|(?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|io|co(?:\.[a-z]{2})?|ac\.uk|co\.uk)\/)\S*/gi;
const ISO_TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/;
const ISO_TIMESTAMP_GLOBAL_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g;
const BULLET_LINE_PATTERN = /^(?:[-*]|\d+[.)])\s+/;
const GENERIC_SYNTHESIS_SENTENCE_PATTERNS = [
  /^\s*overall,\s*the available search evidence keeps\b/i,
  /^\s*coverage of\b.+\b(?:draws on several related sources and recurring themes|repeatedly returns to|often connects)\b/i,
  /^\s*coverage from\b.+\bplaces\b.+\bshowing that the subject is best understood through several complementary sources rather than a single account\b/i,
  /^\s*(?:overview|context|themes?|views?|perspectives?|foundations?|map)\b.+\bconnected to\b.+\bwithin the broader story of\b/i,
];
const PROMOTIONAL_NARRATIVE_PATTERNS = [
  /\bthrough our website\b/i,
  /\bon our website\b/i,
  /\bapply\b.{0,40}\b(?:online|website|form)\b/i,
  /\be-?visa\b/i,
  /\bwithout having to go\b/i,
  /\bin a convenient way\b/i,
  /\bon your own\b/i,
];
const GENERIC_SOURCE_SUBDOMAINS = new Set([
  "www",
  "en",
  "m",
  "mobile",
  "home",
  "docs",
  "support",
  "blog",
  "amp",
  "edition",
]);

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

function countDomainMentions(text: string): number {
  return text.match(DOMAINISH_PATTERN)?.length || 0;
}

function trimWrapperPunctuation(text: string): string {
  return text
    .replace(/^[\[\]{}()<>`"'|,:;_-]+/, "")
    .replace(/[\[\]{}()<>`"'|,:;_-]+$/, "")
    .trim();
}

function isLikelyStructuredArtifactLine(line: string): boolean {
  const normalized = line.trim();
  if (!normalized) return false;

  if (/^[ \t]*`{3}[a-z0-9_-]*[ \t]*$/i.test(normalized)) return true;
  if (STRUCTURED_EXPORT_HEADING_PATTERN.test(normalized) || EXPORT_METADATA_LINE_PATTERN.test(normalized)) return true;
  if (JSONISH_KEY_PATTERN.test(normalized)) return true;

  const jsonishFields = normalized.match(/"[^"]+"\s*:/g)?.length || 0;
  if ((normalized.startsWith("[") || normalized.startsWith("{")) && jsonishFields >= 1) return true;
  if (jsonishFields >= 2 && /[\[\]{}]/.test(normalized)) return true;
  if (/^[\[\]{},"':;]+$/.test(normalized)) return true;

  const domainMentions = countDomainMentions(normalized);
  if (domainMentions >= 2 && !/[.!?]/.test(normalized)) return true;
  if (BULLET_LINE_PATTERN.test(normalized) && (domainMentions > 0 || ISO_TIMESTAMP_PATTERN.test(normalized))) return true;
  if (domainMentions >= 1 && ISO_TIMESTAMP_PATTERN.test(normalized) && !/[.!?]$/.test(normalized)) return true;

  return false;
}

function isLikelyStructuredArtifactParagraph(paragraph: string): boolean {
  const normalized = paragraph.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (isLikelyStructuredArtifactLine(normalized)) return true;
  if (JSONISH_KEY_PATTERN.test(normalized)) return true;
  return countDomainMentions(normalized) >= 2 && !/[.!?]/.test(normalized);
}

function containsNarrativeJunk(text: string): boolean {
  return GENERIC_SYNTHESIS_SENTENCE_PATTERNS.some((pattern) => pattern.test(text))
    || PROMOTIONAL_NARRATIVE_PATTERNS.some((pattern) => pattern.test(text));
}

function stripInlineUrlArtifacts(text: string): string {
  return text
    .replace(URLISH_INLINE_PATTERN, " ")
    .replace(ISO_TIMESTAMP_GLOBAL_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeNarrativeParagraph(paragraph: string): string {
  const normalizedParagraph = paragraph.replace(/\s+/g, " ").trim();
  if (!normalizedParagraph) return "";

  const withoutInlineUrls = stripInlineUrlArtifacts(normalizedParagraph);
  const sentences = splitIntoSentences(withoutInlineUrls);
  const cleanedSentences = (sentences.length > 0 ? sentences : [withoutInlineUrls])
    .map((sentence) => trimWrapperPunctuation(sentence.replace(/\s+/g, " ").trim()))
    .filter(Boolean)
    .filter((sentence) => !containsNarrativeJunk(sentence))
    .filter((sentence) => !isLikelyStructuredArtifactLine(sentence))
    .filter((sentence) => !isLikelyStructuredArtifactParagraph(sentence));

  return cleanedSentences.join(" ").trim();
}

export function sanitizeNarrativeText(text?: string | null): string {
  const raw = typeof text === "string" ? text.replace(/\r/g, "\n").trim() : "";
  if (!raw) {
    return "";
  }

  let cleaned = raw.replace(/^[ \t]*`{3}[a-z0-9_-]*[ \t]*$/gim, "").trim();
  const structuredSectionIndex = cleaned.search(
    /(?:^|\n)\s*(?:VISUAL CONCEPT|CORE CONCEPTS|SUB-TOPICS|SOURCES|DEFINITIONS|GLOSSARY|TECHNICAL GLOSSARY)\s*:\s*(?:\n|$)/i
  );
  if (structuredSectionIndex >= 0) {
    cleaned = cleaned.slice(0, structuredSectionIndex).trim();
  }

  const filteredLines: string[] = [];
  for (const line of cleaned.split("\n")) {
    const normalizedLine = line.trim();
    if (!normalizedLine) {
      if (filteredLines.length > 0 && filteredLines[filteredLines.length - 1] !== "") {
        filteredLines.push("");
      }
      continue;
    }

    if (isLikelyStructuredArtifactLine(normalizedLine)) {
      continue;
    }

    filteredLines.push(normalizedLine);
  }

  const paragraphs = filteredLines
    .join("\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim())
    .map((paragraph) => sanitizeNarrativeParagraph(paragraph))
    .filter(Boolean)
    .filter((paragraph) => !isLikelyStructuredArtifactParagraph(paragraph));

  return trimWrapperPunctuation(paragraphs.join("\n\n")).replace(/\n{3,}/g, "\n\n").trim();
}

function sanitizeInlineText(text?: string | null): string {
  return sanitizeNarrativeText(text).replace(/\s+/g, " ").trim();
}

export function sanitizeStructuredLabel(text?: string | null, fallback = ""): string {
  const raw = typeof text === "string" ? text.replace(/\r/g, " ").replace(/\s+/g, " ").trim() : "";
  const normalized = trimWrapperPunctuation(
    raw
      .replace(/^[ \t]*`{3}[a-z0-9_-]*[ \t]*/i, "")
      .replace(/[ \t]*`{3}$/i, "")
  );
  const candidate = normalized || sanitizeInlineText(raw);

  if (!candidate) return fallback.trim();
  if (STRUCTURED_EXPORT_HEADING_PATTERN.test(candidate) || EXPORT_METADATA_LINE_PATTERN.test(candidate)) {
    return fallback.trim();
  }
  if (JSONISH_KEY_PATTERN.test(candidate) || isLikelyStructuredArtifactLine(candidate)) {
    return fallback.trim();
  }
  if (countDomainMentions(candidate) > 0 && candidate.length < 120) {
    return fallback.trim();
  }
  if (!/[a-z0-9]/i.test(candidate) || candidate.length === 1) {
    return fallback.trim();
  }

  return candidate.slice(0, 160).trim() || fallback.trim();
}

function sanitizeChapterForPresentation(chapter: Chapter, index: number, topic = ""): Chapter {
  const fallbackTitle = `Chapter ${index + 1}`;
  const safeTopic = sanitizeStructuredLabel(topic, "knowledge") || "knowledge";
  const title = sanitizeStructuredLabel(chapter?.title, fallbackTitle) || fallbackTitle;
  const content = sanitizeNarrativeText(chapter?.content || "");
  const visualSeed = sanitizeStructuredLabel(chapter?.visualSeed, title || safeTopic) || safeTopic;
  const definitions = Array.isArray(chapter?.definitions)
    ? chapter.definitions
      .map((definition) => ({
        ...definition,
        term: sanitizeStructuredLabel(definition?.term, ""),
        description: sanitizeInlineText(definition?.description || ""),
      }))
      .filter((definition) => definition.term && definition.description)
    : [];
  const subTopics = Array.isArray(chapter?.subTopics)
    ? chapter.subTopics
      .map((subTopic) => ({
        ...subTopic,
        title: sanitizeStructuredLabel(subTopic?.title, ""),
        summary: sanitizeInlineText(subTopic?.summary || ""),
      }))
      .filter((subTopic) => subTopic.title && subTopic.summary)
    : [];
  const sourceUrls = Array.isArray(chapter?.sourceUrls)
    ? chapter.sourceUrls
      .map((source) => {
        if (typeof source === "string") {
          return source.trim();
        }

        if (!source?.url?.trim()) {
          return null;
        }

        return {
          title: sanitizeStructuredLabel(source.title, source.url),
          url: source.url.trim(),
        };
      })
      .filter((source): source is Chapter["sourceUrls"][number] => Boolean(source))
    : [];

  return {
    title,
    content,
    definitions,
    subTopics,
    sourceUrls,
    visualSeed,
  };
}

export function sanitizeWebBookForPresentation(webBook: WebBook): WebBook {
  const topic = sanitizeStructuredLabel(webBook?.topic, "Untitled WebBook") || "Untitled WebBook";
  const chapters = Array.isArray(webBook?.chapters)
    ? webBook.chapters
      .map((chapter, index) => sanitizeChapterForPresentation(chapter, index, topic))
      .filter((chapter) => chapter.content || chapter.definitions.length > 0 || chapter.subTopics.length > 0)
    : [];

  return {
    ...webBook,
    topic,
    chapters,
  };
}

function normalizeChapterForRender(chapter: Chapter, index: number): Chapter {
  const sanitizedChapter = sanitizeChapterForPresentation(chapter, index);
  return {
    title: sanitizedChapter.title || "Untitled Chapter",
    content: sanitizedChapter.content || "",
    definitions: sanitizedChapter.definitions || [],
    subTopics: sanitizedChapter.subTopics || [],
    sourceUrls: sanitizedChapter.sourceUrls || [],
    visualSeed: sanitizedChapter.visualSeed || "knowledge",
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
      if (phrase.length < 12) continue;

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
  const safeChapters = Array.isArray(chapters) ? chapters.map((chapter, index) => normalizeChapterForRender(chapter, index)) : [];
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
  const parts = hostname
    .split(".")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const meaningfulParts = parts.filter((part, index) => (
    index === parts.length - 1 || !GENERIC_SOURCE_SUBDOMAINS.has(part)
  ));
  const label = meaningfulParts.length >= 2
    ? meaningfulParts[meaningfulParts.length - 2]
    : meaningfulParts[0] || parts[0] || hostname;

  return label.replace(/[-_]/g, " ").trim() || hostname;
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

    const rawTitle = typeof source === "string" ? "" : (source.title?.trim() || "");
    const title = !rawTitle
      || rawTitle === url.toString()
      || /^https?:\/\//i.test(rawTitle)
      || /^www\./i.test(rawTitle)
      ? buildReadableSourceTitle(url)
      : rawTitle;

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

export function reduceRepeatedChapterSourceReferences(chapters: WebBook["chapters"]): WebBook["chapters"] {
  const usedUrls = new Set<string>();

  return chapters.map((chapter) => {
    const sourceUrls = Array.isArray(chapter.sourceUrls) ? chapter.sourceUrls : [];
    const seenWithinChapter = new Set<string>();
    const novelSources: typeof sourceUrls = [];
    const fallbackSources: typeof sourceUrls = [];

    sourceUrls.forEach((source) => {
      const url = typeof source === "string" ? source.trim() : source?.url?.trim();
      if (!url || seenWithinChapter.has(url)) {
        return;
      }

      seenWithinChapter.add(url);
      if (usedUrls.has(url)) {
        fallbackSources.push(source);
        return;
      }

      novelSources.push(source);
    });

    const dedupedSourceUrls = novelSources.length > 0 ? novelSources : fallbackSources.slice(0, 1);
    dedupedSourceUrls.forEach((source) => {
      const url = typeof source === "string" ? source.trim() : source?.url?.trim();
      if (url) {
        usedUrls.add(url);
      }
    });

    return {
      ...chapter,
      sourceUrls: dedupedSourceUrls,
    };
  });
}
