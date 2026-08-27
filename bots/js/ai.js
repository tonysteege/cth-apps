// CTH Bots - the model client.
//
// Every call goes to the SAME Worker the Slides app already uses
// (apps-api.coachtonyhockey.com, present-worker/): the provider keys live
// there as Worker secrets, never in this repo and never in the browser.
// Three endpoints:
//
//   POST /ai/text    { system, prompt }              -> { text }
//   POST /ai/vision  { prompt, image }               -> { text }
//   POST /ai/image   { prompt, aspect, n }           -> { images: [dataUrl] }
//
// The app is still account-free and stores nothing server-side; the Worker
// holds no state and logs no prompts.

const API = location.hostname === 'localhost'
  ? 'https://apps-api.coachtonyhockey.com'
  : 'https://apps-api.coachtonyhockey.com';

class AiError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}

async function post(path, body, signal) {
  let r;
  try {
    r = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new AiError('Could Not Reach The CTH AI Service - Check Your Connection', 'net');
  }
  let data = null;
  try { data = await r.json(); } catch (_) { /* non-JSON error body */ }
  if (!r.ok) {
    if (r.status === 404) throw new AiError('The AI Service Is Not Deployed Yet - See Setup In Settings', 'missing');
    if (r.status === 401 || r.status === 403) throw new AiError('The AI Service Has No Key Configured Yet - See Setup In Settings', 'nokey');
    if (r.status === 429) throw new AiError('Rate Limited By The Model Provider - Try Again In A Moment', 'rate');
    throw new AiError(data?.error || `The AI Service Returned ${r.status}`, 'http');
  }
  return data;
}

export const aiText = (system, prompt, signal) => post('/ai/text', { system, prompt }, signal).then((d) => d.text || '');
export const aiVision = (prompt, image, signal) => post('/ai/vision', { prompt, image }, signal).then((d) => d.text || '');
export const aiImage = (prompt, aspect, n, signal) => post('/ai/image', { prompt, aspect, n }, signal).then((d) => d.images || []);

// Models answer JSON well but sometimes wrap it in prose or a fence. Pull
// the first array or object out rather than failing the whole run.
export function parseJson(text) {
  const t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : t;
  try { return JSON.parse(body); } catch (_) { /* keep digging */ }
  const start = body.search(/[[{]/);
  if (start >= 0) {
    for (let end = body.length; end > start; end--) {
      try { return JSON.parse(body.slice(start, end)); } catch (_) { /* shrink */ }
    }
  }
  return null;
}

export { AiError };
