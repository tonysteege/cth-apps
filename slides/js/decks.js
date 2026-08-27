// CTH Slides - locally authored decks.
//
// The app has rendered Notion pages as slideshows since it was built. This
// is the other half Tony asked for (2026-08-27): a deck you MAKE, on a
// whiteboard-like canvas, the way Figma Slides works. The two live side by
// side and share everything downstream - the same 16:9 stage, the same
// video player, the same telestration, the same present mode.
//
// STORAGE IS ADDITIVE-ONLY, like every other CTH app: never rename or
// remove a field, and read an older record with a fallback.
//
//   deck    { v, id, name, created, updated, slides: [slide] }
//   slide   { id, bg, notes, els: [el] }
//   el      { id, type, x, y, w, h } plus its own fields
//
// EVERY COORDINATE IS IN SLIDE SPACE - 1600x900, the same numbers
// telestrate.js already uses - never in screen pixels. The stage scales;
// the geometry does not. That one rule is what lets a deck look identical
// in the editor, in a thumbnail, on a projector and in a recording.

import { SLIDE_W, SLIDE_H } from './telestrate.js';

const DB = 'cth-slides';
const VER = 1;
let dbP = null;

function open() {
  if (dbP) return dbP;
  dbP = new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('decks')) d.createObjectStore('decks', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('assets')) d.createObjectStore('assets');
    };
    r.onsuccess = () => {
      const d = r.result;
      // Never cache a dead connection - the rule Diagrams learned the hard
      // way and every CTH store has followed since.
      d.onclose = () => { dbP = null; };
      d.onversionchange = () => { try { d.close(); } catch (_) {} dbP = null; };
      res(d);
    };
    r.onerror = () => { dbP = null; rej(r.error); };
  });
  return dbP;
}

