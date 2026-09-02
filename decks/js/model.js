// CTH Decks model. A Figma-Slides-shaped deck editor with the two things
// Figma cannot do: Clips-grade video on a slide and live rink diagrams.
//
// STORAGE IS ADDITIVE-ONLY. Never rename or remove a field; read older
// records with fallbacks.
//
//   deck  { v:1, id, name, created, updated, theme, slides:[slide] }
//   theme { styles: {role:{size,weight,color,line}}, colors:[hex], bg }
//   slide { id, bg, notes, skip?, transition?, els:[el] }
//   trans { style:'none'|'dissolve'|'slide'|'push', durMs }
//   el    { id, type, x, y, w, h } plus per-type fields, plus optional
//         anim { io:'in'|'out', style:'fade'|'slide', dir, durMs, order }
//
// EVERY COORDINATE IS IN SLIDE SPACE - 1600x900 - never screen pixels.
// The stage scales; the geometry does not (the proven Slides rule).

import { uid } from './store.js';

export const SLIDE_W = 1600;
export const SLIDE_H = 900;
export const MARGIN = { x: 80, y: 64 };

// The type ramp is the one MEASURED off Tony's own Figma template for the
// Slides app (2026-08-27) - reused verbatim so Decks and Slides read as one
// product. Do not tidy these to round numbers.
export const DEFAULT_STYLES = {
  title:     { label: 'Title',     size: 110, weight: 800, color: '#0a0a0a', line: 1.04 },
  subtitle:  { label: 'Subtitle',  size: 66,  weight: 600, color: '#737373', line: 1.16 },
  header:    { label: 'Header',    size: 70,  weight: 800, color: '#0a0a0a', line: 1.08 },
  subheader: { label: 'Subheader', size: 36,  weight: 600, color: '#a3a3a3', line: 1.2 },
  body:      { label: 'Body',      size: 36,  weight: 400, color: '#404040', line: 1.45 },
  caption:   { label: 'Caption',   size: 24,  weight: 500, color: '#737373', line: 1.35 },
};

export const DEFAULT_COLORS = ['#0a0a0a', '#404040', '#737373', '#a3a3a3', '#ffffff', '#75d8ff', '#16a34a', '#dc2626'];

export const newTheme = () => ({
  styles: JSON.parse(JSON.stringify(DEFAULT_STYLES)),
  colors: [...DEFAULT_COLORS],
  bg: '#ffffff',
});

export const styleOf = (theme, role) => (theme?.styles?.[role]) || DEFAULT_STYLES[role] || DEFAULT_STYLES.body;

export const TRANSITIONS = ['none', 'dissolve', 'slide', 'push'];
export const ANIM_STYLES = ['fade', 'slide-up', 'slide-down', 'slide-left', 'slide-right'];

export const newText = (role = 'body', over = {}) => ({
  id: uid(), type: 'text', role, x: 120, y: 380, w: 720, h: 120,
  text: DEFAULT_STYLES[role]?.label || 'Text', align: 'left', ...over,
});

export const newShape = (shape = 'rect', over = {}) => ({
  id: uid(), type: 'shape', shape, x: 600, y: 330, w: 400, h: 240,
  fill: '#0a0a0a', alpha: 1, radius: 16, text: '', ...over,
});

// The marks are the canonical files in slides/logos (never redrawn). The
// horizontal lockup is 1000x286 (3.497:1); the icon is square.
export const LOGOS = {
  'horizontal-white': { src: '/slides/logos/cth-horizontal-white.svg', ratio: 3.497 },
  'horizontal-black': { src: '/slides/logos/cth-horizontal-black.svg', ratio: 3.497 },
  'icon-white': { src: '/slides/logos/cth-icon-white.svg', ratio: 1 },
  'icon-black': { src: '/slides/logos/cth-icon-black.svg', ratio: 1 },
};
export const newLogo = (variant, over = {}) => {
  const w = over.w || (variant.startsWith('icon') ? 54 : 300);
  return { id: uid(), type: 'logo', variant, x: MARGIN.x, y: MARGIN.y, w, h: Math.round(w / LOGOS[variant].ratio), ...over };
};

// A slide may carry a BURNED-IN background picture: `bgImage { src, mode }`
// drawn under the elements and never selectable. The rink layouts use the
// Diagrams app's own rink art (3200x1600) - 'half-right' shows the left
// half of the rink as a square on the right of the slide, 'full-right' the
// whole rink on the right.
export const RINK_SRC = '/diagrams/assets/rink.png';

