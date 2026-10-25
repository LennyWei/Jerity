// client/src/floor.js
// The arena floor as one picture. render.js paints it once into an offscreen canvas (per map,
// palette step and size) and copies it every frame, so all this detail costs nothing per frame:
//   - each map's own floor: Classic, a polished plank rink; Tire Field, asphalt with old tire
//     tracks; Spokes, faded carnival-tent stripes from the middle; Open Rink, a neon arcade floor
//   - Verity's face painted in the center circle (her expression follows her stage), "JERITY"
//     over it
//   - the shadow of the electrified ceiling mesh real bumper cars run under
//   - checkered start lines in front of each spawn point
//   - wear that spreads as Verity turns: stains, then cracks, then claw scratches
//   - the beveled rubber rail with sockets for render.js's chasing marquee bulbs
// render.js draws the live parts on top: the grid shimmer, spotlight, flicker, bulbs, dashes.
//
//   paintFloor(ctx, { map, pal, c, px })  // ctx scaled to world units with its origin at (0, 0)
//                                         // (paint covers -MARGIN..W+MARGIN); pal: raw [r, g, b, a]
//                                         // colors; c: Verity's corruption 0..1; px: canvas pixels
//                                         // per world unit (for glow sizes)

import { ARENA, SPAWN_POINTS } from '../../shared/constants.js';

const { W, H } = ARENA;
const TAU = Math.PI * 2;

/** The rail: from OUT outside the arena edge to IN inside it; bulbs on the edge, dashes at DASH. */
export const RAIL = { OUT: 6, IN: 13, DASH: 8, BULB_GAP: 25 };
/** How far the floor picture reaches past the arena edge (the rail's outer half and its bulbs). */
export const FLOOR_MARGIN = 14;

/** Marquee bulb positions along the arena edge, clockwise from the top-left corner. */
export const BULBS = (() => {
  const out = [], g = RAIL.BULB_GAP;
  for (let x = 0; x < W; x += g) out.push({ x, y: 0 });
  for (let y = 0; y < H; y += g) out.push({ x: W, y });
  for (let x = W; x > 0; x -= g) out.push({ x, y: H });
  for (let y = H; y > 0; y -= g) out.push({ x: 0, y });
  return out;
})();

/**
 * How render.js draws the live grid and the painted markings over each floor: grid null = no
 * grid (the floor has its own lines); ink = the color of the center circle and spare spawn rings.
 */
export function floorStyle(map, pal) {
  switch (map) {
    case 'tires': return { grid: null, ink: 'rgba(240,240,236,0.3)' };       // white paint on asphalt
    case 'spokes': return { grid: null, ink: css(pal.text, 0.16) };
    case 'open': return { grid: { color: css(neonCyan(pal, 0), 1), alpha: 0.2 }, ink: 'rgba(110,230,255,0.45)' };
    default: return { grid: { color: css(pal.grid, pal.grid[3]), alpha: 0.6 }, ink: css(pal.grid, pal.grid[3]) };
  }
}

/** A few spots where the overhead lights have gone bad (render.js flickers them late in Verity's arc). */
export function flickerSpots(map) {
  const rnd = rng(seedOf(`${map}:flicker`));
  return Array.from({ length: 5 }, () => ({ x: 80 + rnd() * 840, y: 60 + rnd() * 480, r: 50 + rnd() * 70, phase: rnd() * 10 }));
}

export function paintFloor(ctx, { map = 'classic', pal, c = 0, px = 1, startLines: lines = true }) {
  const stage = c < 0.25 ? 0 : c < 0.5 ? 1 : c < 0.75 ? 2 : 3;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip(); // the floor itself stays inside the rail
  (THEMES[map] || THEMES.classic)(ctx, pal, rng(seedOf(map)), c, px);
  meshShadow(ctx, map);
  emblem(ctx, pal, stage, map);
  if (lines) startLines(ctx, map); // off for artwork like the demo thumbnail
  wear(ctx, c, rng(seedOf(`${map}:wear`)));
  ctx.restore();
  rail(ctx, pal);
}

// ---------------------------------------------------------------------------
// Map floors
// ---------------------------------------------------------------------------