async function tx(store, mode, fn) {
  let d;
  try { d = await open(); } catch (e) { dbP = null; throw e; }
  try {
    return await new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      const rq = fn(s);
      if (rq) rq.onsuccess = () => { out = rq.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  } catch (e) {
    if (/clos/i.test(e?.message || '')) { dbP = null; return tx(store, mode, fn); }
    throw e;
  }
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const listDecks = () => tx('decks', 'readonly', (s) => s.getAll())
  .then((v) => (v || []).sort((a, b) => (b.updated || 0) - (a.updated || 0)));
export const getDeck = (id) => tx('decks', 'readonly', (s) => s.get(id)).then((v) => (v === undefined ? undefined : v));
export const putDeck = (d) => tx('decks', 'readwrite', (s) => s.put(d)).then(() => d);
export const deleteDeck = (id) => tx('decks', 'readwrite', (s) => s.delete(id));

// Images and video live in their own store keyed by an id the element
// carries, so a deck record stays small enough to read and write at
// keystroke speed. A slide holding four photographs would otherwise be
// rewritten in full on every nudge.
export const putAsset = (id, blob) => tx('assets', 'readwrite', (s) => s.put(blob, id));
export const getAsset = (id) => tx('assets', 'readonly', (s) => s.get(id)).then((v) => (v === undefined ? undefined : v));
export const deleteAsset = (id) => tx('assets', 'readwrite', (s) => s.delete(id));

// ------------------------------------------------------------- the model

export { SLIDE_W, SLIDE_H };

// The type ramp, in slide units. These are the sizes the Notion-rendered
// decks already use, so an authored slide and a rendered one sit in the
// same deck without looking like two products.
// MEASURED OFF TONY'S OWN FIGMA TEMPLATE (2026-08-27), frame by frame out
// of a screen recording of it. The method: a slide's width on screen IS
// 1920 units, so one image pixel converts, and a glyph's cap height over
// Inter's 0.727 cap ratio gives the font size. Every number below came out
// that way and was then rounded - which is why they are not the round
// numbers a guess produces. The earlier ramp WAS a guess and every step of
// it ran small, the subtitle worst: 44 against a measured 66.
export const TEXT_ROLES = {
  title:     { label: 'Title',     size: 110, weight: 800, color: '#0a0a0a', line: 1.04 },
  subtitle:  { label: 'Subtitle',  size: 66,  weight: 600, color: '#737373', line: 1.16 },
  header:    { label: 'Header',    size: 70,  weight: 800, color: '#0a0a0a', line: 1.08 },
  subheader: { label: 'Subheader', size: 36,  weight: 600, color: '#a3a3a3', line: 1.2 },
  body:      { label: 'Body',      size: 36,  weight: 400, color: '#404040', line: 1.45 },
  bullets:   { label: 'Bullets',   size: 36,  weight: 400, color: '#404040', line: 1.55 },
  caption:   { label: 'Caption',   size: 24,  weight: 500, color: '#737373', line: 1.35 },
};

// The template's margins, measured the same way: about 76 across and 57
// down in 1600x900, rounded to numbers that stay easy to type into.
export const MARGIN = { x: 80, y: 64 };

// The marks come from cth/logos - the canonical files, copied in rather
// than redrawn. The horizontal lockup is 1000x286 (3.5:1); the icon square.
export const LOGOS = {
  'horizontal-white': { src: 'logos/cth-horizontal-white.svg', ratio: 3.497 },
  'horizontal-black': { src: 'logos/cth-horizontal-black.svg', ratio: 3.497 },
  'icon-white': { src: 'logos/cth-icon-white.svg', ratio: 1 },
  'icon-black': { src: 'logos/cth-icon-black.svg', ratio: 1 },
};

export const newLogo = (variant, over = {}) => {
  const w = over.w || (variant.startsWith('icon') ? 54 : 300);
  return { id: uid(), type: 'logo', variant, x: MARGIN.x, y: MARGIN.y, w, h: Math.round(w / LOGOS[variant].ratio), ...over };
};

export const newText = (role = 'body', over = {}) => ({
  id: uid(), type: 'text', role,
  x: 120, y: 380, w: 700, h: 120,
  text: TEXT_ROLES[role].label, align: 'left',
  ...over,
});

// The layouts are the template's own, at the measured coordinates: the
// cover's logo top left with its title on the lower third, the content
// slide's subheader / header / body stacked from the top margin, and the
// small mark bottom right that every content slide carries.
const M = MARGIN;
export const newSlide = (layout = 'blank') => {
  const s = { id: uid(), bg: '#ffffff', notes: '', els: [] };
  if (layout === 'title') {
    // A dark slide carries its own text colour. The role defaults are ink,
    // which is right on the white layouts and invisible here - the first
    // thing a new deck showed was a black title on a black cover.
    s.bg = '#0a0a0a';
    s.els = [
      newLogo('horizontal-white'),
      newText('title', { x: M.x, y: 385, w: 1200, h: 132, text: 'Title', color: '#ffffff' }),
      newText('subtitle', { x: M.x, y: 517, w: 1200, h: 84, text: 'Subtitle', color: '#a3a3a3' }),
      newText('caption', { x: 1000, y: 792, w: 520, h: 40, text: '\u00a9 Coach Tony Hockey', color: '#a3a3a3', align: 'right' }),
    ];
  } else if (layout === 'section') {
    s.bg = '#0a0a0a';
    s.els = [
      newLogo('horizontal-white'),
      newText('title', { x: M.x, y: 400, w: 1440, h: 140, text: 'Section', color: '#ffffff' }),
    ];
  } else if (layout === 'header') {
    s.els = [
      newText('subheader', { x: M.x, y: M.y, w: 1000, h: 48, text: 'Subheader' }),
      newText('header', { x: M.x, y: 118, w: 1200, h: 100, text: 'Header' }),
      newText('bullets', { x: M.x, y: 262, w: 1000, h: 460, text: 'First point\nSecond point' }),
      newLogo('icon-black', { x: 1466, y: 782, w: 54 }),
    ];
  } else if (layout === 'split') {
    s.els = [
      newText('subheader', { x: M.x, y: M.y, w: 660, h: 48, text: 'Subheader' }),
      newText('header', { x: M.x, y: 118, w: 700, h: 100, text: 'Header' }),
      newText('bullets', { x: M.x, y: 262, w: 660, h: 460, text: 'First point\nSecond point' }),
      newLogo('icon-black', { x: 1466, y: 782, w: 54 }),
    ];
  }
  return s;
};

export const newDeck = (name = 'Untitled Deck') => ({
  v: 1,
  id: uid(),
  name,
  created: Date.now(),
  updated: Date.now(),
  slides: [newSlide('title'), newSlide('header')],
});

// A slide's title, for a rail label or a deck card - the first text there
// is, in reading order.
export function slideLabel(s, i) {
  const t = (s.els || []).find((e) => e.type === 'text' && String(e.text || '').trim());
  return t ? String(t.text).split('\n')[0].slice(0, 40) : `Slide ${i + 1}`;
}

// Bring an older record forward without ever dropping what it holds.
export function normalizeDeck(d) {
  if (!d) return d;
  return {
    v: 1,
    ...d,
    slides: (d.slides || []).map((s) => ({
      bg: '#ffffff', notes: '', els: [], ...s,
      els: (s.els || []).map((e) => ({ x: 0, y: 0, w: 400, h: 200, ...e })),
    })),
  };
}