export const newImage = (asset, over = {}) => ({ id: uid(), type: 'image', asset, x: 400, y: 200, w: 800, h: 500, ...over });
export const newVideo = (asset, over = {}) => ({ id: uid(), type: 'video', asset, x: 240, y: 130, w: 1120, h: 630, ...over });
export const newDiagram = (drill, over = {}) => ({ id: uid(), type: 'diagram', drill, x: 320, y: 150, w: 960, h: 480, animate: true, ...over });

const M = MARGIN;
export const LAYOUTS = {
  blank:    { label: 'Blank' },
  title:    { label: 'Title' },
  section:  { label: 'Section' },
  content:  { label: 'Content' },
  media:    { label: 'Text + Media' },
  rinkHalf: { label: 'Rink Half' },
  rinkFull: { label: 'Rink Full' },
};

export function newSlide(layout = 'blank') {
  const s = { id: uid(), bg: '#ffffff', notes: '', els: [] };
  // The layouts are Tony's Figma template at the coordinates MEASURED for
  // the Slides app (2026-08-27): logo top left, title on the lower third,
  // the credit bottom right; content slides stack subheader / header /
  // bullet body from the top margin. A dark slide carries its own text
  // colours - the role defaults are ink and ink on black is invisible.
  if (layout === 'title') {
    s.bg = '#0a0a0a';
    s.els.push(
      newLogo('horizontal-white'),
      newText('title', { x: M.x, y: 385, w: 1200, h: 132, text: 'Title', color: '#ffffff' }),
      newText('subtitle', { x: M.x, y: 517, w: 1200, h: 84, text: 'Subtitle', color: '#a3a3a3' }),
      newText('caption', { x: 1000, y: 792, w: 520, h: 40, text: '\u00a9 Coach Tony Hockey', color: '#a3a3a3', align: 'right' }),
    );
  } else if (layout === 'section') {
    s.bg = '#0a0a0a';
    s.els.push(
      newLogo('horizontal-white'),
      newText('title', { x: M.x, y: 400, w: 1440, h: 140, text: 'Section', color: '#ffffff' }),
    );
  } else if (layout === 'content') {
    s.els.push(
      newText('subheader', { x: M.x, y: M.y, w: 1000, h: 48, text: 'Subheader' }),
      newText('header', { x: M.x, y: 118, w: 1200, h: 100, text: 'Header' }),
      newText('body', { x: M.x, y: 262, w: 1000, h: 460, text: '\u2022 Text' }),
      newLogo('icon-black', { x: 1466, y: 782, w: 54 }),
    );
  } else if (layout === 'media') {
    s.els.push(
      newText('subheader', { x: M.x, y: M.y, w: 660, h: 48, text: 'Subheader' }),
      newText('header', { x: M.x, y: 118, w: 700, h: 100, text: 'Header' }),
      newText('body', { x: M.x, y: 262, w: 660, h: 460, text: '\u2022 Text' }),
      newLogo('icon-black', { x: 1466, y: 782, w: 54 }),
    );
  } else if (layout === 'rinkHalf' || layout === 'rinkFull') {
    s.bgImage = { src: RINK_SRC, mode: layout === 'rinkHalf' ? 'half-right' : 'full-right' };
    s.els.push(
      newText('subheader', { x: M.x, y: M.y, w: 660, h: 48, text: 'Subheader' }),
      newText('header', { x: M.x, y: 118, w: 700, h: 100, text: 'Header' }),
      newText('body', { x: M.x, y: 262, w: 560, h: 460, text: '\u2022 Text' }),
    );
  }
  return s;
}

export const newDeck = (name = 'Untitled Deck') => ({
  v: 1, id: uid(), name, created: Date.now(), updated: Date.now(),
  theme: newTheme(),
  slides: [newSlide('title'), newSlide('content')],
});

export function normalizeDeck(d) {
  if (!d) return d;
  d.theme = d.theme || newTheme();
  d.theme.styles = d.theme.styles || JSON.parse(JSON.stringify(DEFAULT_STYLES));
  d.theme.colors = d.theme.colors || [...DEFAULT_COLORS];
  d.slides = (d.slides || []).map((s) => ({ bg: '#ffffff', notes: '', els: [], ...s }));
  return d;
}

// Present order skips skipped slides but keeps every slide in the file.
export const presentable = (deck) => deck.slides.filter((s) => !s.skip);

