import { Chapter } from "../types";

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

type DefinitionLike = {
  term?: string | null;
  description?: string | null;
};

type SubTopicLike = {
  title?: string | null;
  summary?: string | null;
};

export interface ChapterRenderPlan {
  chapter: Chapter;
  titlePageNumber: number;
  analysisPageNumber: number | null;
  renderableDefinitions: Chapter["definitions"];
  renderableSubTopics: Chapter["subTopics"];
}

export interface NormalizedSourceLink {
  title: string;
  url: string;
  hostname: string;
  isSearchResultsPage: boolean;
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

export function buildChapterRenderPlan(chapters: Chapter[]): ChapterRenderPlan[] {
  // Page 1 is the cover and page 2 is the table of contents.
  let nextPageNumber = 3;

  return chapters.map((chapter) => {
    const renderableDefinitions = getRenderableDefinitions(chapter.definitions || [], 6);
    const renderableSubTopics = getRenderableSubTopics(chapter.subTopics || []);
    const titlePageNumber = nextPageNumber;
    nextPageNumber += 1;

    const hasAnalysisPage = renderableDefinitions.length > 0 || renderableSubTopics.length > 0;
    const analysisPageNumber = hasAnalysisPage ? nextPageNumber : null;
    if (hasAnalysisPage) {
      nextPageNumber += 1;
    }

    return {
      chapter,
      titlePageNumber,
      analysisPageNumber,
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
    (hostname === "duckduckgo.com" && (url.pathname === "/" || url.pathname === "/html/" || url.pathname === "/html"))
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

  chapter.sourceUrls.forEach((source) => {
    const normalized = normalizeSourceLink(source);
    if (!normalized) return;
    if (!includeSearchResults && normalized.isSearchResultsPage) return;
    if (links.some((existing) => existing.url === normalized.url)) return;

    links.push(normalized);
  });

  return links.slice(0, maxItems);
}
