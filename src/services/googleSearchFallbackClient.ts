import type { SearchFallbackPayload } from '../types';

const SEARCH_FALLBACK_ROUTE = '/api/search-fallback';
const FALLBACK_FETCH_ATTEMPTS = 3;
const FALLBACK_FETCH_TIMEOUT_MS = 20000;

type FallbackFetchError = Error & {
  status?: number;
  nonRetryable?: boolean;
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFallbackFetchError(message: string, status?: number, nonRetryable = false): FallbackFetchError {
  const error = new Error(message) as FallbackFetchError;
  if (typeof status === 'number') {
    error.status = status;
  }
  if (nonRetryable) {
    error.nonRetryable = true;
  }
  return error;
}

function isNonRetryableFallbackError(error: Error): boolean {
  const typedError = error as FallbackFetchError;
  if (typedError.nonRetryable) {
    return true;
  }

  const status = typedError.status;
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
    return true;
  }

  return /no extractable search snippets were available|query parameter is required/i.test(error.message);
}

export async function fetchGoogleSearchFallback(query: string): Promise<SearchFallbackPayload> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= FALLBACK_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${SEARCH_FALLBACK_ROUTE}?query=${encodeURIComponent(query)}`, {
        signal: AbortSignal.timeout(FALLBACK_FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        let errorMessage = `Google Search fallback is currently unavailable (HTTP ${response.status}).`;

        try {
          const payload = await response.json() as { error?: string };
          if (payload.error) {
            errorMessage = payload.error;
          }
        } catch {
          // Ignore JSON parse failures and use the default message.
        }

        const nonRetryable = (response.status >= 400 && response.status < 500 && response.status !== 429) ||
          /no extractable search snippets were available/i.test(errorMessage);

        throw createFallbackFetchError(errorMessage, response.status, nonRetryable);
      }

      return response.json() as Promise<SearchFallbackPayload>;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Google Search fallback request failed.');

      if (attempt < FALLBACK_FETCH_ATTEMPTS && !isNonRetryableFallbackError(lastError)) {
        await wait(800 * attempt);
        continue;
      }

      break;
    }
  }

  throw lastError || new Error('Google Search fallback is currently unavailable.');
}
