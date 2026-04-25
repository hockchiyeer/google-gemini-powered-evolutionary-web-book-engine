import assert from 'node:assert/strict';
import {
  GEMINI_REQUEST_TIMEOUT_MS,
  buildGeminiUserFacingErrorMessage,
} from '../../src/services/geminiUserFacingErrors.ts';
import { hasUsableFallbackPayloadEvidence } from '../../src/services/fallbackPayloadHeuristics.ts';
import { parseSearchExtractionResponse } from '../../src/services/searchIntakeParser.ts';
import {
  normalizeSourceLink,
  reduceRepeatedChapterSourceReferences,
  sanitizeNarrativeText,
  sanitizeStructuredLabel,
  sanitizeWebBookForPresentation,
} from '../../src/utils/webBookRender.ts';

assert.equal(
  GEMINI_REQUEST_TIMEOUT_MS,
  0,
  'Gemini requests should not be aborted by a hardcoded local timeout.'
);

const invalidApiKeyPayload = JSON.stringify({
  error: {
    code: 400,
    message: 'API key not valid. Please pass a valid API key.',
    status: 'INVALID_ARGUMENT',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'API_KEY_INVALID',
        domain: 'googleapis.com',
      },
    ],
  },
});

assert.equal(
  buildGeminiUserFacingErrorMessage(new Error(invalidApiKeyPayload), 'invalid_api_key'),
  'Gemini API key was rejected by Google. Check GEMINI_API_KEY or VITE_GEMINI_API_KEY and try again.\n\nDetails: API key not valid. Please pass a valid API key.'
);

const jsonSearchIntake = JSON.stringify([
  {
    url: 'https://example.com/json-source',
    title: 'JSON Source',
    content: 'JSON intake content with enough detail to remain meaningful.',
    definitions: [{ term: 'JSON term', description: 'Structured definition.' }],
    subTopics: [{ title: 'JSON subtopic', summary: 'Structured summary.' }],
    informativeScore: 0.84,
    authorityScore: 0.81,
  },
]);

assert.equal(
  parseSearchExtractionResponse(jsonSearchIntake, 'JSON intake should parse.')[0].url,
  'https://example.com/json-source'
);

const xmlSearchIntake = `
<sources>
  <source>
    <url>https://example.com/xml-source</url>
    <title>XML Source</title>
    <content>XML intake content with grounded detail for the parser.</content>
    <definitions>
      <definition>
        <term>XML term</term>
        <description>XML definition text.</description>
      </definition>
    </definitions>
    <subTopics>
      <subtopic>
        <title>XML subtopic</title>
        <summary>XML subtopic summary.</summary>
      </subtopic>
    </subTopics>
    <informativeScore>0.79</informativeScore>
    <authorityScore>0.77</authorityScore>
  </source>
</sources>
`;

const parsedXmlSearchIntake = parseSearchExtractionResponse(xmlSearchIntake, 'XML intake should parse.');
assert.equal(parsedXmlSearchIntake[0].title, 'XML Source');
assert.equal(parsedXmlSearchIntake[0].definitions[0].term, 'XML term');
assert.equal(parsedXmlSearchIntake[0].subTopics[0].title, 'XML subtopic');

const htmlSearchIntake = `
<div class="sources">
  <article class="source">
    <h2>HTML Source</h2>
    <a href="https://example.com/html-source">Read source</a>
    <p>HTML intake content with enough detail to survive markup stripping.</p>
    <p>Additional supporting context keeps the summary rich.</p>
  </article>
</div>
`;

const parsedHtmlSearchIntake = parseSearchExtractionResponse(htmlSearchIntake, 'HTML intake should parse.');
assert.equal(parsedHtmlSearchIntake[0].title, 'HTML Source');
assert.equal(parsedHtmlSearchIntake[0].url, 'https://example.com/html-source');
assert.match(parsedHtmlSearchIntake[0].content, /HTML intake content/i);

