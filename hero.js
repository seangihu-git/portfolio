/**
 * Hero sky: an animated halftone night sky drawn on a <canvas>.
 *
 * Layers, back to front: stars and a constellation, twinkle flares, shooting
 * stars, then cumulus-nebula clouds posterised into dithered halftone dots.
 * The clouds part around the header text, and dots near the pointer are
 * pushed away on springs.
 *
 * The render loops keep short math-style names (x, y, u, v, idx, ...) on
 * purpose: they run for every grid cell on every frame, and the formulas
 * read more clearly that way. Everything around them uses descriptive names.
 */

/** Tweakable settings (defaults match the original design). */
const CONFIG = {
  cellSize: 3, // halftone cell size, px (3–10)
  textPadding: 0, // extra clear space around the header text, px (0–64)
  shootingFrequency: 25, // shooting stars per minute
  twinkleFrequency: 60, // twinkle flares per minute
  ambientMotion: true, // false freezes the sky on its first frame
  repel: true, // pointer pushes dots away
  repelRadius: 42, // px
  repelStrength: 0.5, // push distance as a fraction of the radius
  repelFollow: 0.25, // how quickly the push point chases the pointer (0–1)
  repelReturn: 0.12, // spring stiffness pulling dots back home
  // Per-letter stylistic alternates: "3, 7: ss02, H" = 3rd letter, 7th letter (ss02), every H.
  headlineAlternates: '1: ss02, 2, 3, 5, 6: ss02, 7: ss02, 8',
  brandAlternates: '',
  defaultAlternate: 'salt', // 'salt' | 'ss02' | 'both'
};

const TAU = Math.PI * 2;
const CYCLE_SECONDS = 140; // one full loop of the cloud motion
const WIND = -0.28; // radians; clouds, tendrils and streaks all lean along this heading
const MAX_FRAME_STEP = 0.1; // s; caps the clock jump after the tab was hidden

// Cloud tone buckets: index 1–5 cool levels, 6–10 warm levels, 11–12 faint background dither.
// Each entry is [fill, alpha].
const TONE_BUCKETS = [
  null,
  ['#1F2846', 0.95], ['#273D5B', 1], ['#7F93AC', 1], ['#A0B3C2', 1], ['#D5E9ED', 1],
  ['#2E2950', 0.95], ['#4B4479', 1], ['#9188BD', 1], ['#C3AFD3', 1], ['#E6C9D6', 1],
  ['#1F2846', 0.6], ['#273D5B', 0.5],
];

// The same buckets packed as RGBA pixels (little-endian: 0xAABBGGRR) for writing straight into ImageData.
const BUCKET_PIXELS = TONE_BUCKETS.map((entry) => {
  if (!entry) return 0;
  const [hex, alpha] = entry, rgb = parseInt(hex.slice(1), 16);
  return ((Math.round(alpha * 255) << 24) | ((rgb & 0xff) << 16) | (rgb & 0xff00) | (rgb >> 16)) >>> 0;
});

const PHYSICS_STEP = 1 / 60; // s; the pointer springs were tuned per 60 Hz frame
const MAX_PHYSICS_STEPS = 4; // catch-up limit after a slow frame
const ROW_PHASES = 3; // the cloud layer is refreshed one third of its rows per frame
const FIELD_PHASES = 8; // the cloud density field is recomputed one eighth of its rows per frame

// 4×4 ordered-dither thresholds
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

/* --------------------------------------------------------------------------
   Math helpers
   -------------------------------------------------------------------------- */

/** Deterministic integer hash → [0, 1). */
const hash3 = (i, j, k) => {
  let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 1440662683);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};

/** Smooth 3D value noise in [0, 1]. */
const valueNoise3 = (x, y, z) => {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const a = hash3(xi, yi, zi), b = hash3(xi + 1, yi, zi), c = hash3(xi, yi + 1, zi), d = hash3(xi + 1, yi + 1, zi);
  const e = hash3(xi, yi, zi + 1), f = hash3(xi + 1, yi, zi + 1), g = hash3(xi, yi + 1, zi + 1), h = hash3(xi + 1, yi + 1, zi + 1);
  const x1 = a + (b - a) * u, x2 = c + (d - c) * u, x3 = e + (f - e) * u, x4 = g + (h - g) * u;
  const y1 = x1 + (x2 - x1) * v, y2 = x3 + (x4 - x3) * v;
  return y1 + (y2 - y1) * w;
};

