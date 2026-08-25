// Rink geometry and background composition. Measurements are off
// assets/rink.png (3200x1600) and match CTH Film Room exactly, so element
// coordinates mean the same thing in both apps.

export const RINK_W = 3200;
export const RINK_H = 1600;
export const SEQ_GAP = 60;  // white band between stacked rinks
export const SEQ_MAX = 5;

export const RINK = {
  goalL: 230, goalR: 2970, blueL: 1135, blueR: 2084, center: 1600,
  creaseL: 272, creaseR: 2928, midY: 800,
  dotRows: [403, 1197],
  dotCols: [564, 1260, 1956, 2638],
};

// The placeable rink items, sized in rink pixels (at 3200 wide).
export const ITEMS = {
  net: { file: 'net', w: 80, h: 140, label: 'Net' },
  coach: { file: 'Co', w: 90, h: 90, label: 'Coach' },
  puck: { file: 'puck', w: 39, h: 39, label: 'Puck' },
  pucks: { file: null, w: 64, h: 56, label: 'Pucks' }, // vector cluster
  cone: { file: 'cone', w: 56, h: 56, label: 'Cone' },
  border: { file: 'border', w: 34, h: 190, label: 'Border' },
};

const SHAPE_FILES = ['net', 'Co', 'puck', 'cone', 'border'];

export function loadImg(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('That image could not be read'));
    img.src = src;
  });
}

let rinkImg = null;
const shapeImgs = new Map(); // name -> HTMLImageElement
const shapeUrls = new Map(); // name -> dataUrl (for SVG hrefs and buttons)

async function toDataUrl(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  return c.toDataURL('image/png');
}

export async function loadAssets(base = 'assets') {
  if (rinkImg) return;
  rinkImg = await loadImg(`${base}/rink.png`);
  await Promise.all(SHAPE_FILES.map(async (name) => {
    const img = await loadImg(`${base}/shapes/${name}.png`);
    shapeImgs.set(name, img);
    shapeUrls.set(name, await toDataUrl(img));
  }));
}

export const shapeImg = (name) => shapeImgs.get(name) || null;
export const shapeUrl = (name) => shapeUrls.get(name) || '';
export const getRinkImg = () => rinkImg;

// Compose the standard background for a sequence of n rinks: white ground,
// rink.png repeated with SEQ_GAP bands. Returns a canvas.
export function composeRinkBg(n = 1) {
  const c = document.createElement('canvas');
  c.width = RINK_W;
  c.height = n * RINK_H + (n - 1) * SEQ_GAP;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  for (let k = 0; k < n; k++) ctx.drawImage(rinkImg, 0, k * (RINK_H + SEQ_GAP), RINK_W, RINK_H);
  return c;
}
