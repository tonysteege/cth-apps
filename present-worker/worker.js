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
// Secret: npx wrangler secret put NOTION_TOKEN   (Slides only - the bots
//         need no key at all, see the Workers AI note below)

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
// The bots run on WORKERS AI (2026-08-27, Tony's call, replacing the
// Anthropic/OpenAI proxy that was here for a few hours). That choice is the
// whole architecture:
//
//   - NO API KEY EXISTS. Workers AI is billed to the Cloudflare account
//     this Worker already runs on, through the `AI` binding. There is no
//     secret to set, nothing to leak, and no second vendor.
//   - IT RUNS AT THE EDGE, so the bots work with Tony's laptop shut. A
//     provider reached from the browser, or anything on the Mac (an MCP
//     server, a local agent), cannot do that.
//   - SPEED IS THE TIE-BREAK. The image models are the distilled FLUX.2
//     [klein] pair - a fixed four-step inference built for latency - and
//     the text model is the fp8 "fast" build. `quality: true` on a request
//     moves up one rung; nothing here ever picks a slow model by default.
//
// Free allowance is 10,000 Neurons a day, then $0.011 per 1,000.

const MAX_PROMPT = 8000;
const MAX_IMAGE_IN = 6_000_000;

const MODELS = {
  text: { fast: '@cf/meta/llama-3.1-8b-instruct-fast', good: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
  vision: { fast: '@cf/meta/llama-4-scout-17b-16e-instruct', good: '@cf/meta/llama-4-scout-17b-16e-instruct' },
  image: { fast: '@cf/black-forest-labs/flux-2-klein-4b', good: '@cf/black-forest-labs/flux-2-klein-9b' },
};

// FLUX wants multiples of 32. These are the three shapes the bots offer.
const ASPECT_WH = {
  '16:9': [1024, 576],
  '1:1': [1024, 1024],
  '4:5': [896, 1120],
};

// Workers AI does not answer with one shape, and two of them bit on the
// first live calls (2026-08-27):
//   - reading `.response` and calling .trim() threw, because it is not
//     always a string;
//   - when the model answers with valid JSON, Workers AI PARSES IT FOR
//     YOU, so `response` came back as an array of cue objects and a
//     content-block join flattened it to "".
// So: a parsed payload is handed back as JSON text for the app's own
// parser to read, real content blocks are joined, and an empty candidate
// falls through to the OpenAI-style `choices`. This can never throw.
function pickText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) {
    const isBlocks = v.every((c) => typeof c === 'string'
      || (c && (typeof c.text === 'string' || typeof c.content === 'string')));
    if (isBlocks) return v.map((c) => (typeof c === 'string' ? c : c.text ?? c.content ?? '')).join('').trim();
    try { return JSON.stringify(v); } catch (_) { return ''; }
  }
  if (typeof v === 'object') {
    const inner = v.text ?? v.content ?? v.response;
    if (typeof inner === 'string') return inner.trim();
    try { return JSON.stringify(v); } catch (_) { return ''; }
  }
  return String(v);
}

function textOut(r) {
  if (typeof r === 'string') return r.trim();
  return pickText(r?.response)
    || pickText(r?.choices?.[0]?.message?.content)
    || pickText(r?.result?.response)
    || pickText(r?.output_text)
    || '';
}

const b64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

// FLUX returns JPEG bytes, not PNG - labelling them image/png produced
// files saved as .png that were actually JPEGs (caught live 2026-08-27).
// Sniff the magic number instead of assuming.
const sniffMime = (buf) => {
  const b = new Uint8Array(buf);
  if (b[0] === 0xFF && b[1] === 0xD8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49) return 'image/webp';
  return 'image/png';
};
const asDataUrl = (buf) => `data:${sniffMime(buf)};base64,${b64(buf)}`;
// The same sniff for a model that hands back base64 directly: FLUX does,
// which is the branch that was still mislabelling JPEGs as PNG.
const sniffB64 = (b) => (b.startsWith('/9j/') ? 'image/jpeg'
  : b.startsWith('iVBOR') ? 'image/png'
  : b.startsWith('UklGR') ? 'image/webp' : 'image/png');