const rawTextSearchIntake = `
URL: https://example.com/raw-source
Title: Raw Text Source
Content: Raw text intake content that should be accepted without JSON wrapping.
Definitions:
- Raw concept: Raw definition text.
SubTopics:
- Raw angle: Raw subtopic summary.
InformativeScore: 0.74
AuthorityScore: 0.71
`;

const parsedRawTextSearchIntake = parseSearchExtractionResponse(rawTextSearchIntake, 'Raw text intake should parse.');
assert.equal(parsedRawTextSearchIntake[0].title, 'Raw Text Source');
assert.equal(parsedRawTextSearchIntake[0].definitions[0].term, 'Raw concept');
assert.equal(parsedRawTextSearchIntake[0].subTopics[0].title, 'Raw angle');

const multiBlockRawTextSearchIntake = `
Link: https://example.com/raw-source-a
Title: Raw Text Source A
Content: First raw text block with enough detail to remain meaningful.

URI: https://example.com/raw-source-b
Title: Raw Text Source B
Content: Second raw text block with enough detail to remain meaningful.
`;

const parsedMultiBlockRawTextSearchIntake = parseSearchExtractionResponse(multiBlockRawTextSearchIntake, 'Multi-block raw text intake should parse.');
assert.equal(parsedMultiBlockRawTextSearchIntake.length, 2);
assert.equal(parsedMultiBlockRawTextSearchIntake[1].url, 'https://example.com/raw-source-b');

// Regression: fenced JSON with trailing text causes stripStructuredResponseFence to fail,
// so the raw-text parser fires. The literal string "```json" must never become a chapter
// title or appear in exported chapter headings (VISUAL CONCEPT / CHAPTER N fields).
const fencedJsonWithTrailingText = `\`\`\`json
[{
  "url": "https://example.com/fenced-source",
  "title": "Fenced Source",
  "content": "Fenced intake content that is meaningful and has enough detail to pass validation.",
  "definitions": [{ "term": "Fenced term", "description": "Fenced definition." }],
  "subTopics": [{ "title": "Fenced subtopic", "summary": "Fenced summary." }],
  "informativeScore": 0.80,
  "authorityScore": 0.78
}]
\`\`\`
Some extra trailing text that prevents the closing fence from being at end-of-string.`;

const parsedFencedWithTrailing = parseSearchExtractionResponse(fencedJsonWithTrailingText, 'Fenced JSON with trailing text should parse.');
assert.notEqual(
  parsedFencedWithTrailing[0].title,
  '```json',
  'A code-fence marker must never become a source title.'
);
assert.ok(
  parsedFencedWithTrailing[0].content && parsedFencedWithTrailing[0].content.length > 0,
  'Content must be non-empty even when the fence is not cleanly closed.'
);

assert.equal(
  sanitizeStructuredLabel('[', 'Chapter 2'),
  'Chapter 2',
  'A single bracket must never survive as a chapter title.'
);

const contaminatedNarrative = `[ { "url": "https://example.com/raw-source", "title": "Raw Source", "content": "Structured blob that should not survive into chapter prose." } ]

VISUAL CONCEPT: Raw Source

CORE CONCEPTS:
- Raw Source: https://example.com/raw-source

SOURCES:
- Raw Source - https://example.com/raw-source`;

assert.equal(
  sanitizeNarrativeText(contaminatedNarrative),
  '',
  'Structured JSON/export artifacts should be stripped from chapter prose instead of leaking into exports.'
);

const urlAndTimestampNoise = `www.sciencedirect.com/science/article/pii/S2949882125000167 2025-05-01T00:00:00.0000000 ailiteracy.institute/ai-literacy-review-march-11-2025/ 2025-03-11T00:00:00.0000000
Coverage of US VS UK on public AI Literacy often connects AI Literacy and classroom practice.
Public AI literacy debates now focus on which skills schools should teach and how those skills are assessed.`;

