// CTH Bots - THE REGISTRY.
//
// A bot is one object in the BOTS array below. Adding a bot is adding an
// object: no wiring, no new file, no build. The board, the runner, the
// settings sheet and the output history all read from this shape.
//
//   id        stable key - also the IndexedDB key for its config. Never
//             rename one: a rename orphans that bot's saved settings.
//   name      card title. `blurb` is kept as the bot's one-line
//             description but is NOT drawn on the card (2026-08-27):
//             vertical space on the board is worth more. It still serves
//             the settings sheet and any future listing.
//   icon      inline SVG (line icons, currentColor, 24-box).
//   color     default accent hex; Tony recolors per bot on the card.
//   kind      'text' or 'image' - decides which endpoint runs and how the
//             results render.
//   inputs    the fields on the run sheet: {key,label,type,placeholder}
//             where type is 'textarea' | 'text' | 'url'. A field may also
//             carry `reads: 'notion'`: the runner then fetches that page
//             before the run and hands the prompt `<key>Text`. A field
//             with no `reads` and no use in prompt() is a dead control -
//             `source` was exactly that until 2026-08-27.
//   settings  the per-bot settings schema: {key,label,type,...} where type
//             is 'number' | 'select' | 'text' | 'textarea' | 'styles' |
//             'folder'. Values live in the bot's saved config.
//   system    the default instruction sent to the model. Tony edits this
//             per bot in settings (config.system overrides it), which is
//             what "control their instructions" means.
//   prompt(v, cfg)  builds the user message from the inputs and config.
//
// Image bots additionally use `styles` (a settings list Tony can extend,
// including from a screenshot) and `aspect`.

export const ICONS = {
  bot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.9"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2m16 0h2m-7-1v2m-6-2v2"/></svg>',
  botMessage: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.9"><path d="M12 6V2H8m7 9v2M2 12h2m16 0h2m-2 4a2 2 0 0 1-2 2H8.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 4 20.286V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2zM9 11v2"/></svg>',
  megaphone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.9"><path d="m3 11 15-6v14L3 13z"/><path d="M3 11H2.6A1.6 1.6 0 0 0 1 12.6v.8A1.6 1.6 0 0 0 2.6 15H3z"/><path d="M7 14.5V19a1.5 1.5 0 0 0 3 0v-3.5"/><path d="M21 9.5a2.5 2.5 0 0 1 0 5"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.9"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m4 17 4.5-4.5a2 2 0 0 1 2.8 0L16 17"/><path d="m14 14 1.6-1.6a2 2 0 0 1 2.8 0L20 14"/></svg>',
  thumb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.9"><rect x="2.5" y="5" width="19" height="12" rx="2.5"/><path d="m10 9.2 4.5 2.8L10 14.8z"/><path d="M7 21h10"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.9"><path d="M12 3.5 13.8 9l5.5 1.8-5.5 1.8L12 18l-1.8-5.4L4.7 10.8 10.2 9z"/><path d="M18.5 3v3M20 4.5h-3"/></svg>',
};

// The style list every image bot starts with. Tony edits, adds and removes
// these in settings - including "Add From Image", which sends a screenshot
// to the text model and saves the style description it reads back.
const VISUAL_STYLES = [
  { id: 'diagram', name: 'Clean Diagram', prompt: 'a clean instructional diagram, flat vector, generous white space, one clear focal idea, thin confident lines, muted palette with a single accent, no clutter' },
  { id: 'sketch', name: 'Hand Sketchnote', prompt: 'a hand-drawn sketchnote on white, marker linework, hand-lettered labels, simple arrows and containers, warm and human, not polished vector' },
  { id: 'compare', name: 'Comparison', prompt: 'a side-by-side comparison graphic, two clearly separated halves, a heading over each, matched visual weight, obvious contrast between the two' },
  { id: 'photo', name: 'Photo Real', prompt: 'a photorealistic image, natural light, shallow depth of field, authentic and un-staged' },
];

const THUMB_STYLES = [
  { id: 'bold', name: 'Bold Text', prompt: 'a bold thumbnail with three or four huge words of text, heavy condensed type, hard contrast, one dominant subject, colour blocking' },
  { id: 'face', name: 'Reaction', prompt: 'a thumbnail centred on one expressive face, strong rim light, blurred action background, a short punchy caption to one side' },
  { id: 'split', name: 'Split Screen', prompt: 'a split-screen thumbnail, a hard vertical divide, before on the left and after on the right, a small label on each side' },
  { id: 'clean', name: 'Clean Minimal', prompt: 'a restrained thumbnail, one subject on a plain graduated background, a few words of type, lots of breathing room, premium feel' },
];

