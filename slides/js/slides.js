// Slide grammar and block rendering. The deck is cut from a Notion page's
// block stream exactly like the old Film Room presenter cut markdown:
//   - the page itself is a dark TITLE slide (logo, title, subtitle)
//   - every heading_2 starts a new slide, led by that header
//   - every divider starts a new slide too, carrying the current header
//   - a heading_1 makes a big SECTION slide
// Everything else renders inside the current slide, media splitting the
// slide into text + media columns when a slide has exactly one media block.
//
// Two additions on 2026-08-26, both driven by the CTH slide template:
//   - a LEAD PARAGRAPH (a paragraph sitting before any heading) becomes the
//     cover's subtitle instead of opening the first content slide, which is
//     what gives the cover its Title / Subtitle pair.
//   - every content slide carries the name of the SECTION it sits under
//     (the last heading_1), drawn as the small eyebrow above its header.
//     Nothing new has to be written on the page for this - it is the
//     heading_1 that was already there.

import { esc } from './ui.js';

// ------------------------------------------------------------- splitting

export function buildSlides(page) {
  const blocks = (page.blocks || []).slice();
  // The lead paragraph, if the page opens with one, is the cover subtitle.
  // Only a real paragraph with text qualifies, and only before any heading.
  let subtitle = '';
  const lead = blocks[0];
  if (lead && lead.type === 'paragraph' && plain(lead.rich).trim()) {
    subtitle = plain(lead.rich).trim();
    blocks.shift();
  }
  const title = { kind: 'title', title: page.title, icon: page.icon, cover: page.cover, subtitle };
  const slides = [title];
  let curHeader = null;
  let section = '';
  let cur = { kind: 'content', header: null, section, blocks: [] };
  const flush = () => {
    if (cur.header || cur.blocks.length) slides.push(cur);
    cur = { kind: 'content', header: curHeader, section, blocks: [] };
  };
  for (const b of blocks) {
    if (b.type === 'heading_1') {
      flush();
      section = plain(b.rich).trim();
      slides.push({ kind: 'section', header: b, section });
      curHeader = null;
      cur = { kind: 'content', header: null, section, blocks: [] };
    } else if (b.type === 'heading_2') {
      flush();
      curHeader = b;
      cur = { kind: 'content', header: b, section, blocks: [] };
    } else if (b.type === 'divider') {
      flush();
    } else {
      cur.blocks.push(b);
    }
  }
  flush();
  return slides;
}

// ------------------------------------------------------------- rich text

const COLOR_MAP = {
  red: '#dc2626', orange: '#f97316', yellow: '#b45309', green: '#16a34a',
  blue: '#2563eb', purple: '#7c3aed', pink: '#db2777', brown: '#78350f', gray: '#6b7280',
};

export function richHtml(rich) {
  return (rich || []).map((r) => {
    let h = esc(r.t);
    if (r.code) h = `<code>${h}</code>`;
    if (r.b) h = `<strong>${h}</strong>`;
    if (r.i) h = `<em>${h}</em>`;
    if (r.s) h = `<s>${h}</s>`;
    if (r.u) h = `<u>${h}</u>`;
    if (r.color) {
      const base = r.color.replace('_background', '');
      h = r.color.endsWith('_background')
        ? `<mark style="background:${COLOR_MAP[base] || '#eee'}22">${h}</mark>`
        : `<span style="color:${COLOR_MAP[base] || 'inherit'}">${h}</span>`;
    }
    if (r.href) h = `<a href="${esc(r.href)}" target="_blank" rel="noopener">${h}</a>`;
    return h;
  }).join('');
}

export const plain = (rich) => (rich || []).map((r) => r.t).join('');

// ------------------------------------------------------------- media sniff

const VIDEO_EXT = /\.(mp4|mov|m4v|webm)(\?|$)/i;

// Anything that should render as OUR scrubbable player: notion video files,
// external video links, Dropbox links, and CTH Clips embed URLs (which carry
// in/out so only that clip plays).
export function sniffVideo(b) {
  if (!b.url) return null;
  if (b.url.includes('/clips/embed.html#')) {
    const q = new URLSearchParams(b.url.split('#')[1] || '');
    return { url: q.get('v') || '', in: parseFloat(q.get('in')) || 0, out: parseFloat(q.get('out')) || 0, title: q.get('t') || '' };
  }
  let u = b.url;
  if (/dropbox\.com\/(s|scl)/.test(u)) {
    try {
      const p = new URL(u);
      p.hostname = 'dl.dropboxusercontent.com';
      p.searchParams.delete('dl');
      u = p.toString();
    } catch (_) { /* keep as-is */ }
  }
  if (b.type === 'video' || VIDEO_EXT.test(u)) return { url: u, in: 0, out: 0, title: plain(b.caption) };
  return null;
}