// FLUX.2 takes multipart form data even for a bare prompt, and answers with
// the image bytes as a stream. FormData will not hand over its own boundary,
// so it is serialized through a Response first - that is the documented way.
async function fluxImage(env, model, prompt, aspect) {
  const [w, h] = ASPECT_WH[aspect] || ASPECT_WH['16:9'];
  const form = new FormData();
  form.append('prompt', prompt);
  form.append('width', String(w));
  form.append('height', String(h));
  const fr = new Response(form);
  const out = await env.AI.run(model, {
    multipart: { body: fr.body, contentType: fr.headers.get('content-type') },
  });
  // Depending on the model the binding gives back a stream, a plain
  // ArrayBuffer, or an object carrying base64 - accept all three.
  if (out && typeof out.getReader === 'function') return asDataUrl(await new Response(out).arrayBuffer());
  if (out instanceof ArrayBuffer) return asDataUrl(out);
  if (out && typeof out.image === 'string') return `data:${sniffB64(out.image)};base64,${out.image}`;
  if (out && out.body) return asDataUrl(await new Response(out.body).arrayBuffer());
  throw new Error('The image model returned nothing usable');
}

async function handleAi(request, env, path) {
  if (request.method !== 'POST') return json(request, { error: 'method', message: 'That endpoint only takes a POST.' }, 405);
  if (!env.AI) return json(request, { error: 'no_binding', message: 'Workers AI is not bound to this Worker. Redeploy it.' }, 503);
  let body;
  try { body = await request.json(); } catch (_) { return json(request, { error: 'bad_json', message: 'The request body was not readable JSON.' }, 400); }
  const tier = body.quality ? 'good' : 'fast';
  const prompt = String(body.prompt || '').slice(0, MAX_PROMPT);
  if (!prompt) return json(request, { error: 'empty', message: 'Nothing was sent to work from - fill in the brief and run it again.' }, 400);

  try {
    if (path === '/ai/text') {
      const system = String(body.system || '').slice(0, MAX_PROMPT);
      const r = await env.AI.run(MODELS.text[tier], {
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
        max_tokens: 1200,
      });
      if (body.debug) return json(request, { raw: r, keys: r && typeof r === 'object' ? Object.keys(r) : typeof r });
      return json(request, { text: textOut(r) });
    }

    if (path === '/ai/vision') {
      const img = String(body.image || '');
      const m2 = img.match(/^data:image\/[a-z+]+;base64,(.+)$/i);
      // Every 400 here carries a `message`. Without one the app fell back
      // to the machine code and toasted a literal "bad_image" at Tony
      // (measured live 2026-08-27) - a dead end no reader can act on.
      if (!m2) return json(request, { error: 'bad_image', message: 'That file was not readable as an image. Try a PNG or a JPEG.' }, 400);
      if (img.length > MAX_IMAGE_IN) return json(request, { error: 'bad_image', message: 'That image is too large. Use a smaller screenshot.' }, 400);
      const r = await env.AI.run(MODELS.vision[tier], {
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: img } },
          ],
        }],
        max_tokens: 700,
      });
      return json(request, { text: textOut(r) });
    }

    if (path === '/ai/image') {
      const n = Math.max(1, Math.min(4, Number(body.n) || 1));
      const model = MODELS.image[tier];
      // Run the options concurrently: four four-step generations in
      // parallel is the difference between a wait and a pause.
      const settled = await Promise.allSettled(
        Array.from({ length: n }, () => fluxImage(env, model, prompt, body.aspect)),
      );
      const images = settled.filter((x) => x.status === 'fulfilled').map((x) => x.value);
      if (!images.length) {
        const why = String(settled.find((x) => x.status === 'rejected')?.reason?.message || 'Image generation failed');
        // Workers AI runs a safety filter and answers 3030 when it trips.
        // It is prompt-dependent and often catches innocuous wording, so
        // say what to do rather than showing the raw code.
        if (/3030|flagged/i.test(why)) {
          return json(request, { error: 'flagged', message: 'The image service blocked that wording. Reword the brief and try again.' }, 422);
        }
        return json(request, { error: 'model', message: why }, 502);
      }
      return json(request, { images });
    }
  } catch (e) {
    const msg = String(e?.message || e);
    const rate = /rate|429|capacity|limit/i.test(msg);
    return json(request, { error: 'model', message: msg }, rate ? 429 : 502);
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
