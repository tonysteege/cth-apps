// cth-present-api - the small server piece behind CTH Slides, on
// apps-api.coachtonyhockey.com. The Notion API allows no browser calls
// (no CORS), so this Worker fetches a page and its blocks with the
// NOTION_TOKEN secret and returns a simplified JSON the static app renders
// as slides. Content is fetched LIVE (with a 60-second edge cache), which
// is why presentations never need a webhook, a sync, or an update button.
//
// Security model: page ids are unguessable 128-bit UUIDs - the same model
// as Notion's own "anyone with the link". There is deliberately NO search
// or listing endpoint, and CORS only admits the CTH Apps origins.
//
// It ALSO serves CTH Bots (2026-08-27): /ai/text, /ai/vision and /ai/image
// proxy to the model providers so the API keys stay here as Worker secrets
// rather than in a public static site. The Worker holds no state and keeps
// no prompts; CORS admits the same two CTH origins as everything else.
//
// Deploy: cd present-worker && npx wrangler deploy
// Secrets: npx wrangler secret put NOTION_TOKEN
//          npx wrangler secret put ANTHROPIC_API_KEY   (text + vision)
//          npx wrangler secret put OPENAI_API_KEY      (images)

const ALLOWED_ORIGINS = [
  'https://apps.coachtonyhockey.com',
  'http://localhost:8642',
];

const NOTION = 'https://api.notion.com/v1';
const NV = '2022-06-28';
const MAX_BLOCKS = 700;
const MAX_DEPTH = 3;

function cors(req) {
  const o = req.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

const json = (req, data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json;charset=utf-8', ...cors(req), ...extra },
});

// Rich text, compacted: [{ t, href?, b?, i?, s?, c?, code?, color? }]
function rich(arr) {
  return (arr || []).map((r) => {
    const o = { t: r.plain_text || '' };
    if (r.href) o.href = r.href;
    const a = r.annotations || {};
    if (a.bold) o.b = 1;
    if (a.italic) o.i = 1;
    if (a.strikethrough) o.s = 1;
    if (a.underline) o.u = 1;
    if (a.code) o.code = 1;
    if (a.color && a.color !== 'default') o.color = a.color;
    return o;
  });
}

const fileUrl = (f) => (f ? (f.type === 'external' ? f.external?.url : f.file?.url) : null);

// One Notion block -> the compact shape the app renders.
function simplify(b) {
  const t = b.type;
  const d = b[t] || {};
  const o = { type: t };
  if (d.rich_text) o.rich = rich(d.rich_text);
  if (d.caption?.length) o.caption = rich(d.caption);
  if (t === 'image' || t === 'video' || t === 'audio' || t === 'file' || t === 'pdf') o.url = fileUrl(d);
  if (t === 'embed' || t === 'bookmark' || t === 'link_preview') o.url = d.url;
  if (t === 'to_do') o.checked = !!d.checked;
  if (t === 'code') o.language = d.language || '';
  if (t === 'callout') o.icon = d.icon?.emoji || '';
  if (t === 'child_page') o.title = d.title || '';
  if (b.has_children) o.hasChildren = true;
  return o;
}

async function notion(path, env) {
  const r = await fetch(`${NOTION}${path}`, {
    headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': NV },
  });
  if (!r.ok) {
    const body = await r.text();
    const e = new Error(`notion ${r.status}`);
    e.status = r.status;
    e.body = body.slice(0, 300);
    throw e;
  }
  return r.json();
}

async function childBlocks(id, env, state, depth) {
  const out = [];
  let cursor = '';
  do {
    if (state.count >= MAX_BLOCKS) { state.truncated = true; break; }
    const j = await notion(`/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`, env);
    for (const raw of j.results) {
      if (state.count >= MAX_BLOCKS) { state.truncated = true; break; }
      state.count += 1;
      const s = simplify(raw);
      // Containers flatten INLINE so the slide splitter sees one stream:
      // columns and synced blocks disappear, their children stay in order.
      if (['column_list', 'column', 'synced_block'].includes(s.type)) {
        if (raw.has_children) out.push(...await childBlocks(raw.id, env, state, depth));
        continue;
      }
      if (s.hasChildren && depth < MAX_DEPTH
        && ['toggle', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'callout', 'quote', 'heading_1', 'heading_2', 'heading_3'].includes(s.type)) {
        s.children = await childBlocks(raw.id, env, state, depth + 1);
      }
      delete s.hasChildren;
      out.push(s);
    }
    cursor = j.has_more ? j.next_cursor : '';
  } while (cursor);
  return out;
}

function pageTitle(page) {
  for (const p of Object.values(page.properties || {})) {
    if (p.type === 'title') return (p.title || []).map((r) => r.plain_text).join('');
  }
  return 'Untitled';
}

