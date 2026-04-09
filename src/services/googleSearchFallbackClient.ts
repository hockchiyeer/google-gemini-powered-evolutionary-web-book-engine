import type { SearchFallbackPayload } from '../types';

const SEARCH_FALLBACK_ROUTE = '/api/search-fallback';
const DUCKDUCKGO_LITE_URL = 'https://lite.duckduckgo.com/lite/';
const FALLBACK_FETCH_ATTEMPTS = 3;
const FALLBACK_FETCH_TIMEOUT_MS = 20000;

// Minimal placeholder type to avoid breaking other files
export type SearchFetchResult = unknown;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchGoogleSearchFallback(query: string): Promise<SearchFallbackPayload> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= FALLBACK_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(
        `${SEARCH_FALLBACK_ROUTE}?query=${encodeURIComponent(query)}`,
        {
          signal: AbortSignal.timeout(FALLBACK_FETCH_TIMEOUT_MS),
        }
      );

      if (!response.ok) {
        let errorMessage = 'Google Search fallback is currently unavailable.';

        try {
          const payload = (await response.json()) as { error?: string };
          if (payload.error) {
            errorMessage = payload.error;
          }
        } catch {
          // Ignore JSON parse failures and use default message
        }

        throw new Error(errorMessage);
      }

      return (await response.json()) as SearchFallbackPayload;
    } catch (error) {
      lastError =
        error instanceof Error
          ? error
          : new Error('Google Search fallback request failed.');

      if (attempt < FALLBACK_FETCH_ATTEMPTS) {
        await wait(800 * attempt);
        continue;
      }
    }
  }

  throw lastError ?? new Error('Google Search fallback is currently unavailable.');
}

export async function fetchDuckDuckGoLiteAttempt(
  query: string,
  labelSuffix: string
): Promise<SearchFetchResult | null> {
  const searchUrl = new URL(DUCKDUCKGO_LITE_URL);
  searchUrl.searchParams.set('q', query);
  searchUrl.searchParams.set('kl', 'us-en');

  try {
    return await fetchSearchHtml(searchUrl, `duckduckgo-lite-${labelSuffix}`);
  } catch {
    return null;
  }
}

function fetchSearchHtml(
  searchUrl: URL,
  sourceLabel: string
): Promise<SearchFetchResult> {
  throw new Error('Function not implemented.');
}