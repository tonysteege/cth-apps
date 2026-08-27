// The visual aid types, straight from Tony's own reference page in Notion
// ("Visual Aid Types", read 2026-08-27 through the CTH Worker). Fifty-two
// formats across nine categories, each with the job it is best at.
//
// WHY THEY LIVE HERE AND NOT ON THE CONFIG: this is a catalogue, not a
// preference. Tony's own edits - a renamed style, an attached example -
// belong in his saved config; the catalogue itself should update when the
// page does, and having it in one file makes that a single edit.
//
// A TYPE IS A STRUCTURE, NOT A LOOK. "Funnel" says how the information is
// arranged; the bot's own instruction still governs the drawing style. The
// prompt each one generates therefore describes LAYOUT and leaves the
// rendering to the instruction, which is what keeps a deck of fifty-two
// options from becoming fifty-two different-looking images.

export const VISUAL_TYPES = [
  { id: 'mind-map', cat: 'Relationships', name: "Mind Map", best: "Central concept branching into related ideas" },
  { id: 'hierarchy-tree', cat: 'Relationships', name: "Hierarchy / Tree", best: "Parent-child relationships, categories" },
  { id: 'venn-diagram', cat: 'Relationships', name: "Venn Diagram", best: "Overlap and differences between concepts" },
  { id: 'network-web', cat: 'Relationships', name: "Network / Web", best: "Interconnected ideas with no clear hierarchy" },
  { id: 'org-chart', cat: 'Relationships', name: "Org Chart", best: "Roles, structure, chain of command" },
  { id: 'flowchart', cat: 'Process and Sequence', name: "Flowchart", best: "Step-by-step with decision points" },
  { id: 'process-chart', cat: 'Process and Sequence', name: "Process Chart", best: "Linear steps without branching" },
  { id: 'timeline', cat: 'Process and Sequence', name: "Timeline", best: "Events or milestones in chronological order" },
  { id: 'roadmap', cat: 'Process and Sequence', name: "Roadmap", best: "Multi-phase journey over time" },
  { id: 'cycle-diagram', cat: 'Process and Sequence', name: "Cycle Diagram", best: "Repeating phases (loops back to start)" },
  { id: 'funnel', cat: 'Process and Sequence', name: "Funnel", best: "Narrowing from broad to specific" },
  { id: 'ladder-staircase', cat: 'Process and Sequence', name: "Ladder / Staircase", best: "Progressive levels of mastery or difficulty" },
  { id: 'pipeline', cat: 'Process and Sequence', name: "Pipeline", best: "Stages something moves through" },
  { id: 'side-by-side-comparison', cat: 'Comparison and Contrast', name: "Side-by-Side Comparison", best: "Two approaches, before/after, with/without" },
  { id: 'matrix-grid', cat: 'Comparison and Contrast', name: "Matrix / Grid", best: "Comparing multiple items across multiple criteria" },
  { id: 'spectrum-slider-scale', cat: 'Comparison and Contrast', name: "Spectrum / Slider Scale", best: "Where something falls on a range" },
  { id: 'tier-list-ranking', cat: 'Comparison and Contrast', name: "Tier List / Ranking", best: "Ordered by quality, priority, or importance" },
  { id: 'swot-diagram', cat: 'Comparison and Contrast', name: "SWOT Diagram", best: "Strengths, weaknesses, opportunities, threats" },
  { id: 'pros-cons', cat: 'Comparison and Contrast', name: "Pros / Cons", best: "Simple two-column tradeoff" },
  { id: 'problem-solution', cat: 'Comparison and Contrast', name: "Problem / Solution", best: "Split layout pairing a pain point with a fix" },
  { id: 'bar-chart', cat: 'Data and Measurement', name: "Bar Chart", best: "Comparing quantities across categories" },
  { id: 'gauge-meter', cat: 'Data and Measurement', name: "Gauge / Meter", best: "Single metric showing current state" },
  { id: 'progress-bar', cat: 'Data and Measurement', name: "Progress Bar", best: "Completion or advancement" },
  { id: 'scorecard-dashboard', cat: 'Data and Measurement', name: "Scorecard / Dashboard", best: "Multiple metrics at a glance" },
  { id: 'radar-spider-chart', cat: 'Data and Measurement', name: "Radar / Spider Chart", best: "Multi-axis skill or trait assessment" },
  { id: 'pie-donut-chart', cat: 'Data and Measurement', name: "Pie / Donut Chart", best: "Parts of a whole" },
  { id: 'stat-cards', cat: 'Data and Measurement', name: "Stat Cards", best: "Highlighting key numbers with context" },
  { id: '2x2-matrix', cat: 'Frameworks and Models', name: "2x2 Matrix", best: "Two axes creating four quadrants (effort vs impact, etc.)" },
  { id: 'framework-diagram', cat: 'Frameworks and Models', name: "Framework Diagram", best: "Conceptual model or mental model" },
  { id: 'pyramid', cat: 'Frameworks and Models', name: "Pyramid", best: "Layered priorities (foundation to peak)" },
  { id: 'iceberg', cat: 'Frameworks and Models', name: "Iceberg", best: "What's visible vs what's hidden underneath" },
  { id: 'concentric-circles', cat: 'Frameworks and Models', name: "Concentric Circles", best: "Core concept surrounded by layers" },
  { id: 'equation-formula', cat: 'Frameworks and Models', name: "Equation / Formula", best: "A + B = C style relationships" },
  { id: 'pillar-diagram', cat: 'Frameworks and Models', name: "Pillar Diagram", best: "Multiple pillars supporting one outcome" },
  { id: 'annotated-diagram', cat: 'Composition and Anatomy', name: "Annotated Diagram", best: "Labeling parts of something (a stance, a piece of equipment)" },
  { id: 'exploded-view', cat: 'Composition and Anatomy', name: "Exploded View", best: "Breaking something into its components" },
  { id: 'checklist-summary-card', cat: 'Composition and Anatomy', name: "Checklist / Summary Card", best: "Key takeaways in a scannable format" },
  { id: 'anatomy-chart', cat: 'Composition and Anatomy', name: "Anatomy Chart", best: "Body positions, muscle groups, movement mechanics" },
  { id: 'cross-section', cat: 'Composition and Anatomy', name: "Cross-Section", best: "Inside view of something normally seen from outside" },
  { id: 'cause-and-effect-chain', cat: 'Cause and Effect', name: "Cause and Effect Chain", best: "Action leads to consequence leads to outcome" },
  { id: 'domino-cascade', cat: 'Cause and Effect', name: "Domino / Cascade", best: "One thing triggering the next" },
  { id: 'if-then-decision-tree', cat: 'Cause and Effect', name: "If/Then Decision Tree", best: "Branching outcomes based on choices" },
  { id: 'fishbone-ishikawa', cat: 'Cause and Effect', name: "Fishbone (Ishikawa)", best: "Multiple causes feeding into one effect" },
  { id: 'rink-field-diagram', cat: 'Space and Movement', name: "Rink / Field Diagram", best: "Positions, zones, movement patterns on ice" },
  { id: 'tactical-play-diagram', cat: 'Space and Movement', name: "Tactical Play Diagram", best: "Player routes, passing lanes, formations" },
  { id: 'heat-map', cat: 'Space and Movement', name: "Heat Map", best: "Intensity or frequency across an area" },
  { id: 'movement-path', cat: 'Space and Movement', name: "Movement Path", best: "Showing body mechanics or footwork sequence" },
  { id: 'visual-metaphor', cat: 'Abstract Concepts', name: "Visual Metaphor", best: "Abstract idea shown through a relatable image" },
  { id: 'before-after', cat: 'Abstract Concepts', name: "Before / After", best: "Transformation or change over time" },
  { id: 'whiteboard-sketch', cat: 'Abstract Concepts', name: "Whiteboard Sketch", best: "Casual, brainstorm-style layout" },
  { id: 'quote-card', cat: 'Abstract Concepts', name: "Quote Card", best: "Key phrase or principle with strong typography" },
  { id: 'icon-grid', cat: 'Abstract Concepts', name: "Icon Grid", best: "Categories or features represented by icons" },
];

export const VISUAL_CATS = [...new Set(VISUAL_TYPES.map((t) => t.cat))];

// The quality bar from the same page: it names Information is Beautiful as
// the standard to aim for and Dribbble as where the craft lives. A
// text-to-image model cannot browse either, so the honest way to use them
// is as a described standard rather than a pretended lookup.
export const QUALITY_CLAUSE = [
  'Hold the standard of an award-winning information graphic:',
  'one idea per image, a clear visual hierarchy, generous white space,',
  'labels that read at a glance, a restrained palette with a single accent,',
  'and nothing decorative that does not carry meaning.',
].join(' ');

// Turned into the style shape the bot registry and the runner already use.
// `best` rides along so a picker can show what the type is FOR without
// having to unpick it out of the generated prompt.
export const typeStyle = (t) => ({
  id: t.id,
  name: t.name,
  cat: t.cat,
  best: t.best,
  prompt: `a ${t.name.toLowerCase()} layout - ${t.best.toLowerCase()}. ${QUALITY_CLAUSE}`,
});

export const VISUAL_TYPE_STYLES = VISUAL_TYPES.map(typeStyle);