// ------------------------------------------------------------- the board
//
// THE BOARD IS THE DOCUMENT (2026-09-01, Tony's call): a whiteboard like a
// Figma file, and a slide deck is one kind of object on it, beside sticky
// notes, text, shapes, pen strokes, connectors, sections and media.
//
//   board { v:2, id, name, created, updated, settings, items:[item] }
//   item  { id, kind, x, y, w, h, locked?, rot? } plus per-kind fields
//     deck      { theme, slides }            (the whole deck model above)
//     sticky    { text, color }
//     text      { text, size, color, align }
//     shape     { shape, fill, alpha, radius, text }
//     pen       { points:[[x,y]...], color, width }  points relative to x,y
//     connector { from, to, color, head }     item ids; no x/y/w/h of its own
//     section   { title, color }
//     image | video { asset }   diagram { drill, animate }
//
// Board coordinates are canvas px at zoom 1. Slides inside a deck keep
// their own 1600x900 slide space. A v1 record (a bare deck) is migrated
// ADDITIVELY: its `theme` and `slides` stay where they were and a deck
// item carrying a copy is added to `items`.

export const DECK_FRAME_W = 960;
export const DECK_FRAME_H = 540;
export const DECK_GAP = 60;
export const DECK_HEAD = 0;

export const STICKY_COLORS = ['#fef08a', '#fdba74', '#f9a8d4', '#bfdbfe', '#bbf7d0', '#e9d5ff', '#e5e7eb', '#ffffff'];

export const DEFAULT_SETTINGS = { grid: 'dots', gridSize: 40, snap: true, bg: '#f5f5f4', stickyColor: '#fef08a', penColor: '#0a0a0a', penWidth: 4 };

export const deckWidth = (deck) => Math.max(1, deck.slides.length) * DECK_FRAME_W + (Math.max(1, deck.slides.length) - 1) * DECK_GAP;
export const deckHeight = () => DECK_FRAME_H + DECK_HEAD;

export const newDeckItem = (deck, over = {}) => ({
  id: uid(), kind: 'deck', x: 120, y: 120, w: deckWidth(deck), h: deckHeight(),
  name: deck.name || 'Untitled Deck', theme: deck.theme, slides: deck.slides, ...over,
});
export const newSticky = (over = {}) => ({ id: uid(), kind: 'sticky', x: 0, y: 0, w: 220, h: 220, text: '', color: DEFAULT_SETTINGS.stickyColor, ...over });
export const newBoardText = (over = {}) => ({ id: uid(), kind: 'text', x: 0, y: 0, w: 320, h: 48, text: 'Text', size: 24, color: '#0a0a0a', align: 'left', ...over });
export const newBoardShape = (shape = 'rect', over = {}) => ({ id: uid(), kind: 'shape', shape, x: 0, y: 0, w: 240, h: 160, fill: '#ffffff', stroke: '#0a0a0a', alpha: 1, radius: 12, text: '', ...over });
export const newPen = (over = {}) => ({ id: uid(), kind: 'pen', x: 0, y: 0, w: 1, h: 1, points: [], color: DEFAULT_SETTINGS.penColor, width: DEFAULT_SETTINGS.penWidth, ...over });
export const newConnector = (from, to, over = {}) => ({ id: uid(), kind: 'connector', from, to, color: '#0a0a0a', head: true, ...over });
export const newSection = (over = {}) => ({ id: uid(), kind: 'section', x: 0, y: 0, w: 1400, h: 900, title: 'Section', color: '#e0f2fe', ...over });
export const newBoardImage = (asset, over = {}) => ({ id: uid(), kind: 'image', asset, x: 0, y: 0, w: 480, h: 300, ...over });
export const newBoardVideo = (asset, over = {}) => ({ id: uid(), kind: 'video', asset, x: 0, y: 0, w: 640, h: 360, ...over });
export const newBoardDiagram = (drill, over = {}) => ({ id: uid(), kind: 'diagram', drill, x: 0, y: 0, w: 640, h: 320, animate: true, ...over });

export const newBoard = (name = 'Untitled Board') => {
  const deck = newDeck(name);
  return {
    v: 2, id: uid(), name, created: Date.now(), updated: Date.now(),
    settings: { ...DEFAULT_SETTINGS },
    items: [newDeckItem(deck, { x: 120, y: 120 })],
  };
};

export function normalizeBoard(b) {
  if (!b) return b;
  b.settings = { ...DEFAULT_SETTINGS, ...(b.settings || {}) };
  if (!b.items) {
    // A v1 deck. Keep its fields; add the deck item beside them.
    const deck = normalizeDeck({ theme: b.theme, slides: b.slides, name: b.name });
    b.items = [newDeckItem(deck, { x: 120, y: 120 })];
  }
  for (const it of b.items) {
    if (it.kind === 'deck') {
      normalizeDeck(it);
      it.w = deckWidth(it); it.h = deckHeight();
    }
  }
  return b;
}

export const boardDecks = (b) => b.items.filter((i) => i.kind === 'deck');
export const isBox = (it) => it.kind !== 'connector';
