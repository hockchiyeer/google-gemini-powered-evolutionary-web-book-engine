import type { SearchFallbackMode, SearchFallbackOptions, SearchFallbackPayload } from '../types';

const SEARCH_FALLBACK_ROUTE = '/api/search-fallback';
const FALLBACK_FETCH_ATTEMPTS = 3;
const FALLBACK_FETCH_TIMEOUT_MS = 20000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildFallbackModeLabel(mode: SearchFallbackMode): string {
  switch (mode) {
    case 'off':
      return 'Fallback search';
    case 'duckduckgo':
      return 'DuckDuckGo fallback search';
    case 'google':
      return 'Google Search fallback';
    default:
      return 'Google Search + DuckDuckGo fallback search';
  }
}

export async function fetchGoogleSearchFallback(
  query: string,
  options: SearchFallbackOptions = { mode: 'google_duckduckgo' }
): Promise<SearchFallbackPayload> {
  let lastError: Error | null = null;
  const modeLabel = buildFallbackModeLabel(options.mode);

  if (options.mode === 'off') {
    throw new Error('Fallback search is disabled for this request.');
  }

  for (let attempt = 1; attempt <= FALLBACK_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const requestUrl = new URL(SEARCH_FALLBACK_ROUTE, window.location.origin);
      requestUrl.searchParams.set('query', query);
      requestUrl.searchParams.set('mode', options.mode);

      const response = await fetch(requestUrl.toString(), {
        signal: AbortSignal.timeout(FALLBACK_FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        let errorMessage = `${modeLabel} is currently unavailable.`;

        try {
          const payload = (await response.json()) as { error?: string };
          if (payload.error) {
            errorMessage = payload.error;
          }
        } catch {
          // Ignore JSON parse failures and use the default message.
        }

        throw new Error(errorMessage);
      }

      return (await response.json()) as SearchFallbackPayload;
    } catch (error) {
      lastError =
        error instanceof Error
          ? error
          : new Error(`${modeLabel} request failed.`);

      if (attempt < FALLBACK_FETCH_ATTEMPTS) {
        await wait(800 * attempt);
        continue;
      }
    }
  }

  throw lastError ?? new Error(`${modeLabel} is currently unavailable.`);
}