assert.equal(
  sanitizeNarrativeText(urlAndTimestampNoise),
  'Public AI literacy debates now focus on which skills schools should teach and how those skills are assessed.',
  'Standalone URL/timestamp dump lines and generic fallback bridge copy should be removed from chapter prose.'
);

const comparativeDomainNarrative = `Placed beside one another, sources from wikipedia.org, britannica.com, and state.gov keep returning to geography and history. That overlap suggests a shared core narrative around Malaysia, even as each source contributes its own mix of detail, framing, and emphasis.`;

assert.equal(
  sanitizeNarrativeText(comparativeDomainNarrative),
  comparativeDomainNarrative,
  'Comparative narrative sentences that cite multiple domains should survive prose sanitization.'
);

const urlDumpWithGenericSynthesis = `en.wikipedia.org/wiki/Indonesia en.wikipedia.org/wiki/Indonesia www.fao.org/indonesia/about-us/indonesia-at-a-glance/en www.countryreports.org/country/Indonesia.htm Overall, the available search evidence keeps indonesia - wikipedia connected to Indonesia, Indonesia at a glance, and History of Indonesia within the broader story of Indonesia.`;

assert.equal(
  sanitizeNarrativeText(urlDumpWithGenericSynthesis),
  '',
  'URL dumps and generic synthesis filler should not survive into chapter prose.'
);

const urlDumpWithRealNarrative = `en.wikipedia.org/wiki/Indonesia www.fao.org/indonesia/about-us/indonesia-at-a-glance/en Indonesia is the world\'s largest archipelagic state and spans thousands of islands across Southeast Asia.`;

assert.equal(
  sanitizeNarrativeText(urlDumpWithRealNarrative),
  'Indonesia is the world\'s largest archipelagic state and spans thousands of islands across Southeast Asia.',
  'Inline URL clusters should be stripped while retaining a meaningful narrative sentence.'
);

const genericBridgeNarrative = `overview connected to Iran War Clock — Accountability Tracker within the broader story of When would Iran war be ended?. 2026-04-17T00:21:43.0000000 2026-03-10T17:30:00.0000000 The Iran War Clock tracks the live length of the US- Iran War and the official predictions from the Trump Administration about its end.`;

assert.equal(
  sanitizeNarrativeText(genericBridgeNarrative),
  'The Iran War Clock tracks the live length of the US- Iran War and the official predictions from the Trump Administration about its end.',
  'Title-fragment fallback bridge sentences should be dropped while keeping the real narrative that follows them.'
);

const promotionalFallbackNarrative = `Through our website, you can apply for the e-Visa application form online in a convenient way without having to go to apply in the Indonesia embassy on your own.`;

assert.equal(
  sanitizeNarrativeText(promotionalFallbackNarrative),
  '',
  'Transactional promotional fallback copy should not survive into chapter prose.'
);

const inlineHeadingNarrative = `Reference comparison across docs.
Definitions: This line starts a legitimate section from the source page.
The next sentence has real explanatory detail.`;

assert.equal(
  sanitizeNarrativeText(inlineHeadingNarrative),
  'Reference comparison across docs. The next sentence has real explanatory detail.',
  'Inline heading words should not cause the rest of the narrative paragraph to be discarded.'
);

const sanitizedBook = sanitizeWebBookForPresentation({
  id: 'book-test',
  topic: 'Sample WebBook',
  timestamp: Date.now(),
  chapters: [
    {
      title: '[',
      content: contaminatedNarrative,
      definitions: [],
      subTopics: [],
      sourceUrls: [],
      visualSeed: '[',
    },
    {
      title: 'Practical Context',
      content: urlAndTimestampNoise,
      definitions: [],
      subTopics: [],
      sourceUrls: [{ title: '[', url: 'https://example.com/raw-source' }],
      visualSeed: 'AI literacy',
    },
  ],
});