// ---------------------------------------------------------------- CTH Bots
//
// Three endpoints, all POST, all JSON. Prompts are passed straight through
// and nothing is stored. The size caps below are the only guard rails: a
// static site cannot be trusted to bound its own request.

const MAX_PROMPT = 8000;
const MAX_IMAGE_IN = 6_000_000;   // a pasted screenshot, base64
const TEXT_MODEL = 'claude-sonnet-4-5-20250929';
const IMAGE_MODEL = 'gpt-image-1';

const ASPECT_SIZE = {
  '16:9': '1536x1024',
  '1:1': '1024x1024',
  '4:5': '1024x1536',
};

async function anthropic(env, body) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = data?.error?.message || `Anthropic returned ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return (data?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
}

async function handleAi(request, env, path) {
  if (request.method !== 'POST') return json(request, { error: 'method' }, 405);
  let body;
  try { body = await request.json(); } catch (_) { return json(request, { error: 'bad_json' }, 400); }

  if (path === '/ai/text' || path === '/ai/vision') {
    if (!env.ANTHROPIC_API_KEY) return json(request, { error: 'no_key', message: 'ANTHROPIC_API_KEY is not set on this Worker.' }, 401);
    const prompt = String(body.prompt || '').slice(0, MAX_PROMPT);
    if (!prompt) return json(request, { error: 'empty' }, 400);
    const system = String(body.system || '').slice(0, MAX_PROMPT);
    let content = prompt;
    if (path === '/ai/vision') {
      const img = String(body.image || '');
      const m2 = img.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
      if (!m2 || img.length > MAX_IMAGE_IN) return json(request, { error: 'bad_image' }, 400);
      content = [
        { type: 'image', source: { type: 'base64', media_type: m2[1], data: m2[2] } },
        { type: 'text', text: prompt },
      ];
    }
    try {
      const text = await anthropic(env, {
        model: TEXT_MODEL,
        max_tokens: 1500,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content }],
      });
      return json(request, { text });
    } catch (e) {
      return json(request, { error: 'model', message: e.message }, e.status === 429 ? 429 : 502);
    }
  }

  if (path === '/ai/image') {
    if (!env.OPENAI_API_KEY) return json(request, { error: 'no_key', message: 'OPENAI_API_KEY is not set on this Worker.' }, 401);
    const prompt = String(body.prompt || '').slice(0, MAX_PROMPT);
    if (!prompt) return json(request, { error: 'empty' }, 400);
    const n = Math.max(1, Math.min(4, Number(body.n) || 1));
    const size = ASPECT_SIZE[body.aspect] || ASPECT_SIZE['16:9'];
    try {
      const r = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: IMAGE_MODEL, prompt, n, size, quality: 'high' }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) {
        const msg = data?.error?.message || `Image provider returned ${r.status}`;
        return json(request, { error: 'model', message: msg }, r.status === 429 ? 429 : 502);
      }
      const images = (data?.data || []).map((d) => (d.b64_json ? `data:image/png;base64,${d.b64_json}` : d.url)).filter(Boolean);
      return json(request, { images });
    } catch (e) {
      return json(request, { error: 'model', message: e.message }, 502);
    }
  }
  return json(request, { error: 'not_found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(request) });
    const url = new URL(request.url);
    if (url.pathname.startsWith('/ai/')) return handleAi(request, env, url.pathname);
    const m = url.pathname.match(/^\/notion\/page\/([0-9a-f]{32})$/);
    if (!m) return json(request, { error: 'not_found' }, 404);
    if (!env.NOTION_TOKEN) return json(request, { error: 'setup', message: 'NOTION_TOKEN secret is not set on this Worker.' }, 503);

    const fresh = url.searchParams.get('fresh') === '1';
    const cacheKey = new Request(`https://cache.invalid${url.pathname}`);
    if (!fresh) {
      const hit = await caches.default.match(cacheKey);
      if (hit) {
        const res = new Response(hit.body, hit);
        Object.entries(cors(request)).forEach(([k, v]) => res.headers.set(k, v));
        return res;
      }
    }

    const id = m[1];
    try {
      const page = await notion(`/pages/${id}`, env);
      const state = { count: 0, truncated: false };
      const blocks = await childBlocks(id, env, state, 0);
      const body = {
        id,
        title: pageTitle(page),
        icon: page.icon?.emoji || null,
        cover: fileUrl(page.cover) || null,
        truncated: state.truncated,
        fetched: new Date().toISOString(),
        blocks,
      };
      const res = json(request, body, 200, { 'cache-control': 'public, max-age=60' });
      ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
      return res;
    } catch (e) {
      if (e.status === 404) return json(request, { error: 'no_access', message: 'The Notion integration cannot see this page. Share the page (or its database) with the integration.' }, 404);
      return json(request, { error: 'notion', message: e.body || e.message }, 502);
    }
  },
};