const THEMES = {
  /** Classic: a polished wooden rink, staggered planks with grain, light catching the finish. */
  classic(ctx, pal, rnd) {
    const base = mix(pal.floor, [222, 190, 140], 0.32), PH = 30; // the palette's floor, warmed toward maple
    ctx.fillStyle = css(base);
    ctx.fillRect(0, 0, W, H);
    for (let y = 0; y < H; y += PH) {
      let x = -rnd() * 220;
      while (x < W) {
        const len = 170 + rnd() * 170;
        ctx.fillStyle = css(shade(base, (rnd() - 0.5) * 0.13));
        ctx.fillRect(x, y, len, PH);
        ctx.strokeStyle = css(shade(base, -0.3), 0.17);
        ctx.lineWidth = 0.9;
        for (let g = 0; g < 3; g++) { // grain
          const gy = y + 5 + rnd() * (PH - 10), ph = rnd() * 6, amp = 0.6 + rnd();
          ctx.beginPath();
          ctx.moveTo(x, gy);
          for (let gx = x + 16; gx <= x + len; gx += 16) ctx.lineTo(gx, gy + Math.sin(gx * 0.045 + ph) * amp);
          ctx.stroke();
        }
        ctx.fillStyle = css(shade(base, -0.35), 0.4); // butt joint
        ctx.fillRect(x + len - 1, y, 1.5, PH);
        x += len;
      }
      ctx.fillStyle = css(shade(base, -0.35), 0.38); // seam between rows
      ctx.fillRect(0, y + PH - 1, W, 1.5);
    }
    sheen(ctx, [[150, 150, 0.1], [520, 90, 0.07], [770, 60, 0.05]]);
  },

  /** Tire Field: asphalt grit, tar-sealed patches, and old tire tracks swirling around. */
  tires(ctx, pal, rnd) {
    const base = mix(pal.floor, [86, 86, 92], 0.6);
    ctx.fillStyle = css(base);
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 6; i++) { // tar-sealed patches
      const x = rnd() * W, y = rnd() * H, w = 60 + rnd() * 160, h = 30 + rnd() * 90;
      ctx.fillStyle = css(shade(base, -0.25), 0.18);
      ctx.fillRect(x - w / 2, y - h / 2, w, h);
    }
    for (let i = 0; i < 2600; i++) { // grit
      const x = rnd() * W, y = rnd() * H, s = 0.8 + rnd() * 1.6;
      ctx.fillStyle = rnd() < 0.45 ? css(shade(base, 0.35), 0.35) : css(shade(base, -0.45), 0.35);
      ctx.fillRect(x, y, s, s);
    }
    ctx.lineCap = 'round';
    for (let i = 0; i < 10; i++) { // tire tracks: two wheels' worth of rubber per swoop
      const cx = 180 + rnd() * 640, cy = 110 + rnd() * 380, rx = 90 + rnd() * 240, ry = 60 + rnd() * 170;
      const a0 = rnd() * TAU, sweep = 1.3 + rnd() * 2.6, rot = rnd() * Math.PI;
      ctx.strokeStyle = css(shade(base, -0.6), 0.12 + rnd() * 0.06);
      ctx.lineWidth = 5;
      for (const off of [-7, 7]) {
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx + off, ry + off, rot, a0, a0 + sweep);
        ctx.stroke();
      }
    }
    ctx.lineCap = 'butt';
  },

  /** Spokes: faded carnival-tent stripes radiating from the middle, a scalloped valance, canvas weave. */
  spokes(ctx, pal) {
    const base = pal.floor, stripe = mix([214, 64, 69], base, 0.6), cx = W / 2, cy = H / 2, n = 20;
    ctx.fillStyle = css(base);
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = css(stripe, 0.55);
    for (let i = 0; i < n; i += 2) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, 900, (i / n) * TAU, ((i + 1) / n) * TAU);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = css(shade(base, -0.4), 0.05); // canvas weave
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 8) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = 0; y <= H; y += 8) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    ctx.fillStyle = css(stripe, 0.45); // the tent top's scalloped valance, seen from above
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * TAU;
      ctx.beginPath(); ctx.arc(cx + Math.cos(a) * 168, cy + Math.sin(a) * 168, 11, 0, TAU); ctx.fill();
    }
  },

  /** Open Rink: a dark neon arcade floor; glowing lines and rings warm toward red as Verity turns. */
  open(ctx, pal, rnd, c, px) {
    const base = mix([16, 18, 38], pal.floor, 0.12 + c * 0.4);
    ctx.fillStyle = css(base);
    ctx.fillRect(0, 0, W, H);
    for (let x = 0; x < W; x += 100) {
      for (let y = 0; y < H; y += 100) {
        if (((x + y) / 100) % 2) { ctx.fillStyle = css(shade(base, 0.05)); ctx.fillRect(x, y, 100, 100); }
      }
    }
    const pink = mix([255, 70, 200], pal.dash, c * 0.75), cyan = neonCyan(pal, c);
    ctx.save();
    ctx.shadowBlur = 10 * px;
    ctx.shadowColor = css(pink, 0.9);
    ctx.strokeStyle = css(pink, 0.5);
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 100; x < W; x += 200) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = 100; y < H; y += 200) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    ctx.shadowColor = css(cyan, 0.9);
    ctx.strokeStyle = css(cyan, 0.45);
    ctx.lineWidth = 3;
    for (const r of [180, 240]) { ctx.beginPath(); ctx.arc(W / 2, H / 2, r, 0, TAU); ctx.stroke(); }
    for (const [x, y, a] of [[0, 0, 0], [W, 0, Math.PI / 2], [W, H, Math.PI], [0, H, Math.PI * 1.5]]) {
      ctx.beginPath(); ctx.arc(x, y, 120, a, a + Math.PI / 2); ctx.stroke();
    }
    ctx.restore();
  },
};