export const BOTS = [
  {
    id: 'cue',
    name: 'Coaching Cue Bot',
    blurb: 'Turns a skill or coaching point into short, memorable cues you can shout during a drill.',
    icon: ICONS.megaphone,
    color: '#16a34a',
    kind: 'text',
    inputs: [
      { key: 'notes', label: 'Skill, Coaching Point Or Rough Notes', type: 'textarea', placeholder: 'e.g. players are standing too tall on their crossovers through the neutral zone and losing speed' },
    ],
    settings: [
      { key: 'count', label: 'Cues Per Run', type: 'number', min: 3, max: 12, def: 5 },
      { key: 'age', label: 'Age Group', type: 'select', options: ['Mixed', '8U', '10U', '12U', '14U', '16U', 'Junior / Adult'], def: 'Mixed' },
      { key: 'flavour', label: 'Flavour', type: 'select', options: ['Punchy', 'Technical', 'Playful', 'Old School'], def: 'Punchy' },
    ],
    system: [
      'You write verbal coaching cues for an ice hockey coach to shout across a rink mid-drill.',
      'A cue must be 2 to 5 words, instantly understandable at speed, and physically actionable.',
      'Favour concrete imagery a player can feel over abstract instruction. Never explain the cue.',
      'Vary the angle across your options: one about the body, one about the puck, one image-based,',
      'one about timing or rhythm, one that is simply memorable. No numbering, no punctuation at the end.',
    ].join(' '),
    prompt: (v, c) => [
      `Coaching point: ${v.notes}`,
      `Age group: ${c.age}. Flavour: ${c.flavour}.`,
      `Give exactly ${c.count} cue options.`,
      'Return ONLY a JSON array of objects: [{"cue":"...","why":"one short line on when to use it"}]',
    ].join('\n'),
  },

  {
    id: 'visual',
    name: 'Visual Aid Bot',
    blurb: 'Generates teaching visuals from a prompt or a Notion page, several options each time.',
    icon: ICONS.image,
    color: '#2b7fff',
    kind: 'image',
    inputs: [
      { key: 'brief', label: 'What The Visual Should Show', type: 'textarea', placeholder: 'e.g. the three lanes of a breakout, with the strong-side winger on the wall' },
      { key: 'source', label: 'Notion Page Link (Optional)', type: 'url', placeholder: 'https://www.notion.so/...', reads: 'notion' },
    ],
    settings: [
      { key: 'count', label: 'Options Per Run', type: 'number', min: 1, max: 4, def: 3 },
      { key: 'aspect', label: 'Shape', type: 'select', options: ['Landscape 16:9', 'Square 1:1', 'Portrait 4:5'], def: 'Landscape 16:9' },
      { key: 'folder', label: 'Save Into', type: 'folder', def: '/visuals' },
      { key: 'styles', label: 'Styles', type: 'styles', def: VISUAL_STYLES },
    ],
    system: 'You write image-generation prompts for a hockey coach\'s teaching visuals. The result must teach at a glance on a phone or a projector: one idea, clear hierarchy, readable labels, nothing decorative that does not carry meaning.',
    prompt: (v, c, style) => [
      `Subject: ${v.brief}`,
      // `sourceText` is filled in by the runner when a page link is given:
      // `reads: 'notion'` above is what makes that field do something.
      v.sourceText ? `Source material from the coach's own page - use it for the content, not the wording:\n${String(v.sourceText).slice(0, 1500)}` : '',
      style ? `Style: ${style.prompt}` : 'Style: choose the single most effective style for this subject.',
      `Aspect: ${c.aspect}.`,
      'Ice hockey context. No watermarks, no gibberish text, no stock-photo cliches.',
    ].filter(Boolean).join('\n'),
  },

  {
    id: 'thumb',
    name: 'Thumbnail Bot',
    blurb: 'Makes thumbnail options for videos, courses and posts, in the style you pick.',
    icon: ICONS.thumb,
    color: '#f97316',
    kind: 'image',
    inputs: [
      { key: 'brief', label: 'What Is It For', type: 'textarea', placeholder: 'e.g. a lesson on reading the first forechecker, for the online academy' },
      { key: 'words', label: 'Text On The Thumbnail (Optional)', type: 'text', placeholder: 'e.g. BEAT THE F1' },
    ],
    settings: [
      { key: 'count', label: 'Options Per Run', type: 'number', min: 1, max: 4, def: 3 },
      { key: 'aspect', label: 'Shape', type: 'select', options: ['Landscape 16:9', 'Square 1:1', 'Portrait 4:5'], def: 'Landscape 16:9' },
      { key: 'folder', label: 'Save Into', type: 'folder', def: '/thumbnails' },
      { key: 'styles', label: 'Styles', type: 'styles', def: THUMB_STYLES },
    ],
    system: 'You write image-generation prompts for thumbnails that earn a click without lying about the content. High contrast, one subject, text that stays legible at 200 pixels wide.',
    prompt: (v, c, style) => [
      `Subject: ${v.brief}`,
      v.words ? `Text to render on the image, spelled exactly: "${v.words}"` : 'No text on the image.',
      style ? `Style: ${style.prompt}` : 'Style: choose the single most effective thumbnail style for this subject.',
      `Aspect: ${c.aspect}.`,
      'Ice hockey context. No watermarks, no gibberish lettering.',
    ].join('\n'),
  },
];

export const botById = (id) => BOTS.find((b) => b.id === id) || null;

// A bot's settings defaults, merged under whatever Tony has saved.
export function defaultsFor(bot) {
  const out = {};
  for (const s of bot.settings || []) out[s.key] = typeof s.def === 'object' ? JSON.parse(JSON.stringify(s.def)) : s.def;
  out.system = bot.system;
  out.color = bot.color;
  return out;
}