const smoothstep = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** Seeded PRNG (mulberry32), so the sky looks the same on every load. */
const createRng = (seed) => {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Cheap roughly-normal sample centred on 0. */
const gaussian = (rand) => (rand() + rand() + rand() - 1.5) * 1.15;

/* --------------------------------------------------------------------------
   Typography: per-letter stylistic alternates
   -------------------------------------------------------------------------- */

const parseAlternates = (spec, fallback) => {
  const byPosition = {}, byChar = {};
  for (const token of String(spec || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [key, value = ''] = token.split(':').map((s) => s.trim());
    const set = value === '2' || /ss02/i.test(value) ? 'ss02'
      : value === 'both' ? 'both'
      : value === '1' || /salt/i.test(value) ? 'salt'
      : fallback;
    if (/^\d+$/.test(key)) byPosition[Number(key)] = set;
    else if (key) byChar[key] = set;
  }
  return { byPosition, byChar };
};

/** Wraps the letters named in `spec` in spans styled by the .alt-* classes. Spaces aren't counted. */
function applyAlternates(element, spec, fallback) {
  if (!element) return;
  const { byPosition, byChar } = parseAlternates(spec, fallback);
  if (!Object.keys(byPosition).length && !Object.keys(byChar).length) return;

  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) if (walker.currentNode.nodeValue.trim()) textNodes.push(walker.currentNode);

  let letterCount = 0;
  for (const node of textNodes) {
    const fragment = document.createDocumentFragment();
    let buffer = '';
    let changed = false;
    for (const char of node.nodeValue) {
      const set = /\s/.test(char) ? null : byPosition[++letterCount] || byChar[char] || null;
      if (!set) {
        buffer += char;
        continue;
      }
      changed = true;
      if (buffer) fragment.append(buffer);
      buffer = '';
      const span = document.createElement('span');
      span.className = `alt-${set}`;
      span.textContent = char;
      fragment.append(span);
    }
    if (!changed) continue;
    if (buffer) fragment.append(buffer);
    node.replaceWith(fragment);
  }
}

/* --------------------------------------------------------------------------
   Clouds: a list of soft "puffs" painted back to front each frame
   -------------------------------------------------------------------------- */

// towering cumulus-nebula masses framing a dark diagonal channel (x, y, rx, ry, brightness)
const CLUSTERS = [
  [.80,.26,.10,.10,1],[.70,.42,.12,.11,.95],[.88,.46,.12,.13,.9],[.68,.66,.14,.11,.8],[.90,.72,.14,.13,.75],[.60,.88,.16,.09,.6],[.96,.14,.07,.09,.85],[.78,.94,.16,.07,.5],
  [.12,.06,.11,.07,.95],[.21,.13,.08,.05,.85],[.05,.25,.07,.09,.75],[.32,.04,.08,.035,.8],[.06,.39,.05,.06,.6],
  [.03,.84,.07,.09,.4],[.44,.97,.09,.04,.35],
  [.87,.22,.07,.06,.92],[.76,.34,.07,.05,.9],[.86,.36,.08,.06,.88],
  [.01,.49,.04,.10,.5],[.0,.66,.03,.08,.3],[.0,.81,.02,.06,.16],[.40,.035,.035,.018,.45],[.45,.05,.02,.01,.25],
  [.065,.50,.03,.012,.38],[.105,.515,.02,.008,.22],[.135,.525,.012,.005,.11]];
// dark violet wisps that drift in front of the towers
const WISPS = [[.56,.56,.15,.022],[.84,.60,.13,.02],[.20,.40,.14,.02],[.72,.90,.14,.018],[.42,.24,.07,.012],[.92,.34,.08,.015],[.12,.22,.09,.014]];

function makeClouds(w, h) {
  const rand = createRng(7331), W = Math.min(w, h * 1.7), puffs = [];
  const inGap = (x, y) => x > .37 * w && x < .61 * w && y < .46 * h;
  const add = o => puffs.push(Object.assign({ ph: rand() * TAU, ph2: rand() * TAU, ph3: rand() * TAU, A: (.004 + rand() * .008) * w, hm: 1 + Math.floor(rand() * 2), w1: rand() * TAU, w2: rand() * TAU, sx: 1, rot: 0,
    f1: 3 + Math.floor(rand() * 5), f2: 7 + Math.floor(rand() * 5), sa: .025 + rand() * .075, fe: .32 }, o));
  CLUSTERS.forEach(([cx, cy, rx0, ry0, amp], ci) => {
    const TL = ci === 8 || ci === 9 || ci === 11, sc = ci < 8 ? .84 : TL ? .62 : 1;
    // per-mass stretch so the right tower reads as uneven, sheared heaps rather than a stack of equal balls
    const VAR = [[1.2,1],[.95,1.1],[1.3,.95],[.8,.65],[1.6,.55],[1.5,.5],[.85,1.35],[1.6,.45],[1.3,.8],[1.3,.8],[1.2,.85],[1.35,.75],[1.25,.8],[.9,1],[.7,1],[.5,.9],[1.4,.6],[1.3,.5],[1.5,.6],[1.4,.5],[1.2,.45]][ci] || [1, 1], rx = rx0 * sc * VAR[0], ry = ry0 * sc * VAR[1];
    // each mass gets its own character: dense clump, loose broken heap, or wind-sheared streaks
    const kind = [0, 2, 1, 3, 2, 2, 1, 2, 1, 2, 2, 1, 1, 2, 2, 0, 1, 0, 3, 2, 3, 2, 2, 2, 2, 2][ci], streaky = kind === 2, wispy = kind === 3, flow = ci === 4 || ci === 5 || ci === 7;
    // each mass drifts on its own heading and phase so the sky doesn't move as one sheet
    const DR = { D: (.009 + .005 * rand()) * w * (streaky ? 1.3 : 1), ddir: WIND + gaussian(rand) * .08, dph: cx * 1.4 + (ci % 2) * 2.4 + rand() * .3 };
    const TLA = (ci >= 8 && ci <= 12) || ci >= 18, tb = TLA ? smoothstep((cy - .06) / .3) : 0; // top-left: dense crown, sparse base
    const n = wispy ? 9 : Math.max(5, Math.min(TLA ? 40 : 28, Math.round(rx * ry * (kind === 1 ? 1500 : 2000) * (TLA ? 1.6 - tb : 1))));
    for (let k = 0; k < n; k++) {
      const u = gaussian(rand), v = gaussian(rand) * (streaky ? .7 : 1), c = Math.exp(-(u * u + v * v) * .8);
      const x = (cx + u * rx * (streaky ? 1 : .85) * (TLA ? 1.25 : 1)) * w, y = (cy + v * ry * .85 * (TLA ? .7 : 1)) * h;
      const ty = TLA ? smoothstep((y / h - .06) / .34) : 0;
      if (TLA && rand() < ty * .65) continue;
      const big = !wispy && !TL && rand() < .05, sz = Math.pow(rand(), kind === 1 ? 1.3 : .6);
      const rad = (wispy || TL ? .022 + .03 * c * (.5 + .5 * rand()) : big ? .075 + .03 * rand() : .026 + .055 * c * sz + .01 * rand()) * W;
      const lit = Math.max(0, Math.min(1, .55 - v * .32 - u * .12));
      const tone = amp * (.32 + .75 * lit + .15 * c) * (.82 + .36 * rand()) * (1 - .4 * ty);
      const hue = rand() < .15 + .65 * lit ? .65 + .35 * rand() : rand() * .4;
      const sx = TLA ? 2 + rand() * 1.4 + ty * 1.6 : wispy ? 1.15 + rand() * .8 : flow ? 3.2 + rand() * 3.2 : streaky ? 1.7 + rand() * 2.6 : kind === 1 ? 1.3 + rand() * 1.1 : 1.25 + rand() * .8;
      const rot = wispy || TL ? WIND + gaussian(rand) * .15 : streaky ? WIND + gaussian(rand) * (flow ? .08 : .18) : WIND + gaussian(rand) * .4;
      const det = Math.max(0, Math.min(1, (valueNoise3(x * 3.2 / w, y * 3.2 / h, 9.1) - .38) * 3)) * (TLA ? .7 : 1);
      const LC = Object.assign({ lcx: (cx - .35 * rx) * w, lcy: (cy - .45 * ry) * h, lcr: 1 / (1.5 * Math.max(rx * w, ry * h)), lw: wispy || TL ? .15 : .28 + .5 * det, bk: wispy || TL ? .4 : .65 + .35 * det }, DR);
      add(Object.assign({ x, y, r: TLA ? rad * (.85 - .35 * ty) : flow ? rad * .5 : streaky ? rad * .6 : rad * (1 - .3 * det), sx, rot, tone, hue, key: tone, sa: wispy || TL ? .008 + rand() * .01 : streaky ? .012 + rand() * .02 : .012 + rand() * .03 + det * .07, f1: det > .4 ? 5 + Math.floor(rand() * 4) : 2 + Math.floor(rand() * 3), fe: wispy || TL ? .16 : flow ? .62 : (streaky ? .5 : kind === 1 ? .34 : .24) + det * .14 }, LC));
      const bumps = streaky || wispy ? 0 : TLA ? (det > .35 && rand() < .6 ? 1 : 0) : (rand() < .4 ? 1 : 0) + (det > .6 ? 1 + Math.floor(rand() * 2) : 0);
      for (let q = 0; q < bumps; q++) { const ang = -Math.PI * (.05 + .9 * rand()), d = rad * (.45 + .3 * rand() + .2 * det); add(Object.assign({ x: x + Math.cos(ang) * d, y: y + Math.sin(ang) * d, r: rad * (.45 + .35 * rand() - .2 * det), sx: 1 + rand() * .6, rot: rand() * TAU, tone: Math.min(1.05, tone * (1.04 + .06 * det)), hue: Math.min(1, hue + .1 + .1 * det), key: tone + .001, sa: .015 + rand() * .02 + det * .05, fe: .26 + det * .14 }, LC)); }
    }
    // tendrils: tapering, curling arms drawn out of the mass
    const nt = wispy ? 3 : kind === 0 ? Math.floor(rand() * 2) : 1 + Math.floor(rand() * 2);
    for (let q = 0; q < nt; q++) {
      // grows out of the body: starts as a round body-sized puff lit like the mass, stretches and thins along the wind, then fades
      let dir = wispy ? WIND + gaussian(rand) * .04 : WIND + Math.PI + gaussian(rand) * .05; const bend = gaussian(rand) * .004, ph = rand() * TAU;
      // wispy masses stream left to right: strands enter from the left edge at staggered heights and run through toward the right
      let x = (wispy ? cx - rx * .7 : cx + Math.cos(dir) * rx * .2) * w, y = (wispy ? cy + (q - 1) * ry * .45 : cy + Math.sin(dir) * ry * .2) * h, rad = (wispy ? .03 + .01 * rand() : .03 + .012 * rand()) * W, tone = amp * (wispy ? .75 + .1 * rand() : .6 + .2 * rand());
      const steps = (wispy ? 26 : 14) + Math.floor(rand() * 10), hue = .3 + .5 * rand(), tLC = { lcx: (cx - .35 * rx) * w, lcy: (cy - .45 * ry) * h, lcr: 1 / (1.5 * Math.max(rx * w, ry * h)), lw: wispy ? .15 : .3, bk: wispy ? .4 : .6 };
      for (let s = 0; s < steps; s++) {
        if (x < -.05 * w || x > 1.05 * w || y < -.05 * h || y > 1.05 * h || inGap(x, y)) break;
        const f = s / steps, sx = 1 + (wispy ? 1.8 : 3.2) * f + rand() * .6 * f, lat = Math.sin(f * 3 + ph) * rad * .5 * f;
        add(Object.assign({ x: x - Math.sin(dir) * lat, y: y + Math.cos(dir) * lat, r: rad, sx, rot: dir + gaussian(rand) * .04, tone: tone * (1 - .6 * f * f), hue: hue + (rand() - .5) * .15, key: tone * (1 - .3 * f) - .002, sa: .02 * (1 - f) + .01, fe: (wispy ? .18 : .3) + (wispy ? .3 : .42) * f }, tLC,
          { D: DR.D * (1 + 1.2 * f), ddir: DR.ddir, dph: DR.dph + f * .8 }));
        const stp = wispy ? .3 : .42; x += Math.cos(dir) * rad * sx * stp; y += Math.sin(dir) * rad * sx * stp;
        dir += bend * (.3 + f); rad *= (wispy ? .93 : .9) + rand() * .04;
      }
    }
  });
  // long sheared streak bands, like high cirrus across the masses
  for (const [sx0, sy0, len, tn] of [[.70,.53,.16,.55],[.88,.31,.09,.6],[.24,.27,.11,.6],[.76,.82,.15,.45],[.10,.56,.08,.4],[.92,.62,.08,.5]]) {
    const m = 5 + Math.floor(len * 40);
    for (let k = 0; k < m; k++) { const f = k / (m - 1) - .5, taper = 1 - Math.abs(f) * 1.5;
      const x = (sx0 + Math.cos(WIND) * f * len * 2) * w, y = sy0 * h + Math.sin(WIND) * f * len * 2 * w + gaussian(rand) * .006 * h;
      if (inGap(x, y)) continue;
      add({ x, y, r: (.006 + .009 * rand()) * W * (.5 + taper), sx: 3 + rand() * 3.5, rot: WIND + gaussian(rand) * .06, tone: tn * (.75 + .5 * rand()) * (.6 + .4 * taper), hue: .5 + .5 * rand(), key: tn + .2, sa: .015, fe: .7 }); }
  }
  for (const [cx, cy, rx, ry] of WISPS) for (let k = 0; k < 7; k++) { const u = gaussian(rand), v = gaussian(rand) * .5;
    add({ x: (cx + u * rx * .7) * w, y: (cy + v * ry) * h, r: (.008 + .012 * rand()) * W, sx: 3 + rand() * 4, tone: .26 + rand() * .1, hue: .75 + .25 * rand(), wisp: true, key: 5 }); }
  // trailing tails: long tapering ribbons that peel off every mass and stream down-left on the same wind, curling at the tips
  const trail = (x, y, len, amp, rad, curl, cf, hook, ph, D, dph, tLC, depth) => {
    const base = WIND + Math.PI, steps = Math.round(46 * len), hue = .45 + .35 * rand(), r0 = rad; let dir = base;
    for (let s = 0; s < steps; s++) {
      if (x < -.06 * w || y > 1.06 * h || y < -.06 * h || inGap(x, y)) break;
      const f = s / steps;
      dir = base + curl * Math.sin(f * cf * Math.PI + ph) * (.35 + f) + hook * f * f * f * f;
      const sx = 1.4 + 4.5 * f;
      add(Object.assign({ x, y, r: rad, sx, rot: dir + gaussian(rand) * .02, tone: amp * (1 - .75 * f * f), hue: hue + (rand() - .5) * .1, key: amp * (1 - .3 * f) - .003 - depth * .01,
        sa: .006, fe: .16 + .36 * f, D: D * (1 + 1.6 * f), ddir: WIND, dph: dph + f * 1.2 }, tLC));
      if (depth === 0 && s > 4 && rand() < .045) trail(x, y, len * (.25 + .2 * rand()), amp * .8, rad * .55, curl * 1.4, cf + 1, -hook * .8, rand() * TAU, D, dph + f, tLC, 1);
      const stp = Math.max(rad, r0 * .4) * sx * .28; x += Math.cos(dir) * stp; y += Math.sin(dir) * stp;
      rad = r0 * Math.max(.06, Math.pow(1 - f, 1.6)) * (.96 + rand() * .08);
    }
  };
  for (const [tx, ty, len, amp, rad, curl, cf, hook] of [
    [.66,.47,1,.75,.02,.22,2,.5],[.63,.6,.5,.7,.022,-.18,2.5,-.6],[.62,.73,.9,.65,.018,.25,3,.7],[.57,.86,.75,.55,.016,-.2,2,-.5],[.84,.95,.6,.5,.015,.15,2,.6],
    [.36,.05,.4,.6,.012,.22,2,.8],[.27,.15,.45,.55,.012,-.22,2.5,-.7],[.19,.40,.55,.55,.013,.25,2,.6],[.08,.42,.35,.5,.012,-.2,1.5,-.5]]) {
    trail(tx * w, ty * h, len, amp, rad * W, curl, cf, hook, rand() * TAU, (.004 + .004 * rand()) * w, rand() * TAU, { lcx: (tx + .05) * w, lcy: (ty - .08) * h, lcr: 1 / (.22 * w), lw: .15, bk: .4 }, 0);
  }
  // natural breaks in the right mass where the starry sky shows through
  const HOLES = [[.80,.40,.018],[.87,.58,.05],[.71,.77,.04],[.81,.84,.03],[.65,.52,.025],[.95,.68,.03],[.15,.13,.035],[.29,.12,.028],[.10,.24,.03]].map(([x, y, s]) => [x * w, y * h, s * W]);
  const kept = puffs.filter(p => { for (const [hx, hy, hr] of HOLES) { const d = Math.hypot(p.x - hx, p.y - hy); if (d < hr + p.r * .55) return false; } return true; });
  kept.sort((p, q) => p.key - q.key);
  return kept;
}

/* --------------------------------------------------------------------------
   Sky renderer
   -------------------------------------------------------------------------- */

/** Reads the shared palette from the CSS custom properties in styles.css. */
function readPalette(root) {
  const css = getComputedStyle(root);
  const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return {
    primary: token('--color-text-strong', '#D5E9ED'),
    secondary: token('--color-text', '#A0B3C2'),
    shadowDeep: token('--color-shadow-deep', '#1F2846'),
    shadow: token('--color-shadow', '#273D5B'),
    pink: token('--color-pink', '#E6C9D6'),
    lilac: token('--color-lilac', '#B9AFD8'),
    violet: TONE_BUCKETS[7][0],
    violetMid: TONE_BUCKETS[8][0],
  };
}

function initSky(dom) {
  const COLOR = readPalette(dom.root);
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = motionQuery.matches;
  const state = { ptr: { x: 0, y: 0, cx: 0, cy: 0, on: false, init: false }, raf: 0, frame: 0, t: 0 };

  // Lays out the grid, the clear zones around the header text, the stars and the clouds for the current size.
  const build = () => {
    const root = dom.root, cv = dom.canvas; if (!root || !cv) return;
    const w = root.clientWidth, h = root.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cell = Math.max(3, Math.min(10, Math.round(CONFIG.cellSize)));
    const cols = Math.ceil(w / cell) + 1, rows = Math.ceil(h / cell) + 1, N = cols * rows;
    const FS = Math.max(cell, 6), fc = Math.ceil(w / FS) + 2, fr = Math.ceil(h / FS) + 2;
    const rr = root.getBoundingClientRect(), rects = [], sc = rr.width / w || 1;
    const tp = Math.max(0, Math.min(64, CONFIG.textPadding));
    const add = (node, pad) => { if (!node) return; const r = node.getBoundingClientRect(); const hw = r.width / 2 / sc + pad, hh = r.height / 2 / sc + pad;
      rects.push({ cx: (r.left - rr.left + r.width / 2) / sc, cy: (r.top - rr.top + r.height / 2) / sc, hw, hh, r: Math.min(hw, hh) * .8, amp: 6 + pad * .35 }); };
    add(dom.brand, tp * .7); add(dom.links, tp * .7);
    const BAND = 64, mask = new Uint8Array(N), edgeIdx = [], edgeD = [], edgeAmp = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const px = i * cell + cell / 2, py = j * cell + cell / 2; let best = 1e9, amp = 0;
      for (const R of rects) {
        const qx = Math.abs(px - R.cx) - R.hw + R.r, qy = Math.abs(py - R.cy) - R.hh + R.r;
        const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - R.r;
        if (d < best) { best = d; amp = R.amp; }
      }
      const idx = j * cols + i;
      if (best < -(amp + 2)) mask[idx] = 1;
      else if (best < BAND + amp + cell) { mask[idx] = 2; edgeIdx.push(idx); edgeD.push(best); edgeAmp.push(amp); }
    }
    const rng = createRng(20261018), stars = [], nStars = Math.round(w * h / 4200);
    for (let k = 0; k < nStars; k++) { const big = rng() < .22; const tint = rng(); stars.push({ hx: rng() * w, hy: rng() * h, size: big ? 2 : 1, base: .35 + rng() * .5, bright: false, col: tint < .14 ? COLOR.pink : tint < .28 ? COLOR.lilac : null, t0: rng() * 40, dur: 3 + rng() * 3, ox: 0, oy: 0, vx: 0, vy: 0 }); }
    [[.18,.11],[.47,.16],[.93,.12],[.08,.38],[.95,.46],[.62,.62],[.38,.68]].forEach(p => stars.push({ hx: p[0] * w, hy: p[1] * h, size: 2, base: .9, bright: true, L: 4 + Math.round(rng() * 4), t0: rng() * 60, dur: 5 + rng() * 2, ox: 0, oy: 0, vx: 0, vy: 0 }));
    const cStart = stars.length;
    [[.43,.10],[.475,.17],[.53,.135],[.50,.27],[.56,.33],[.455,.40]].forEach((p, i) => stars.push({ hx: p[0] * w, hy: p[1] * h, size: 2, base: .85, bright: i === 3, L: 4, cons: true, t0: rng() * 50, dur: 4 + rng() * 2, ox: 0, oy: 0, vx: 0, vy: 0 }));
    const links = [[0,1],[1,2],[1,3],[3,4],[3,5]].map(([a, b]) => [cStart + a, cStart + b]);
    state.consFixed = false;
    const B = TONE_BUCKETS.map(() => new Float32Array(N * 3)), BN = new Int32Array(TONE_BUCKETS.length);
    // Cloud dots are rasterised into this pixel buffer (one CSS px per pixel) and composited in a single
    // drawImage, which is far cheaper than tens of thousands of fillRect calls per frame.
    const layer = state.layer || document.createElement('canvas');
    layer.width = w; layer.height = h;
    const layerCtx = layer.getContext('2d'), layerImage = layerCtx.createImageData(w, h);
    Object.assign(state, { layer, layerCtx, layerImage, layerPixels: new Uint32Array(layerImage.data.buffer) });
    Object.assign(state, { w, h, ctx, cell, cols, rows, N, FS, fc, fr, mask, edgeIdx, edgeD, edgeAmp, BAND, stars, links, B, BN, puffs: makeClouds(w, h), hueF: new Float32Array(fc * fr), ero: new Float32Array(fc * fr), wx: new Float32Array(fc * fr), wy: new Float32Array(fc * fr),
      field: new Float32Array(fc * fr), edgeCur: new Float32Array(N), ox: new Float32Array(N), oy: new Float32Array(N), vx: new Float32Array(N), vy: new Float32Array(N),
      shoot: null, nextShoot: (state.t || 0) + 3 + rng() * 3, fieldReady: false, needsFullRender: true, springBox: null });
  };

  // painter's pass: puffs back to front, lit from upper left, edges eroded by slowly evolving noise for a fluffy-but-wispy rim
  const updateField = (theta, part, stride) => {
    const { w, FS, fc, fr, field, hueF, ero, puffs } = state;
    const sT = Math.sin(theta), cT = Math.cos(theta), s5 = Math.sin(5 * theta), c5 = Math.cos(5 * theta), s7 = Math.sin(7 * theta + 1), c7 = Math.cos(7 * theta + 1);
    // the whole sky slowly advects to the right: edge detail and warp flow along the wind
    const adv = (state.t || 0) * 7;
    for (let j = part; j < fr; j += stride) { const y = j * FS;
      for (let i = 0; i < fc; i++) { const x = i * FS + adv, idx = j * fc + i;
        field[idx] = 0; hueF[idx] = 0;
        state.wx[idx] = valueNoise3(x / 95 + .3 * sT, y / 95 + .2 * cT, 11 + .3 * cT) - .5; state.wy[idx] = valueNoise3(x / 95 + 3.1 + .2 * cT, y / 95 + .3 * sT, 17 + .3 * sT) - .5;
        ero[idx] = valueNoise3(x / 26 + .35 * sT + .45 * s5, y / 26 + .3 * c5, .35 * cT + .45 * c5) * .65 + valueNoise3(x / 11 + .4 * s7, y / 11 + .25 * cT, 4 + .25 * sT + .4 * c7) * .35;
      } }
    const gdx = .008 * w * cT, gdy = .004 * w * sT;
    for (const p of puffs) {
      const dd = p.D ? p.D * Math.sin(theta + p.dph) : 0;
      const px = p.x + gdx + dd * Math.cos(p.ddir) + p.A * Math.sin(p.hm * theta + p.ph) + p.r * .07 * Math.sin(4 * theta + p.ph2), py = p.y + gdy + dd * Math.sin(p.ddir) + p.A * .7 * Math.cos(p.hm * theta + p.ph2) + p.r * .05 * Math.cos(3 * theta + p.ph);
      const r = p.r * (1 + .12 * Math.sin(p.hm * theta + p.ph3)), tone = p.tone * (1 + .08 * Math.sin(theta + p.ph3 + px * .003));
      const ext = r * 1.5 * p.sx, ca = Math.cos(p.rot), sa = Math.sin(p.rot), isx = 1 / p.sx;
      const rmx = p.wisp ? r * 1.15 * p.sx : ext, rmy = p.wisp ? r * 1.15 : ext * (Math.abs(sa) + Math.abs(ca) / p.sx) + r * .5;
      const i0 = Math.max(0, Math.floor((px - rmx) / FS)), i1 = Math.min(fc - 1, Math.ceil((px + rmx) / FS));
      let j0 = Math.max(0, Math.floor((py - rmy) / FS)); const j1 = Math.min(fr - 1, Math.ceil((py + rmy) / FS));
      j0 += ((part - j0) % stride + stride) % stride;
      if (p.wisp) {
        for (let j = j0; j <= j1; j += stride) { const dy = (j * FS - py) / r;
          for (let i = i0; i <= i1; i++) { const dx = (i * FS - px) / (r * p.sx), wob = dy - .35 * Math.sin(dx * 2.2 + p.w1), q = dx * dx + wob * wob * 1.4, idx = j * fc + i, e = ero[idx], lim = .15 + 1.05 * e * e * 1.4;
            if (q > lim * lim) continue; field[idx] = tone * (.8 + .4 * e); hueF[idx] = p.hue; } }
        continue;
      }
      const lx = px - .4 * r, ly = py - .5 * r, il = 1 / (1.35 * r), wa = r * .55, lsx = 1 / Math.max(1, p.sx * .7), fe0 = 1.12 - p.fe;
      const { wx, wy } = state;
      for (let j = j0; j <= j1; j += stride) { const y = j * FS;
        for (let i = i0; i <= i1; i++) { const x = i * FS, idx = j * fc + i;
          const dx = x - px + wx[idx] * wa, dy = y - py + wy[idx] * wa;
          const u = (dx * ca + dy * sa) * isx, v = -dx * sa + dy * ca, d2 = u * u + v * v; if (d2 > r * r * 1.3) continue;
          const e = ero[idx], an = Math.atan2(v, u);
          const re = r * (1 + p.sa * Math.sin(p.f1 * an + p.w1 + 4 * theta) + p.sa * .6 * Math.sin(p.f2 * an + p.w2 - 6 * theta)) * (fe0 + p.fe * e);
          if (d2 > re * re) continue;
          const ld = Math.hypot((x - lx) * lsx, y - ly) * il; let light = ld > 1 ? 0 : 1 - ld;
          if (p.lcr) { const gd = Math.hypot(x - p.lcx, y - p.lcy) * p.lcr; light = p.lw * light + (1 - p.lw) * (gd > 1 ? 0 : 1 - gd); }
          // soft edge: puffs blend into what's beneath instead of stamping a hard lobe
          const nv = tone * (.42 + .85 * light) * (.88 + .24 * e), nh = Math.max(0, Math.min(1, p.hue + (light - .4) * .9)), k = Math.min(1, (1 - d2 / (re * re)) * 2.2), old = field[idx];
          if (old > 0) { const kb = k * (p.bk ?? .7); field[idx] = old + (nv - old) * kb; hueF[idx] += (nh - hueF[idx]) * kb; } else { field[idx] = nv; hueF[idx] = nh; }
        } }
    }
  };

  const sampleField = (x, y) => { const { field, fc, fr, FS } = state; const i = Math.max(0, Math.min(fc - 1, Math.round(x / FS))), j = Math.max(0, Math.min(fr - 1, Math.round(y / FS))); return field[j * fc + i]; };

  const draw = (t, frozen, dt = PHYSICS_STEP) => {
    const { hueF, w, h, ctx, cell, cols, rows, mask, field, fc, FS, ox, oy, vx, vy, B, BN, stars, ptr, edgeIdx, edgeD, edgeAmp, edgeCur, BAND } = state;
    const theta = frozen ? 0 : TAU * ((t % CYCLE_SECONDS) / CYCLE_SECONDS);
    if (!state.fieldReady) { updateField(theta, 0, 1); state.fieldReady = true; }
    if (!state.consFixed) { state.consFixed = true;
      for (const s of state.stars) { if (!s.cons || sampleField(s.hx, s.hy) < .04) continue;
        let best = null; for (let rad = 8; rad < 260 && !best; rad += 8) for (let k = 0; k < 16; k++) { const a = k / 16 * TAU, x = s.hx + Math.cos(a) * rad, y = s.hy + Math.sin(a) * rad;
          if (x < 20 || y < 20 || x > state.w - 20 || y > state.h * .5) continue;
          let ok = true; for (let q = 0; q < 8 && ok; q++) { const b = q / 8 * TAU; if (sampleField(x + Math.cos(b) * 14, y + Math.sin(b) * 14) > .04) ok = false; }
          if (ok && sampleField(x, y) < .04) { best = [x, y]; break; } }
        if (best) { s.hx = best[0]; s.hy = best[1]; } } }
    else if (!frozen) updateField(theta, state.frame % FIELD_PHASES, FIELD_PHASES);
    const repel = !reduced && CONFIG.repel && ptr.on;
    // Pointer physics run in fixed 60 Hz steps, so the push and spring-back feel the same at any frame rate.
    state.physicsTime = Math.min(MAX_PHYSICS_STEPS * PHYSICS_STEP, (state.physicsTime || 0) + dt);
    const steps = Math.floor(state.physicsTime / PHYSICS_STEP + 1e-6);
    state.physicsTime -= steps * PHYSICS_STEP;
    const follow = Math.max(.03, Math.min(1, CONFIG.repelFollow));
    if (ptr.on) { if (!ptr.init) { ptr.cx = ptr.x; ptr.cy = ptr.y; ptr.init = true; }
      for (let s = 0; s < steps; s++) { ptr.cx += (ptr.x - ptr.cx) * follow; ptr.cy += (ptr.y - ptr.cy) * follow; } }
    const R = Math.max(10, CONFIG.repelRadius), STR = Math.max(0, CONFIG.repelStrength) * R;
    const K = Math.max(.01, Math.min(.25, CONFIG.repelReturn)), D = Math.max(.3, 1 - 1.2 * Math.sqrt(K));
    const cx = ptr.cx, cy = ptr.cy, hc = cell / 2, R2 = R * R;
    const spring = (hx, hy, o) => {
      let tx = 0, ty = 0;
      if (repel) { const dx = hx - cx, dy = hy - cy, d2 = dx * dx + dy * dy;
        if (d2 < R2) { const dist = Math.sqrt(d2) || .001, f = smoothstep(1 - dist / R), p = f * STR; tx = dx / dist * p; ty = dy / dist * p; } }
      for (let s = 0; s < steps; s++) { o.vx = (o.vx + (tx - o.ox) * K) * D; o.vy = (o.vy + (ty - o.oy) * K) * D; o.ox += o.vx; o.oy += o.vy; }
    };
    const tmp = { ox: 0, oy: 0, vx: 0, vy: 0 };
    const sT = Math.sin(theta), cT = Math.cos(theta);
    for (let k = 0; k < edgeIdx.length; k++) {
      const idx = edgeIdx[k], x = (idx % cols) * cell, y = ((idx / cols) | 0) * cell;
      edgeCur[idx] = edgeD[k] - (valueNoise3(x / 120 + .3 * sT, y / 120, .3 * cT + 7) - .5) * 2.2 * edgeAmp[k];
    }
    ctx.clearRect(0, 0, w, h);
    const pad = R + 12;
    const i0 = repel ? Math.max(0, Math.floor((cx - pad) / cell)) : 0, i1 = repel ? Math.min(cols, Math.ceil((cx + pad) / cell)) : 0;
    const j0 = repel ? Math.max(0, Math.floor((cy - pad) / cell)) : 0, j1 = repel ? Math.min(rows, Math.ceil((cy + pad) / cell)) : 0;
    // stars sit behind the clouds: draw them first, dimmed where cloud is dense
    const edgeFade = (x, y) => { const i = Math.max(0, Math.min(cols - 1, (x / cell) | 0)), j = Math.max(0, Math.min(rows - 1, (y / cell) | 0)), idx = j * cols + i, m = mask[idx];
      const open = m === 1 ? 1 : m === 2 ? 1 - smoothstep(edgeCur[idx] / BAND) : 0; return (1 - Math.min(1, sampleField(x, y) * 2.2) * (1 - open)) * (1 - .3 * open); };
    for (const s of stars) { if (repel || s.ox || s.oy) { spring(s.hx, s.hy, s); if (!repel && Math.abs(s.ox) + Math.abs(s.oy) + Math.abs(s.vx) + Math.abs(s.vy) < .02) s.ox = s.oy = s.vx = s.vy = 0; } }
    const pg = Math.max(3, cell), ps = Math.max(1, pg - 2);
    ctx.fillStyle = COLOR.secondary;
    for (const [a, b] of state.links) { const A = stars[a], Bs = stars[b], ax = A.hx + A.ox, ay = A.hy + A.oy, bx = Bs.hx + Bs.ox, by = Bs.hy + Bs.oy;
      const len = Math.hypot(bx - ax, by - ay), steps = Math.floor(len / pg); let lx = 1e9, ly = 1e9;
      for (let k = 2; k <= steps - 2; k++) { const u = k / steps, gx = Math.round((ax + (bx - ax) * u) / pg) * pg, gy = Math.round((ay + (by - ay) * u) / pg) * pg;
        if (gx === lx && gy === ly) continue; lx = gx; ly = gy;
        const ef = edgeFade(gx, gy); if (ef < .05) continue;
        ctx.globalAlpha = (k & 1 ? .22 : .38) * ef; ctx.fillRect(gx, gy, ps, ps); } }
    for (const s of stars) {
      let amt = 0;
      if (!frozen) {
        if (t > s.t0 + s.dur) { s.t0 = t + (s.bright ? 40 + Math.random() * 45 : 14 + Math.random() * 32); s.dur = s.bright ? 5 + Math.random() * 2 : 3 + Math.random() * 3; }
        if (t >= s.t0) { const u = (t - s.t0) / s.dur, sn = Math.sin(Math.PI * u); amt = sn * sn; }
      }
      const x = Math.round(s.hx + s.ox), y = Math.round(s.hy + s.oy), ef = edgeFade(x, y); if (ef < .04) continue;
      if (amt > .03) {
        ctx.fillStyle = COLOR.shadowDeep; ctx.globalAlpha = .35 * amt * ef; ctx.fillRect(x - 6, y - 3, 13, 7); ctx.fillRect(x - 3, y - 6, 7, 13);
        ctx.fillStyle = s.col ? COLOR.violet : COLOR.shadow; ctx.globalAlpha = .45 * amt * ef; ctx.fillRect(x - 3, y - 2, 7, 5); ctx.fillRect(x - 2, y - 3, 5, 7);
        ctx.fillStyle = COLOR.secondary; ctx.globalAlpha = .14 * amt * ef; ctx.fillRect(x - 2, y - 1, 5, 3); ctx.fillRect(x - 1, y - 2, 3, 5);
      }
      if (s.bright) {
        const gx = Math.round(x / pg) * pg, gy = Math.round(y / pg) * pg, arm = 1 + (amt > .5 ? 1 : 0) + (s.L > 6 ? 1 : 0);
        ctx.fillStyle = COLOR.primary; ctx.globalAlpha = ef; ctx.fillRect(gx, gy, pg - 1, pg - 1);
        for (let k = 1; k <= arm; k++) { const a = (k === arm ? .4 : .75) * ef; ctx.globalAlpha = a; ctx.fillStyle = k === arm ? COLOR.secondary : COLOR.primary;
          ctx.fillRect(gx + k * pg, gy, ps, ps); ctx.fillRect(gx - k * pg, gy, ps, ps); ctx.fillRect(gx, gy + k * pg, ps, ps); ctx.fillRect(gx, gy - k * pg, ps, ps); }
      } else {
        const sz = Math.round(s.size * (1 + .3 * amt)) || 1;
        ctx.fillStyle = s.col || (s.cons || s.size > 1 && s.base > .7 ? COLOR.primary : COLOR.secondary); ctx.globalAlpha = (s.base + (1 - s.base) * amt) * ef;
        ctx.fillRect(x - (sz >> 1), y - (sz >> 1), sz, sz);
        if (s.cons) { const gx = Math.round(x / pg) * pg, gy = Math.round(y / pg) * pg; ctx.fillStyle = COLOR.primary; ctx.globalAlpha = .9 * ef; ctx.fillRect(gx, gy, pg - 1, pg - 1); ctx.globalAlpha = .4 * ef; ctx.fillStyle = COLOR.secondary; ctx.fillRect(gx + pg, gy, ps, ps); ctx.fillRect(gx - pg, gy, ps, ps); ctx.fillRect(gx, gy + pg, ps, ps); ctx.fillRect(gx, gy - pg, ps, ps); }
      }
    }
    // rotating astigmatism flares
    if (!frozen) {
      const tf = Math.max(0, CONFIG.twinkleFrequency);
      state.flares = state.flares || [];
      if (state.nextFlare == null) state.nextFlare = t + 1.5;
      if (tf > 0 && t > state.nextFlare) {
        state.nextFlare = t + (60 / tf) * (.4 + Math.random() * 1.2);
        for (let tries = 0; tries < 12; tries++) { const s = stars[(Math.random() * stars.length) | 0];
          if (!s.bright && s.size < 2 && Math.random() < .6) continue;
          if (edgeFade(s.hx, s.hy) < .5 || state.flares.some(f => f.s === s)) continue;
          state.flares.push({ s, start: t, dur: 1.4 + Math.random() * 1.2 }); break; }
      }
      state.flares = state.flares.filter(f => t - f.start < f.dur);
      // pixel-game sparkle: stepped frames on the halftone grid (dot -> plus -> star -> big star -> diagonal glint -> back)
      const g = Math.max(3, state.cell);
      const FR = [
        [[0,0,1]],
        [[0,0,1],[1,0,.6],[-1,0,.6],[0,1,.6],[0,-1,.6]],
        [[0,0,1],[1,0,.9],[-1,0,.9],[0,1,.9],[0,-1,.9],[0,2,.5],[0,-2,.5],[2,0,.35],[-2,0,.35]],
        [[0,0,1],[1,0,.95],[-1,0,.95],[0,1,.95],[0,-1,.95],[0,2,.75],[0,-2,.75],[2,0,.55],[-2,0,.55],[0,3,.4],[0,-3,.4],[3,0,.25],[-3,0,.25]],
        [[0,0,1],[1,1,.7],[-1,1,.7],[1,-1,.7],[-1,-1,.7],[2,2,.35],[-2,2,.35],[2,-2,.35],[-2,-2,.35]],
      ];
      const SEQ = [0,1,2,3,2,4,2,3,2,1,0];
      for (const f of state.flares) {
        const u = (t - f.start) / f.dur, s = f.s;
        const fi = SEQ[Math.min(SEQ.length - 1, Math.floor(u * SEQ.length))], frame = FR[fi];
        const gx = Math.round((s.hx + s.ox) / g) * g, gy = Math.round((s.hy + s.oy) / g) * g, ef = edgeFade(gx, gy); if (ef < .05) continue;
        const col = s.col || COLOR.primary, sz = Math.max(1, g - 2), csz = Math.max(1, g - 1);
        if (fi === 3) { ctx.fillStyle = s.col ? COLOR.violet : COLOR.shadow; ctx.globalAlpha = .35 * ef;
          for (const [dx, dy] of [[1,1],[-1,1],[1,-1],[-1,-1]]) ctx.fillRect(gx + dx * g, gy + dy * g, sz, sz); }
        for (const [dx, dy, a] of frame) { ctx.globalAlpha = a * ef; ctx.fillStyle = a > .7 ? (dx || dy ? col : COLOR.primary) : (s.col ? COLOR.violetMid : COLOR.secondary); const q = dx || dy ? sz : csz; ctx.fillRect(gx + dx * g, gy + dy * g, q, q); }
      }
    }
    if (!frozen) {
      const freq = Math.max(.2, CONFIG.shootingFrequency);
      if (!state.shoot && t > state.nextShoot) {
        const dir = Math.random() < .5 ? 1 : -1, ang = (14 + Math.random() * 12) * Math.PI / 180, len = (.15 + Math.random() * .15) * w;
        const x0 = dir > 0 ? (.25 + Math.random() * .4) * w : (.5 + Math.random() * .4) * w;
        state.shoot = { x0, y0: (.05 + Math.random() * .25) * h, dx: Math.cos(ang) * dir, dy: Math.sin(ang), len, start: t, dur: 1 + Math.random() * .5 };
      }
      const sh = state.shoot;
      if (sh) {
        const u = (t - sh.start) / sh.dur;
        if (u >= 1) { state.shoot = null; state.nextShoot = t + (60 / freq) * (.45 + Math.random() * 1.1); }
        else {
          const e = 1 - Math.pow(1 - u, 3), fade = Math.min(1, u / .12) * (u > .65 ? (1 - u) / .35 : 1);
          const hx = sh.x0 + sh.dx * sh.len * e, hy = sh.y0 + sh.dy * sh.len * e, tail = 18, gap = 4 + 2 * (1 - u);
          for (let k = tail; k >= 0; k--) {
            const px = Math.round(hx - sh.dx * k * gap), py = Math.round(hy - sh.dy * k * gap), sz = k === 0 ? 3 : k < 6 ? 2 : 1;
            ctx.fillStyle = k < 4 ? COLOR.primary : COLOR.secondary; ctx.globalAlpha = fade * (1 - k / (tail + 1)) * (k === 0 ? 1 : .85) * edgeFade(px, py);
            ctx.fillRect(px - (sz >> 1), py - (sz >> 1), sz, sz);
          }
        }
      }
    }
    // clouds: posterised into flat tone bands with dithered borders; parted around text.
    // The clouds drift slowly, so each frame re-renders only every ROW_PHASES-th row of cells, plus a
    // box around the pointer (and around any dots still springing back) so the repel stays smooth.
    const renderRow = (j, iFrom, iTo, skipFrom, skipTo, inBox) => {
      const fyy = (j * cell + hc) / FS, fj = Math.min(state.fr - 2, fyy | 0), ty = fyy - fj, ny = j / rows;
      const bgRow = .05 + .3 * Math.pow(ny, 1.5), bgS = Math.max(1, Math.round(cell * .3)), bgMix = .45 * smoothstep((ny - .3) / .7);
      for (let i = iFrom; i < iTo; i++) {
        if (i === skipFrom) { i = skipTo - 1; continue; }
        const idx = j * cols + i, m = mask[idx], bay = BAYER[(j & 3) * 4 + (i & 3)];
        const bgv = bgRow * (m === 1 ? .55 : 1);
        if (m === 1) { if (bay < bgv) { const s = bgS, bk = hash3(i, j, 77) < bgMix ? 12 : 11, n = BN[bk]++ * 3, arr = B[bk]; arr[n] = i * cell + ((cell - s) >> 1); arr[n + 1] = j * cell + ((cell - s) >> 1); arr[n + 2] = s; } continue; }
        if (inBox) {
          const near = i >= i0 && i < i1 && j >= j0 && j < j1;
          if (near || ox[idx] !== 0 || oy[idx] !== 0) {
            tmp.ox = ox[idx]; tmp.oy = oy[idx]; tmp.vx = vx[idx]; tmp.vy = vy[idx];
            spring(i * cell + hc, j * cell + hc, tmp);
            if (!near && Math.abs(tmp.ox) + Math.abs(tmp.oy) + Math.abs(tmp.vx) + Math.abs(tmp.vy) < .02) tmp.ox = tmp.oy = tmp.vx = tmp.vy = 0;
            ox[idx] = tmp.ox; oy[idx] = tmp.oy; vx[idx] = tmp.vx; vy[idx] = tmp.vy;
            if (tmp.ox || tmp.oy || tmp.vx || tmp.vy) { if (i < nb[0]) nb[0] = i; if (i >= nb[1]) nb[1] = i + 1; if (j < nb[2]) nb[2] = j; if (j >= nb[3]) nb[3] = j + 1; }
          }
        }
        const fxx = (i * cell + hc) / FS, fi = Math.min(fc - 2, fxx | 0), tx = fxx - fi, o = fj * fc + fi;
        let v = (field[o] * (1 - tx) + field[o + 1] * tx) * (1 - ty) + (field[o + fc] * (1 - tx) + field[o + fc + 1] * tx) * ty;
        if (m === 2) { const d = edgeCur[idx]; if (d <= 0) continue; v *= smoothstep(d / BAND); }
        const L = v * 5.2, base = L | 0, frac = L - base;
        let lv = v < .05 ? 0 : Math.min(5, base + (frac > .55 && bay < (frac - .55) / .45 ? 1 : 0));
        if (lv === 1 && bay > .55) lv = 0;
        if (lv === 0) { if (bay < bgv) { const s = bgS, bk = hash3(i, j, 77) < bgMix ? 12 : 11, n = BN[bk]++ * 3, arr = B[bk]; arr[n] = i * cell + ((cell - s) >> 1) + Math.round(ox[idx]); arr[n + 1] = j * cell + ((cell - s) >> 1) + Math.round(oy[idx]); arr[n + 2] = s; } continue; }
        const hv = hueF[Math.min(fj + (ty > .5 ? 1 : 0), state.fr - 1) * fc + Math.min(fi + (tx > .5 ? 1 : 0), fc - 1)];
        const warm = hv > BAYER[((j + 2) & 3) * 4 + ((i + 1) & 3)];
        let s = Math.max(1, Math.min(cell - 1, Math.round(cell * (.38 + .13 * lv))));
        const disp = ox[idx] * ox[idx] + oy[idx] * oy[idx];
        if (disp > 1) s = Math.min(cell, Math.round(s * (1 + .15 * Math.min(1, Math.sqrt(disp) / R))));
        const bk = warm ? lv + 5 : lv, n = BN[bk]++ * 3, arr = B[bk];
        arr[n] = Math.round(i * cell + hc - s / 2 + ox[idx]); arr[n + 1] = Math.round(j * cell + hc - s / 2 + oy[idx]); arr[n + 2] = s;
      }
    };
    const full = frozen || state.needsFullRender; state.needsFullRender = false;
    const { layer, layerCtx, layerImage, layerPixels } = state;
    // box (in cells) that must be redrawn this frame: around the pointer plus last frame's springing dots,
    // padded so a displaced dot never lands outside the cleared area
    const pb = state.springBox, margin = Math.ceil((STR * 1.5) / cell) + 2;
    let bi0 = repel ? i0 : cols, bi1 = repel ? i1 : 0, bj0 = repel ? j0 : rows, bj1 = repel ? j1 : 0;
    if (pb) { bi0 = Math.min(bi0, pb[0]); bi1 = Math.max(bi1, pb[1]); bj0 = Math.min(bj0, pb[2]); bj1 = Math.max(bj1, pb[3]); }
    const hasBox = bi1 > bi0 && bj1 > bj0;
    if (hasBox) { bi0 = Math.max(0, bi0 - margin); bi1 = Math.min(cols, bi1 + margin); bj0 = Math.max(0, bj0 - margin); bj1 = Math.min(rows, bj1 + margin); }
    const nb = [cols, 0, rows, 0];
    BN.fill(0);
    if (full) layerPixels.fill(0);
    const phase = state.frame % ROW_PHASES;
    for (let j = full ? 0 : phase; j < rows; j += full ? 1 : ROW_PHASES) {
      if (!full) layerPixels.fill(0, Math.min(h, j * cell) * w, Math.min(h, (j + 1) * cell) * w);
      const inRows = hasBox && j >= bj0 && j < bj1;
      renderRow(j, 0, cols, inRows ? bi0 : -1, inRows ? bi1 : -1, false);
    }
    if (hasBox) {
      const px0 = Math.min(w, bi0 * cell), px1 = Math.min(w, bi1 * cell);
      for (let y = Math.min(h, bj0 * cell), y1 = Math.min(h, bj1 * cell); y < y1; y++) layerPixels.fill(0, y * w + px0, y * w + px1);
      for (let j = bj0; j < bj1; j++) renderRow(j, bi0, bi1, -1, -1, true);
    }
    state.springBox = nb[1] > nb[0] ? nb : null;
    // rasterise the dots, bucket by bucket, into the cloud layer and composite it over the stars
    for (let k = 1; k < TONE_BUCKETS.length; k++) {
      if (!BN[k]) continue;
      const color = BUCKET_PIXELS[k], arr = B[k];
      for (let n = 0, e = BN[k] * 3; n < e; n += 3) {
        const x0 = Math.max(0, arr[n]), x1 = Math.min(w, arr[n] + arr[n + 2]), y1 = Math.min(h, arr[n + 1] + arr[n + 2]);
        if (x1 <= x0) continue;
        for (let y = Math.max(0, arr[n + 1]); y < y1; y++) layerPixels.fill(color, y * w + x0, y * w + x1);
      }
    }
    layerCtx.putImageData(layerImage, 0, 0);
    ctx.globalAlpha = 1; ctx.imageSmoothingEnabled = false;
    ctx.drawImage(layer, 0, 0, w, h);
    state.frame++;
  };

  /* ---- Animation loop: runs only while the hero is visible and motion is allowed ---- */

  let running = false;
  let onScreen = true;
  let lastNow = 0;

  const loop = (now) => {
    const dt = Math.min(MAX_FRAME_STEP, (now - lastNow) / 1000);
    state.t += dt;
    lastNow = now;
    try {
      draw(state.t, !CONFIG.ambientMotion, dt);
    } catch (err) {
      if (!state.loggedError) {
        state.loggedError = true;
        console.error('hero sky:', err);
      }
    }
    state.raf = requestAnimationFrame(loop);
  };

  const updateLoop = () => {
    const shouldRun = !reduced && onScreen && !document.hidden;
    if (shouldRun && !running) {
      running = true;
      lastNow = performance.now();
      state.raf = requestAnimationFrame(loop);
    } else if (!shouldRun && running) {
      running = false;
      cancelAnimationFrame(state.raf);
    }
  };

  const rebuild = () => {
    try {
      build();
      // paint right away so there's no blank canvas while waiting for the next animation frame
      if (reduced) draw(0, true); // a single still frame
      else draw(state.t, !CONFIG.ambientMotion, 0);
    } catch (err) {
      console.error('hero sky build:', err);
    }
  };

  rebuild();
  updateLoop();

  // Re-layout when the hero or the header text changes size (including after web fonts load).
  let pendingRebuild = 0;
  const scheduleRebuild = () => {
    cancelAnimationFrame(pendingRebuild);
    pendingRebuild = requestAnimationFrame(rebuild);
  };
  const resizeObserver = new ResizeObserver(scheduleRebuild);
  for (const node of [dom.root, dom.brand, dom.links]) if (node) resizeObserver.observe(node);
  document.fonts?.ready.then(scheduleRebuild);

  // Pause when the tab is hidden or the hero is scrolled out of view.
  document.addEventListener('visibilitychange', updateLoop);
  new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    updateLoop();
  }).observe(dom.root);

  motionQuery.addEventListener('change', () => {
    reduced = motionQuery.matches;
    rebuild();
    updateLoop();
  });

  // Pointer tracking for the repel effect (touch only while a finger is down).
  const root = dom.root;
  const onPointerMove = (e) => {
    if (e.pointerType === 'touch' && e.buttons === 0) return;
    const rect = root.getBoundingClientRect(), scale = rect.width / root.clientWidth || 1;
    state.ptr.x = (e.clientX - rect.left) / scale;
    state.ptr.y = (e.clientY - rect.top) / scale;
    if (!state.ptr.on) state.ptr.init = false;
    state.ptr.on = true;
  };
  const onPointerLeave = () => {
    state.ptr.on = false;
  };
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerdown', onPointerMove);
  root.addEventListener('pointerleave', onPointerLeave);
  root.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'touch') onPointerLeave();
  });
}

/* --------------------------------------------------------------------------
   Boot
   -------------------------------------------------------------------------- */

const dom = {
  root: document.querySelector('[data-hero]'),
  canvas: document.querySelector('[data-hero-sky]'),
  brand: document.querySelector('[data-hero-brand]'),
  links: document.querySelector('[data-hero-links]'),
  title: document.querySelector('[data-hero-title]'),
};

applyAlternates(dom.brand, CONFIG.brandAlternates, CONFIG.defaultAlternate);
applyAlternates(dom.title, CONFIG.headlineAlternates, CONFIG.defaultAlternate);
if (dom.root && dom.canvas && dom.canvas.getContext) initSky(dom);