/** Soft diagonal light bands, as if overhead lights reflect off a polished finish. */
function sheen(ctx, bands) {
  ctx.save();
  ctx.transform(1, 0, -0.55, 1, 0, 0);
  for (const [x0, w, a] of bands) {
    const g = ctx.createLinearGradient(x0, 0, x0 + w, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, `rgba(255,255,255,${a})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x0, 0, w, H);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Overlays: ceiling mesh shadow, Verity's emblem, start lines, wear
// ---------------------------------------------------------------------------

/** The diamond lattice of the electrified ceiling mesh, its shadow falling across the floor. */
function meshShadow(ctx, map) {
  ctx.strokeStyle = map === 'open' ? 'rgba(140,160,255,0.035)' : 'rgba(0,0,0,0.045)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let k = -H; k < W + H; k += 64) {
    ctx.moveTo(k, 0); ctx.lineTo(k + H, H);
    ctx.moveTo(k + H, 0); ctx.lineTo(k, H);
  }
  ctx.stroke();
}

/** Verity's face painted in the center circle, her expression following her stage; JERITY above. */
function emblem(ctx, pal, stage, map) {
  const cx = W / 2, cy = H / 2, neon = map === 'open'; // on the dark neon floor she's painted in light ink
  const ink = neon ? 'rgba(190,235,255,0.55)' : css(pal.text, 0.24);
  ctx.save();
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.strokeStyle = ink;
  ctx.fillStyle = css(mix([246, 185, 59], neon ? [16, 18, 38] : pal.floor, 0.3 + stage * 0.15), neon ? 0.4 : 0.32);
  ctx.beginPath(); ctx.arc(cx, cy, 50, 0, TAU); ctx.fill(); ctx.stroke();

  const eyes = [cx - 17, cx + 17], ey = cy - 10;
  const white = neon ? 'rgba(220,240,255,0.5)' : css(mix([255, 255, 255], pal.floor, 0.35), 0.55);
  ctx.lineWidth = 3;
  for (const ex of eyes) {
    if (stage === 2) { // narrowed: a hard brow over a small eye
      ctx.beginPath(); ctx.moveTo(ex - 10, ey - 8 + (ex < cx ? -3 : 3)); ctx.lineTo(ex + 10, ey - 8 + (ex < cx ? 3 : -3)); ctx.stroke();
      ctx.fillStyle = ink; ctx.beginPath(); ctx.arc(ex, ey + 1, 3.5, 0, TAU); ctx.fill();
      continue;
    }
    ctx.fillStyle = stage === 3 ? ink : white;
    ctx.beginPath(); ctx.arc(ex, ey, 9, 0, TAU); ctx.fill(); ctx.stroke();
    if (stage === 3) { ctx.fillStyle = 'rgba(255,42,58,0.7)'; ctx.beginPath(); ctx.arc(ex, ey + 1, 3, 0, TAU); ctx.fill(); continue; }
    ctx.fillStyle = ink;
    ctx.beginPath(); ctx.arc(ex, ey + (stage === 0 ? -1 : 2), 4, 0, TAU); ctx.fill();
    if (stage === 1) { ctx.beginPath(); ctx.moveTo(ex - 9, ey - 2); ctx.lineTo(ex + 9, ey - 2); ctx.stroke(); } // heavy lids
  }

  ctx.lineWidth = 4;
  ctx.beginPath();
  if (stage === 0) ctx.arc(cx, cy + 6, 24, Math.PI * 0.18, Math.PI * 0.82);       // a smile
  else if (stage === 1) { ctx.moveTo(cx - 18, cy + 24); ctx.lineTo(cx + 18, cy + 24); } // flat
  else if (stage === 2) ctx.arc(cx, cy + 42, 20, Math.PI * 1.22, Math.PI * 1.78);  // a frown
  else { ctx.moveTo(cx - 22, cy + 24); for (let i = 1; i <= 8; i++) ctx.lineTo(cx - 22 + i * 5.5, cy + 24 + (i % 2 ? -6 : 4)); } // jagged
  ctx.stroke();

  ctx.font = "700 30px Fredoka, 'Trebuchet MS', system-ui, sans-serif";
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = neon ? 'rgba(150,230,255,0.5)' : css(pal.text, 0.22);
  const word = 'JERITY';
  [...word].forEach((ch, i) => { // along the top of the band between the circle and the ring
    const a = -Math.PI / 2 + (i - (word.length - 1) / 2) * 0.2;
    ctx.save();
    ctx.translate(cx + Math.cos(a) * 95, cy + Math.sin(a) * 95);
    ctx.rotate(a + Math.PI / 2);
    ctx.fillText(ch, 0, 0);
    ctx.restore();
  });
  ctx.restore();
}

/**
 * A checkered start line just in front of each spawn point, square to the drive to the center:
 * 3 rows deep, 9 squares across, nearly solid, with a thin dark edge so it reads from afar.
 */
function startLines(ctx, map) {
  const [a, b] = map === 'open' ? ['rgba(255,255,255,0.82)', 'rgba(90,225,255,0.6)'] : ['rgba(255,255,255,0.88)', 'rgba(20,18,24,0.8)'];
  const S = 7, ROWS = 3, COLS = 9, w = ROWS * S, h = COLS * S;
  for (const s of SPAWN_POINTS) {
    const ang = Math.atan2(H / 2 - s.y, W / 2 - s.x);
    ctx.save();
    ctx.translate(s.x + Math.cos(ang) * 44, s.y + Math.sin(ang) * 44); // clear of the 22-unit spawn ring
    ctx.rotate(ang);
    for (let i = 0; i < ROWS; i++) {
      for (let j = 0; j < COLS; j++) { ctx.fillStyle = (i + j) % 2 ? a : b; ctx.fillRect(i * S - w / 2, j * S - h / 2, S, S); }
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }
}

/**
 * Wear that spreads as Verity turns: stains from 20%, cracks from 45%, claw scratches from 72%.
 * The layout is generated in full every time (same seed), so it only grows, never jumps around.
 */
function wear(ctx, c, rnd) {
  const stains = Array.from({ length: 16 }, () => ({ x: rnd() * W, y: rnd() * H, r: 16 + rnd() * 46, red: rnd() }));
  const cracks = Array.from({ length: 10 }, () => crack(rnd));
  const scratches = Array.from({ length: 6 }, () => ({ x: 80 + rnd() * 840, y: 60 + rnd() * 480, a: rnd() * Math.PI, len: 40 + rnd() * 50 }));
  const k1 = clamp01((c - 0.2) / 0.5), k2 = clamp01((c - 0.45) / 0.4), k3 = clamp01((c - 0.72) / 0.28);

  for (const s of stains.slice(0, Math.round(stains.length * k1))) {
    const tint = s.red > 0.55 && c > 0.6 ? [110, 20, 18] : [24, 16, 14];
    const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r);
    g.addColorStop(0, css(tint, 0.12 + 0.12 * k1));
    g.addColorStop(0.7, css(tint, 0.08 * k1));
    g.addColorStop(1, css(tint, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, TAU); ctx.fill();
  }

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const k of cracks.slice(0, Math.round(cracks.length * k2))) {
    for (const [color, width, off] of [['rgba(255,255,255,0.12)', 0.8, 0.9], ['rgba(10,6,6,0.5)', 1.6, 0]]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      k.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x + off, y + off) : ctx.moveTo(x + off, y + off)));
      for (const b of k.branches) {
        let [x, y] = k.pts[b.from], a = b.a;
        ctx.moveTo(x + off, y + off);
        for (const [step, turn] of b.steps) { a += turn; x += Math.cos(a) * step; y += Math.sin(a) * step; ctx.lineTo(x + off, y + off); }
      }
      ctx.stroke();
    }
  }

  ctx.strokeStyle = 'rgba(12,8,8,0.35)';
  ctx.lineWidth = 1.4;
  for (const s of scratches.slice(0, Math.round(scratches.length * k3))) {
    const nx = Math.cos(s.a + Math.PI / 2) * 6, ny = Math.sin(s.a + Math.PI / 2) * 6;
    ctx.beginPath();
    for (let i = -1; i <= 1; i++) {
      ctx.moveTo(s.x + nx * i, s.y + ny * i);
      ctx.lineTo(s.x + nx * i + Math.cos(s.a) * s.len, s.y + ny * i + Math.sin(s.a) * s.len);
    }
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
}

function crack(rnd) {
  let x = 60 + rnd() * 880, y = 40 + rnd() * 520, a = rnd() * TAU;
  const pts = [[x, y]], branches = [], n = 6 + Math.floor(rnd() * 7);
  for (let i = 0; i < n; i++) {
    a += (rnd() - 0.5) * 1.1;
    const step = 8 + rnd() * 14;
    x += Math.cos(a) * step;
    y += Math.sin(a) * step;
    pts.push([x, y]);
    const branch = rnd() < 0.25, side = rnd() < 0.5 ? 1 : -1, spread = 0.6 + rnd() * 0.6;
    const steps = Array.from({ length: 3 }, () => [6 + rnd() * 9, (rnd() - 0.5) * 0.9]);
    if (branch) branches.push({ from: pts.length - 1, a: a + side * spread, steps });
  }
  return { pts, branches };
}

// ---------------------------------------------------------------------------
// The rail
// ---------------------------------------------------------------------------

/** The rubber rail around the rink: beveled, casting a soft shadow inward, with bulb sockets. */
function rail(ctx, pal) {
  const { OUT, IN } = RAIL, sh = 16;
  const fade = (x0, y0, x1, y1) => {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, 'rgba(0,0,0,0.22)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    return g;
  };
  ctx.fillStyle = fade(0, IN, 0, IN + sh); ctx.fillRect(IN, IN, W - 2 * IN, sh);
  ctx.fillStyle = fade(0, H - IN, 0, H - IN - sh); ctx.fillRect(IN, H - IN - sh, W - 2 * IN, sh);
  ctx.fillStyle = fade(IN, 0, IN + sh, 0); ctx.fillRect(IN, IN, sh, H - 2 * IN);
  ctx.fillStyle = fade(W - IN, 0, W - IN - sh, 0); ctx.fillRect(W - IN - sh, IN, sh, H - 2 * IN);

  ctx.fillStyle = css(pal.wall);
  ctx.beginPath();
  ctx.rect(-OUT, -OUT, W + 2 * OUT, H + 2 * OUT);
  ctx.rect(IN, IN, W - 2 * IN, H - 2 * IN);
  ctx.fill('evenodd');
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = css(shade(pal.wall, 0.4), 0.7); // highlight along the top inner edge
  ctx.strokeRect(IN - 1, IN - 1, W - 2 * IN + 2, H - 2 * IN + 2);
  ctx.strokeStyle = css(shade(pal.wall, -0.5), 0.9); // dark outer lip
  ctx.strokeRect(-OUT + 0.8, -OUT + 0.8, W + 2 * OUT - 1.6, H + 2 * OUT - 1.6);
  ctx.lineWidth = 5;
  ctx.strokeStyle = css(shade(pal.wall, -0.35), 0.8); // the groove the bulbs sit in
  ctx.strokeRect(0, 0, W, H);
  ctx.fillStyle = css(shade(pal.wall, -0.55));
  for (const b of BULBS) { ctx.beginPath(); ctx.arc(b.x, b.y, 3.4, 0, TAU); ctx.fill(); }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function css([r, g, b], a = 1) { return `rgba(${r | 0},${g | 0},${b | 0},${a})`; }
function mix(a, b, k) { return [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * k); }
/** Lighter (k > 0) or darker (k < 0). */
function shade(rgb, k) { return k < 0 ? mix(rgb, [0, 0, 0], -k) : mix(rgb, [255, 255, 255], k); }
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function neonCyan(pal, c) { return mix([70, 225, 255], pal.dash, c * 0.75); }

/** Small seeded random numbers (mulberry32), so each map's floor looks the same every time. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedOf(text) { return [...text].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619), 2166136261); }