assert.equal(
  sanitizedBook.chapters.length,
  1,
  'Chapters that collapse into pure structured noise should be removed before render/export.'
);
assert.equal(sanitizedBook.chapters[0].title, 'Practical Context');
assert.equal(
  sanitizedBook.chapters[0].content,
  'Public AI literacy debates now focus on which skills schools should teach and how those skills are assessed.'
);
assert.equal(
  typeof sanitizedBook.chapters[0].sourceUrls[0] === 'string'
    ? sanitizedBook.chapters[0].sourceUrls[0]
    : sanitizedBook.chapters[0].sourceUrls[0].title,
  'https://example.com/raw-source',
  'Malformed source titles should fall back to the URL instead of leaking bracket artifacts.'
);

assert.equal(
  normalizeSourceLink({
    title: 'https://en.wikipedia.org/wiki/Indonesia',
    url: 'https://en.wikipedia.org/wiki/Indonesia',
  })?.title,
  'wikipedia',
  'Display titles for source links should fall back to a readable host label instead of a raw URL.'
);

const cumulativeSnippetFallbackPayload = {
  query: 'Basic Topic',
  source: 'google-search-snippets' as const,
  provider: 'google' as const,
  summary: 'Brief topic overview.',
  aiOverview: [],
  results: [
    {
      title: 'Foundational Concepts',
      url: 'https://example.com/foundations',
      domain: 'example.com',
      snippet: 'Basic explainers describe the topic in clear terms and connect its vocabulary to the larger field.',
    },
    {
      title: 'Practical Context',
      url: 'https://example.org/context',
      domain: 'example.org',
      snippet: 'Reference material adds real world context, common examples, and the reasons the topic keeps appearing in introductions for new readers and students.',
    },
  ],
  extractedAt: 1,
};

assert.equal(
  hasUsableFallbackPayloadEvidence(cumulativeSnippetFallbackPayload),
  true,
  'Several shorter fallback snippets should count as usable evidence when they add up to enough meaningful content.'
);

const repeatedSourceCounts = reduceRepeatedChapterSourceReferences([
  {
    title: 'Shared references opening',
    content: 'Meaningful narrative content for the opening chapter.',
    definitions: [],
    subTopics: [],
    sourceUrls: [
      { title: 'Alpha', url: 'https://alpha.example.org' },
      { title: 'Beta', url: 'https://beta.example.org' },
      { title: 'Gamma', url: 'https://gamma.example.org' },
    ],
    visualSeed: 'alpha',
  },
  {
    title: 'Second chapter',
    content: 'Meaningful narrative content for the second chapter.',
    definitions: [],
    subTopics: [],
    sourceUrls: [
      { title: 'Alpha duplicate', url: 'https://alpha.example.org' },
      { title: 'Delta', url: 'https://delta.example.org' },
      { title: 'Gamma duplicate', url: 'https://gamma.example.org' },
    ],
    visualSeed: 'delta',
  },
  {
    title: 'Third chapter',
    content: 'Meaningful narrative content for the third chapter.',
    definitions: [],
    subTopics: [],
    sourceUrls: [
      { title: 'Beta duplicate', url: 'https://beta.example.org' },
      { title: 'Epsilon', url: 'https://epsilon.example.org' },
      { title: 'Delta duplicate', url: 'https://delta.example.org' },
    ],
    visualSeed: 'epsilon',
  },
]).reduce((counts, chapter) => {
  chapter.sourceUrls.forEach((source) => {
    const url = typeof source === 'string' ? source : source.url;
    counts.set(url, (counts.get(url) || 0) + 1);
  });
  return counts;
}, new Map<string, number>());

assert.equal(
  [...repeatedSourceCounts.values()].some((count) => count > 1),
  false,
  'Fallback chapter source trails should prefer fresh URLs across the book instead of repeating the same link on multiple pages.'
);

console.log('evolutionService regression checks passed');
