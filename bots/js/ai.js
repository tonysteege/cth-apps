// CTH Bots - the model client.
//
// Every call goes to the SAME Worker the Slides app already uses
// (apps-api.coachtonyhockey.com, present-worker/), which runs the models on
// Workers AI. Three endpoints:
//
//   POST /ai/text    { system, prompt, quality? }    -> { text }
//   POST /ai/vision  { prompt, image, quality? }     -> { text }
//   POST /ai/image   { prompt, aspect, n, quality? } -> { images: [dataUrl] }
//
// It also reads a Notion page through the SAME /notion/page/<id> endpoint
// Slides already uses, so a bot can be handed a page link as source
// material without a second service or a second permission.
//
// The models are WORKERS AI, billed to the Cloudflare account the Worker
// runs on - there is no API key anywhere in this app, and because the work
// happens at the edge the bots run with the laptop shut. The app stays
// account-free; the Worker holds no state and logs no prompts.

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
    if (r.status === 404) throw new AiError('The CTH Worker Needs One Deploy Before The Bots Can Run', 'missing');
    if (r.status === 503) throw new AiError('Workers AI Is Not Bound Yet - Redeploy The CTH Worker', 'missing');
    if (r.status === 422) throw new AiError(data?.message || 'That Wording Was Blocked - Reword The Brief', 'flagged');
    if (r.status === 429) throw new AiError('Rate Limited By The Model Provider - Try Again In A Moment', 'rate');
    throw new AiError(data?.message || data?.error || `The AI Service Returned ${r.status}`, 'http');
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

// ------------------------------------------------------------ notion
//
// A Notion page as plain text, for a bot that takes a page link as its
// source material. The Worker endpoint wants the bare 32-hex id, which is
// the tail of every Notion URL once the dashes are stripped.

const flatten = (blocks) => (blocks || []).map((b) => {
  const line = (b.rich || []).map((r) => r.t).join('').trim();
  const kids = b.children ? flatten(b.children) : '';
  return [line, kids].filter(Boolean).join('\n');
}).filter(Boolean).join('\n');

export async function notionText(url) {
  const m = String(url || '').replace(/-/g, '').match(/([0-9a-f]{32})/i);
  if (!m) throw new AiError('That Does Not Look Like A Notion Page Link', 'badurl');
  let r;
  try {
    r = await fetch(`${API}/notion/page/${m[1].toLowerCase()}`);
  } catch (_) {
    throw new AiError('Could Not Reach The CTH Service To Read That Page', 'net');
  }
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new AiError(data?.message || `Could Not Read That Notion Page (${r.status})`, 'notion');
  return { title: data?.title || '', text: flatten(data?.blocks) };
}

export { AiError };
