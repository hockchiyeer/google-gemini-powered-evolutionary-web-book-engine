import type { SearchFallbackMode, EngineOptions, SearchFallbackPayload } from '../types';

const SEARCH_FALLBACK_ROUTE = '/api/search-fallback';
const FALLBACK_FETCH_ATTEMPTS = 3;

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
  options: EngineOptions = { mode: 'google_duckduckgo' }
): Promise<SearchFallbackPayload> {
  let lastError: Error | null = null;
  const modeLabel = buildFallbackModeLabel(options.mode);

  if (options.mode === 'off') {
    throw new Error('Fallback search is disabled for this request.');
  }

  for (let attempt = 1; attempt <= FALLBACK_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const requestUrl = new URL(SEARCH_FALLBACK_ROUTE, window.location.origin === 'null' ? window.location.href : window.location.origin);
      requestUrl.searchParams.set('query', query);
      requestUrl.searchParams.set('mode', options.mode);

      const response = await fetch(requestUrl.toString());
      const contentType = response.headers.get('content-type') || '';

      if (!response.ok) {
        let errorMessage = `${modeLabel} is currently unavailable.`;

        if (contentType.includes('application/json')) {
          try {
            const payload = (await response.json()) as { error?: string };
            if (payload.error) {
              errorMessage = payload.error;
            }
          } catch {
            // Ignore JSON parse failures and use the default message.
          }
        }

        throw new Error(errorMessage);
      }

      if (!contentType.includes('application/json')) {
        const text = await response.text().catch(() => '');
        const snippet = text.slice(0, 200).replace(/<[^>]+>/g, ' ').trim();
        throw new Error(`${modeLabel} returned an invalid response format (expected JSON, got ${contentType}). ${snippet ? `Preview: ${snippet}` : ''}`);
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
