import { isNonJsonResponseText, looksLikeHtml, toPlainTextPreview } from './safeResponse';

export type GeminiFailureReason =
  | 'missing_api_key'
  | 'invalid_api_key'
  | 'quota_or_rate_limit'
  | 'service_unavailable'
  | 'network_unreachable';

// Disable the client-side Gemini timeout so long-running grounding and
// assembly requests are allowed to complete instead of being cut off early.
export const GEMINI_REQUEST_TIMEOUT_MS = 0;

function tryParseStructuredErrorPayload(input: string): unknown | null {
  const trimmed = input.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function extractStructuredErrorMessage(value: unknown, seen = new Set<unknown>()): string | null {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const parsed = tryParseStructuredErrorPayload(trimmed);
    if (parsed !== null) {
      return extractStructuredErrorMessage(parsed, seen) || trimmed;
    }

    // An HTML page (proxy/gateway/auth error) or the browser's "Unexpected token '<'" parse
    // error is not a useful message for the user, so summarise it instead of echoing it.
    if (isNonJsonResponseText(trimmed)) {
      const preview = looksLikeHtml(trimmed) ? toPlainTextPreview(trimmed, 120) : '';
      return `The service returned a non-JSON (HTML) response instead of the expected JSON${preview ? ` (${preview})` : ''}.`;
    }

    return trimmed;
  }

  if (typeof value !== 'object') {
    return null;
  }

  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const message = extractStructuredErrorMessage(item, seen);
      if (message) {
        return message;
      }
    }

    return null;
  }

  const candidate = value as Record<string, unknown>;
  const fieldsToInspect = [
    candidate.error,
    candidate.message,
    candidate.statusText,
    candidate.details,
    candidate.cause,
  ];

  for (const field of fieldsToInspect) {
    const message = extractStructuredErrorMessage(field, seen);
    if (message) {
      return message;
    }
  }

  return null;
}

function normalizeDisplayErrorText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function buildGeminiUserFacingErrorMessage(
  error: unknown,
  reason: GeminiFailureReason | null = null
): string {
  const detail = extractStructuredErrorMessage(error);
  let baseMessage: string | null = null;

  switch (reason) {
    case 'missing_api_key':
      baseMessage = 'Gemini API key is missing. Set GEMINI_API_KEY or VITE_GEMINI_API_KEY and try again.';
      break;
    case 'invalid_api_key':
      baseMessage = 'Gemini API key was rejected by Google. Check GEMINI_API_KEY or VITE_GEMINI_API_KEY and try again.';
      break;
    case 'quota_or_rate_limit':
      baseMessage = 'Gemini is currently busy or rate-limited. Please wait a minute and try again.';
      break;
    case 'service_unavailable':
      baseMessage = 'Gemini is temporarily unavailable. Please try again shortly.';
      break;
    case 'network_unreachable':
      baseMessage = 'Gemini could not be reached. Please verify your connection and try again.';
      break;
    default:
      baseMessage = null;
      break;
  }

  if (!baseMessage) {
    return detail || 'Unknown Gemini API error';
  }

  if (!detail) {
    return baseMessage;
  }

  const normalizedBase = normalizeDisplayErrorText(baseMessage);
  const normalizedDetail = normalizeDisplayErrorText(detail);
  if (!normalizedDetail || normalizedBase.includes(normalizedDetail) || normalizedDetail.includes(normalizedBase)) {
    return baseMessage;
  }

  return `${baseMessage}\n\nDetails: ${detail}`;
}
