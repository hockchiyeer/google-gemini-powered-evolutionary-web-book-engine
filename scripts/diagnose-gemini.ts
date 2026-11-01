/**
 * npm run diagnose [-- model1 model2 ...]
 *
 * Talks to Google directly with the GEMINI_API_KEY from .env / the environment (no app server needed) and prints, per
 * model, what Google actually answered for (1) a plain request and (2) a Google Search grounded request. Run it on the
 * machine where the app fails: it tells "daily quota", "per-minute limit", "model has no quota on this project",
 * "key rejected/blocked", "model not available" and "cannot reach Google" apart, which the app UI used to merge into
 * "could not be reached" / "busy, wait a minute".
 */
import dotenv from 'dotenv';
import { GEMINI_MODELS } from '../src/types.ts';
import { classifyGeminiError } from '../server/geminiErrors.ts';

dotenv.config();

const key = process.env.GEMINI_API_KEY || '';
const models = process.argv.slice(2).length > 0 ? process.argv.slice(2) : [...GEMINI_MODELS];
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

const ADVICE: Record<string, string> = {
  missing_api_key: 'No key found. Put GEMINI_API_KEY=... in .env (or the hosting secrets) and restart the server.',
  invalid_api_key: 'Google rejected the key. Create a new key in Google AI Studio and update GEMINI_API_KEY; restart the server.',
  permission_denied: 'HTTP 403: key revoked/leaked/restricted, API not enabled, or the account/region is blocked. Check the key and project in AI Studio.',
  model_not_found: 'Model not offered to this project (e.g. gemini-2.5-flash is limited to existing users). Pick another model.',
  bad_request: 'HTTP 400: the request itself was rejected (see message). A configuration problem, not quota.',
  quota_daily: 'Daily quota used up for this MODEL on this PROJECT (not per key). Resets at midnight Pacific Time. Use another model or enable billing.',
  no_free_tier: 'limit: 0 - this model has no quota on this project\'s tier. Waiting will never fix it. Use another model or enable billing.',
  rate_limited: 'Per-minute limit. Clears after a short wait; the app now waits and retries by itself.',
  overloaded: 'HTTP 503: Google-side overload. Transient.',
  internal: 'Transient Google-side error.',
  network: 'No answer from Google at all: DNS/proxy/firewall/offline. The problem is the network, not the key or quota.',
};

async function call(model: string, body: unknown) {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (response.ok) return { ok: true as const, ms: Date.now() - startedAt, reason: 'ok', detail: '' };
    const classified = classifyGeminiError(Object.assign(new Error(text), { status: response.status }));
    return {
      ok: false as const,
      ms: Date.now() - startedAt,
      reason: classified.reason,
      detail: `HTTP ${classified.httpStatus}${classified.retryAfterMs != null ? `, retry in ${Math.ceil(classified.retryAfterMs / 1000)}s` : ''}: ${classified.message.slice(0, 160).replace(/\s+/g, ' ')}`,
    };
  } catch (error) {
    const classified = classifyGeminiError(error);
    return { ok: false as const, ms: Date.now() - startedAt, reason: classified.reason, detail: String((error as Error)?.cause ?? (error as Error)?.message ?? error).slice(0, 160) };
  }
}

function nextResetLocal(): string {
  // Daily quotas reset at midnight Pacific Time.
  const now = new Date();
  const pacificNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const pacificMidnight = new Date(pacificNow);
  pacificMidnight.setHours(24, 0, 0, 0);
  const resetAt = new Date(now.getTime() + (pacificMidnight.getTime() - pacificNow.getTime()));
  return resetAt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

if (!key) {
  console.log(`GEMINI_API_KEY is not set. ${ADVICE.missing_api_key}`);
  process.exit(1);
}

console.log(`Key: ${key.slice(0, 4)}...${key.slice(-2)} (${key.length} chars, ${/^AIza[0-9A-Za-z_-]{30,}$/.test(key) ? 'format looks valid' : 'FORMAT LOOKS WRONG - did you paste extra characters or quotes?'})`);
console.log(`Next daily-quota reset (midnight Pacific) in your local time: ${nextResetLocal()}`);
console.log('Note: limits are per Google PROJECT and per MODEL, not per key; a new key in the same project shares them.\n');

const seen = new Set<string>();
for (const model of models) {
  const plain = await call(model, { contents: [{ parts: [{ text: 'Reply with the single word OK' }] }], generationConfig: { maxOutputTokens: 256 } });
  const grounded = await call(model, {
    contents: [{ parts: [{ text: 'Name one fact about Malaysia, using Google Search.' }] }],
    tools: [{ googleSearch: {} }],
    generationConfig: { maxOutputTokens: 512 },
  });
  console.log(`${model}`);
  console.log(`   plain text : ${plain.ok ? `OK (${plain.ms} ms)` : `${plain.reason} - ${plain.detail}`}`);
  console.log(`   + grounding: ${grounded.ok ? `OK (${grounded.ms} ms)` : `${grounded.reason} - ${grounded.detail}`}`);
  for (const result of [plain, grounded]) {
    if (!result.ok && !seen.has(result.reason)) {
      seen.add(result.reason);
    }
  }
}

if (seen.size > 0) {
  console.log('\nWhat it means:');
  for (const reason of seen) console.log(` - ${reason}: ${ADVICE[reason] ?? ''}`);
} else {
  console.log('\nEvery model answered. If the app still fails, run it and check the server console for "[gemini] ..." lines.');
}
