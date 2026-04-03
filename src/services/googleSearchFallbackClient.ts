import type { SearchFallbackPayload } from '../types';

const SEARCH_FALLBACK_ROUTE = '/api/search-fallback';

export async function fetchGoogleSearchFallback(query: string): Promise<SearchFallbackPayload> {
  const response = await fetch(`${SEARCH_FALLBACK_ROUTE}?query=${encodeURIComponent(query)}`);

  if (!response.ok) {
    let errorMessage = 'Google Search fallback is currently unavailable.';

    try {
      const payload = await response.json() as { error?: string };
      if (payload.error) {
        errorMessage = payload.error;
      }
    } catch {
      // Ignore JSON parse failures and use the default message.
    }

    throw new Error(errorMessage);
  }

  return response.json() as Promise<SearchFallbackPayload>;
}
