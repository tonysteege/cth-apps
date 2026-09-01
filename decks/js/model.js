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

export const newImage = (asset, over = {}) => ({ id: uid(), type: 'image', asset, x: 400, y: 200, w: 800, h: 500, ...over });
export const newVideo = (asset, over = {}) => ({ id: uid(), type: 'video', asset, x: 240, y: 130, w: 1120, h: 630, ...over });
export const newDiagram = (drill, over = {}) => ({ id: uid(), type: 'diagram', drill, x: 320, y: 150, w: 960, h: 480, animate: true, ...over });

const M = MARGIN;
export const LAYOUTS = {
  blank:   { label: 'Blank' },
  title:   { label: 'Title' },
  section: { label: 'Section' },
  content: { label: 'Content' },
  media:   { label: 'Text + Media' },
  rink:    { label: 'Rink' },
};

export function newSlide(layout = 'blank') {
  const s = { id: uid(), bg: '#ffffff', notes: '', els: [] };
  if (layout === 'title') {
    // A dark cover carries its own text colours - the role defaults are ink
    // and ink on black is the first bug every new deck used to show.
    s.bg = '#0a0a0a';
    s.els.push(
      newText('title', { x: M.x, y: 520, w: SLIDE_W - M.x * 2, h: 130, text: 'Deck Title', color: '#ffffff' }),
      newText('subtitle', { x: M.x, y: 668, w: SLIDE_W - M.x * 2, h: 90, text: 'Subtitle', color: '#a3a3a3' }),
    );
  } else if (layout === 'section') {
    s.bg = '#0a0a0a';
    s.els.push(newText('header', { x: M.x, y: 390, w: SLIDE_W - M.x * 2, h: 110, text: 'Section', color: '#ffffff' }));
  } else if (layout === 'content') {
    s.els.push(
      newText('subheader', { x: M.x, y: M.y, w: SLIDE_W - M.x * 2, h: 48, text: 'Section' }),
      newText('header', { x: M.x, y: M.y + 56, w: SLIDE_W - M.x * 2, h: 92, text: 'Header' }),
      newText('body', { x: M.x, y: M.y + 190, w: SLIDE_W - M.x * 2, h: 480, text: 'Body' }),
    );
  } else if (layout === 'media') {
    s.els.push(
      newText('header', { x: M.x, y: M.y, w: SLIDE_W - M.x * 2, h: 92, text: 'Header' }),
      newText('body', { x: M.x, y: M.y + 140, w: 560, h: 520, text: 'Body' }),
    );
  } else if (layout === 'rink') {
    s.els.push(
      newText('header', { x: M.x, y: M.y, w: SLIDE_W - M.x * 2, h: 92, text: 'Drill' }),
      // The diagram itself is placed from the picker - a rink layout without
      // a chosen drill holds the space it will take.
      newShape('rect', { x: M.x, y: M.y + 140, w: SLIDE_W - M.x * 2, h: 560, fill: '#f5f5f5', radius: 12, text: 'Add a diagram' }),
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