export const isMediaBlock = (b) => b.type === 'image' || !!sniffVideo(b);

// ------------------------------------------------------------- block html

// Render a block LIST, merging consecutive bullet/numbered items into one
// <ul>/<ol> so numbering runs 1, 2, 3 instead of restarting at every item.
export function renderBlocks(blocks, mediaSlots) {
  const out = [];
  let run = null; // { tag, items: [] }
  const flushRun = () => {
    if (run) out.push(`<${run.tag}>${run.items.join('')}</${run.tag}>`);
    run = null;
  };
  for (const b of blocks || []) {
    const tag = b.type === 'bulleted_list_item' ? 'ul' : b.type === 'numbered_list_item' ? 'ol' : null;
    if (tag) {
      if (!run || run.tag !== tag) { flushRun(); run = { tag, items: [] }; }
      run.items.push(`<li>${richHtml(b.rich)}${renderBlocks(b.children, mediaSlots)}</li>`);
    } else {
      flushRun();
      out.push(blockHtml(b, mediaSlots));
    }
  }
  flushRun();
  return out.join('');
}

// Returns html; videos render as placeholders (`<div data-video-slot>`), the
// deck mounts real players into them after insert (media.js).
export function blockHtml(b, mediaSlots) {
  const kids = renderBlocks(b.children || [], mediaSlots);
  switch (b.type) {
    case 'paragraph':
      return (b.rich?.length ? `<p>${richHtml(b.rich)}</p>` : '') + kids;
    case 'heading_3':
      return `<h3>${richHtml(b.rich)}</h3>${kids}`;
    case 'bulleted_list_item':
      return `<ul><li>${richHtml(b.rich)}${kids}</li></ul>`; // lone item; runs merge in renderBlocks
    case 'numbered_list_item':
      return `<ol><li>${richHtml(b.rich)}${kids}</li></ol>`;
    case 'to_do':
      return `<div class="sl-todo${b.checked ? ' done' : ''}"><span class="sl-check">${b.checked ? '&#10003;' : ''}</span><span>${richHtml(b.rich)}</span></div>${kids}`;
    case 'toggle':
      return `<div class="sl-toggle"><div class="sl-toggle-head">${richHtml(b.rich)}</div>${kids}</div>`;
    case 'quote':
      return `<blockquote>${richHtml(b.rich)}${kids}</blockquote>`;
    case 'callout':
      return `<div class="sl-callout">${b.icon ? `<span class="sl-callout-ic">${esc(b.icon)}</span>` : ''}<div>${richHtml(b.rich)}${kids}</div></div>`;
    case 'code':
      return `<pre class="sl-code"><code>${richHtml(b.rich)}</code></pre>`;
    case 'image': {
      const cap = b.caption?.length ? `<figcaption>${richHtml(b.caption)}</figcaption>` : '';
      return `<figure class="sl-img"><img src="${esc(b.url || '')}" alt="">${cap}</figure>`;
    }
    case 'video':
    case 'embed': {
      const v = sniffVideo(b);
      if (v) {
        const slot = mediaSlots.push(v) - 1;
        return `<div class="pv-slot" data-video-slot="${slot}"></div>`;
      }
      if (b.type === 'embed' && b.url) {
        return `<div class="sl-embed"><iframe src="${esc(b.url)}" loading="lazy" allowfullscreen></iframe></div>`;
      }
      return '';
    }
    case 'bookmark':
    case 'link_preview':
      return b.url ? `<p><a class="sl-bookmark" href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.url)}</a></p>` : '';
    case 'child_page':
      return `<p class="sl-subpage">${esc(b.title || 'Sub-Page')}</p>`;
    case 'audio':
      return b.url ? `<audio controls src="${esc(b.url)}"></audio>` : '';
    case 'file':
    case 'pdf':
      return b.url ? `<p><a class="sl-bookmark" href="${esc(b.url)}" target="_blank" rel="noopener">${richHtml(b.caption) || 'Attached File'}</a></p>` : '';
    default:
      return kids; // unknown types keep their children, lose their chrome
  }
}
