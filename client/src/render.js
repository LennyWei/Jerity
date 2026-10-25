// client/src/render.js
// Draws the arena, cars, HP bars, effects and (on phones) the HUD.
// Shared with the spectator page: createRenderer(canvas, { showHud: false }) also draws
// names, a live leaderboard from `sc`, and a kill feed. Person 2 owns this file.
//
//   const r = createRenderer(canvas, { showHud: true });
//   r.setPlayers(lobby.players);
//   r.setMe(playerId);
//   // each frame:
//   r.addEvents(interp.takeEvents(), view);
//   r.draw(view, performance.now(), { tilt, countdown, flip, banner, danger });

import { ARENA, CAR_SIZE, OBSTACLES, MAPS, DEFAULT_MAP, SPAWN_POINTS, SCALE, CARS, DEFAULT_CAR, PLAYER_COLORS } from '../../shared/constants.js';
import { drawBumperCar, drawFlippedCar, drawObstacle } from './art.js';
import { paintFloor, floorStyle, flickerSpots, BULBS, RAIL, FLOOR_MARGIN } from './floor.js';
import { CAR_STATE, EVENT, BUFF, HIT_KIND } from '../../shared/protocol.js';
import { CONFIG } from '../../shared/config.js';

const FX_SCALE = { full: 1, low: 0.4, off: 0 };
const MAX_PARTICLES = 250;
const MAX_DEBRIS = 180; // KO fragments kept on the floor for the round
const MAX_SMOKE = 140;

// Arena palettes as [r, g, b, a]. Without opts.corrupt the renderer keeps the original dark look;
// with it (the Verity theme) colors blend from a cheerful cream play-mat to a dead black-and-red pit.
const PAL_DARK = {
  bg: [11, 13, 18, 1], floor: [26, 30, 40, 1], grid: [255, 255, 255, 0.045], wall: [43, 50, 66, 1],
  dash: [255, 210, 63, 0.33], pillarA: [90, 100, 124, 1], pillarB: [42, 48, 64, 1], pillarEdge: [255, 90, 95, 1],
  me: [255, 255, 255, 1], text: [232, 236, 244, 1],
};
const PAL_CHEER = {
  bg: [216, 206, 180, 1], floor: [239, 231, 210, 1], grid: [43, 39, 51, 0.08], wall: [43, 39, 51, 1],
  dash: [246, 185, 59, 0.95], pillarA: [110, 214, 198, 1], pillarB: [31, 158, 143, 1], pillarEdge: [43, 39, 51, 1],
  me: [43, 39, 51, 1], text: [43, 39, 51, 1],
};
// Dark and red, but light enough that the floor, walls and pillars still read against the surround.
const PAL_DEAD = {
  bg: [24, 15, 14, 1], floor: [48, 29, 27, 1], grid: [220, 60, 60, 0.1], wall: [92, 46, 41, 1],
  dash: [200, 40, 50, 0.65], pillarA: [96, 64, 60, 1], pillarB: [54, 34, 32, 1], pillarEdge: [170, 40, 48, 1],
  me: [236, 214, 206, 1], text: [230, 211, 200, 1],
};
const rgba = ([r, g, b, a]) => `rgba(${r | 0},${g | 0},${b | 0},${a.toFixed(3)})`;
const toCss = (pal) => Object.fromEntries(Object.entries(pal).map(([k, v]) => [k, rgba(v)]));
const DARK_CSS = { ...toCss(PAL_DARK), raw: PAL_DARK, scan: 0, bleed: 0 };
const themeCache = new Map();
/** Verity theme colors at corruption c (0..1), cached per 1% step. */
function themePalette(c) {
  const step = Math.round(Math.max(0, Math.min(1, c)) * 100);
  if (!themeCache.has(step)) {
    const t = step / 100, k = t * t * (3 - 2 * t); // ease: lingers cheerful, then turns
    const mixed = {};
    for (const key of Object.keys(PAL_CHEER)) mixed[key] = PAL_CHEER[key].map((v, i) => v + (PAL_DEAD[key][i] - v) * k);
    themeCache.set(step, { ...toCss(mixed), raw: mixed, scan: 0.05 + t * 0.16, bleed: t * 0.5 }); // raw: for floor.js
  }
  return themeCache.get(step);
}

export function createRenderer(canvas, opts = {}) {
  const showHud = opts.showHud ?? true;
  const showNames = opts.names ?? !showHud;
  const showBoard = opts.board ?? !showHud;
  let fx = FX_SCALE[opts.fx] ?? 1;
  const showFps = !!opts.fps;
  const themed = typeof opts.corrupt === 'function'; // Verity theme
  let obstacles = MAPS[DEFAULT_MAP]?.obstacles ?? OBSTACLES;
  let mapId = DEFAULT_MAP;
  let floor = null;        // floor.js picture: { key, canvas }, repainted when the map, palette step or size changes
  let spots = flickerSpots(mapId);
  let fontGen = 0;         // bumps when the emblem's font arrives, so the floor repaints with it
  document.fonts?.load?.("700 30px Fredoka").then(() => { fontGen++; }, () => {});
  const obstacleHitAt = new Map(); // obstacle index -> time it was last hit (flash + wobble)
  const motion = new Map();        // car id -> { x, y, a, t, speed (m/s), turn (rad/s), squashAt, steer }
  const skids = [];                // tire marks: { x1, y1, x2, y2, life }
  let freezeUntil = 0, frozenView = null; // hit-stop on big hits involving you
  let pal = DARK_CSS;
  let scanPattern = null; // CRT scanlines: one dark row every 3 px
  let bleedKey = '', bleedGrad = null;
  const ctx = canvas.getContext('2d');

  let dpr = 1, cssW = 0, cssH = 0, scale = 1, ox = 0, oy = 0;
  let ui = 1; // HUD size multiplier: phones get bigger, arm's-length-readable controls
  let me = null;
  let players = new Map(); // id -> { name, color, maxHp }
  const seenMaxHp = new Map();

  const particles = [];
  const texts = [];
  const rings = [];
  let shake = 0;
  let flash = 0;          // 0..1 red vignette on own damage
  let flashWhite = 0;     // 0..1 full-screen white flash on a head-on
  let lastNow = 0;
  let fpsAvg = 60;
  let banner = null;      // { text, color, life, max } big center message (KO, CONCUSSED)
  const feed = [];        // kill feed for the spectator board: { text, life }
  const toasts = [];      // phone: "You hit Bot 2 · REAR -32", { text, color, life }
  const carFlash = new Map(); // id -> time of last hit, flashes the car white
  const debris = [];      // KO fragments: { x, y, vx, vy, a, va, w, h, color, heat (1 = white-hot), shard }
  const scars = [];       // scorch marks where cars were knocked out: { x, y, r, blots, born }
  const scarred = new Set(); // car ids with a scorch mark
  const deadSince = new Map(); // car id -> when we first saw it dead (a KO we never saw still gets a mark)
  const blasts = [];      // KO fireballs: { x, y, life, max }
  const smoke = [];       // exhaust puffs: { x, y, vx, vy, r0, r1, life, max, dark }
  const dust = [];        // specks drifting over the floor in two layers (near ones faster: parallax)
  let lastTimeLeft = Infinity; // the round timer jumping back up = a new round: clear the marks
  let winnerId = null;    // the victory lap's winner: a gold ring and a crown

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    cssW = canvas.clientWidth || window.innerWidth;
    cssH = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    // Letterbox the 1000 x 600 world, leaving a little margin for the walls.
    const pad = showHud ? 6 : 16;
    scale = Math.min((cssW - pad * 2) / ARENA.W, (cssH - pad * 2) / ARENA.H);
    ox = (cssW - ARENA.W * scale) / 2;
    oy = (cssH - ARENA.H * scale) / 2;
    ui = showHud ? Math.max(1.2, Math.min(1.6, cssH / 270)) : 1; // 390 px tall (sideways phone): 1.44
  }
  resize();
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(canvas); else window.addEventListener('resize', resize);

  // -------------------------------------------------------------------------
  // Players and colors
  // -------------------------------------------------------------------------

  function setPlayers(list = []) {
    players = new Map();
    list.forEach((p, i) => {
      players.set(p.id, {
        name: p.name,
        color: PLAYER_COLORS[(p.color ?? i) % PLAYER_COLORS.length],
        maxHp: CARS[p.car || DEFAULT_CAR]?.hp,
      });
    });
  }

  const nameOf = (id) => players.get(id)?.name || 'Bot';

  function colorOf(id) {
    const p = players.get(id);
    if (p) return p.color;
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return PLAYER_COLORS[Math.abs(h) % PLAYER_COLORS.length];
  }

  function maxHpOf(car) {
    const known = players.get(car.id)?.maxHp;
    if (known) return known;
    const seen = Math.max(seenMaxHp.get(car.id) || 0, car.hp);
    seenMaxHp.set(car.id, seen);
    return seen || 100;
  }

  // -------------------------------------------------------------------------
  // Effects from events
  // -------------------------------------------------------------------------

  function addEvents(events, view) {
    if (!events?.length) return;
    const pos = new Map((view?.cars || []).map((c) => [c.id, c]));
    // Impact feel: cars squash, obstacles wobble, big hits on you freeze the frame for a moment.
    const squash = (id) => { const m = motion.get(id); if (m) m.squashAt = lastNow; };
    for (const e of events) {
      if (e.type === EVENT.HIT) {
        squash(e.victim); squash(e.attacker);
        if ((e.victim === me || e.attacker === me) && e.dmg >= 20) freezeUntil = lastNow + 70;
      } else if (e.type === EVENT.HEADON) {
        squash(e.a); squash(e.b);
        if (e.a === me || e.b === me) freezeUntil = lastNow + 90;
      } else if (e.type === EVENT.WALL) {
        squash(e.id);
        markObstacle(pos.get(e.id));
      } else if (e.type === EVENT.KILL && (e.victim === me || e.attacker === me)) {
        freezeUntil = lastNow + 110;
      }
    }
    for (const e of events) {
      switch (e.type) {
        case EVENT.HIT: {
          const v = pos.get(e.victim), a = pos.get(e.attacker);
          if (!v) break;
          const x = a ? (a.x + v.x) / 2 : v.x, y = a ? (a.y + v.y) / 2 : v.y;
          const dmg = Math.round(e.dmg || 0), rear = e.kind === HIT_KIND.REAR;
          const label = rear ? 'REAR' : 'SIDE';
          // Sparks spray on through the victim along the blow, and grind off both sides.
          const blow = a ? Math.atan2(v.y - a.y, v.x - a.x) : Math.random() * Math.PI * 2;
          const n = (6 + Math.min(24, dmg * 0.6)) * (rear ? 1.6 : 1), hot = ['#fff3b0', '#ffd23f', '#ff9f43'];
          sparkSpray(x, y, blow, 1.1, n * 0.6, hot, (rear ? 340 : 260) * 1.3);
          sparkSpray(x, y, blow + Math.PI / 2, 0.7, n * 0.25, hot, rear ? 300 : 230);
          sparkSpray(x, y, blow - Math.PI / 2, 0.7, n * 0.25, hot, rear ? 300 : 230);
          if (dmg >= 1) floatText(v.x, v.y - 20, `${label} -${dmg}`, rear ? '#ff3b3b' : '#ff6b6b', (14 + Math.min(16, dmg * 0.4)) * (rear ? 1.25 : 1));
          carFlash.set(e.victim, lastNow);
          if (e.victim === me) { hurt(3 + dmg * 0.4, 40 + dmg * 2); toast(`${nameOf(e.attacker)} hit you · ${label} -${dmg}`, '#ff6b6b'); }
          else if (e.attacker === me) { shake = Math.max(shake, 2); toast(`You hit ${nameOf(e.victim)} · ${label} -${dmg}`, '#5ce1a0'); }
          break;
        }
        case EVENT.HEADON: {
          const a = pos.get(e.a), b = pos.get(e.b);
          if (!a || !b) break;
          const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
          rings.push({ x, y, r0: 10, r1: 120, life: 0, max: 450, color: '#ffffff' });
          const axis = Math.atan2(b.y - a.y, b.x - a.x); // noses meet: sparks squirt out sideways
          sparkSpray(x, y, axis + Math.PI / 2, 0.9, 18, ['#ffffff', '#c8d6ff', '#ffd23f'], 420);
          sparkSpray(x, y, axis - Math.PI / 2, 0.9, 18, ['#ffffff', '#c8d6ff', '#ffd23f'], 420);
          // Each car shows what it took (dmgA/dmgB: the faster car hits harder); older servers send dmg only.
          for (const [c, dmg] of [[a, e.dmgA ?? e.dmg], [b, e.dmgB ?? e.dmg]]) {
            if (dmg >= 1) floatText(c.x, c.y - 20, `-${Math.round(dmg)}`, '#ff6b6b', 16);
            floatText(c.x, c.y - 44, 'CONCUSSED', '#c8d6ff', 15);
          }
          carFlash.set(e.a, lastNow);
          carFlash.set(e.b, lastNow);
          if (e.a === me || e.b === me) {
            hurt(10, 120);
            flashWhite = 1;
            showBanner('CONCUSSED', '#c8d6ff');
            const meA = e.a === me;
            const took = Math.round((meA ? e.dmgA : e.dmgB) ?? e.dmg ?? 0);
            const dealt = Math.round((meA ? e.dmgB : e.dmgA) ?? e.dmg ?? 0);
            toast(`Head-on with ${nameOf(meA ? e.b : e.a)} · you -${took}, them -${dealt}`, '#c8d6ff');
          }
          break;
        }
        case EVENT.WALL: {
          const c = pos.get(e.id);
          if (!c) break;
          sparkSpray(c.x, c.y, c.a + Math.PI, 1.8, 8, ['#c8cfdc', '#ffd23f', '#ffffff'], 180); // scraped off the bumper
          if (e.dmg >= 1) {
            floatText(c.x, c.y - 20, `-${Math.round(e.dmg)}`, '#ff6b6b', 13);
            if (e.id === me) hurt(3, 30);
          }
          break;
        }
        case EVENT.FLIP: {
          const c = pos.get(e.id);
          if (!c) break;
          rings.push({ x: c.x, y: c.y, r0: 10, r1: 60, life: 0, max: 400, color: '#ff9f43' });
          floatText(c.x, c.y - 26, 'FLIPPED!', '#ff9f43', 16);
          if (e.id === me) shake = Math.max(shake, 8);
          break;
        }
        case EVENT.RECOVER: {
          const c = pos.get(e.id);
          if (!c) break;
          rings.push({ x: c.x, y: c.y, r0: 20, r1: 70, life: 0, max: 450, color: '#5ce1a0' });
          floatText(c.x, c.y - 26, 'BACK!', '#5ce1a0', 15);
          break;
        }
        case EVENT.KILL: {
          const c = pos.get(e.victim), k = pos.get(e.attacker);
          if (c) {
            explode(c, k);
            floatText(c.x, c.y - 30, 'KO', '#ffffff', 26);
          }
          if (k && e.heal >= 1) floatText(k.x, k.y - 44, `+${Math.round(e.heal)} HEAL`, '#5ce1a0', 16);
          const buff = e.buff === BUFF.BOOST ? ' · BOOST' : e.buff === BUFF.SHIELD ? ' · SHIELD' : '';
          if (e.victim === me) { hurt(16, 200); showBanner(e.attacker ? `KO'd by ${nameOf(e.attacker)}` : 'KO', '#ff5a5f'); }
          else if (e.attacker === me) showBanner(`KO! +${Math.round(e.heal || 0)} HP${buff}`, '#ffd23f');
          feed.unshift({ text: e.attacker ? `${nameOf(e.attacker)} KO'd ${nameOf(e.victim)}` : `${nameOf(e.victim)} crashed out`, life: 0 });
          feed.length = Math.min(feed.length, 5);
          break;
        }
      }
    }
  }

  function showBanner(text, color) {
    banner = { text, color, life: 0, max: 1600 };
  }

  function toast(text, color) {
    if (!showHud) return;
    toasts.unshift({ text, color, life: 0 });
    toasts.length = Math.min(toasts.length, 3);
  }

  function hurt(amount, vibrateMs) {
    if (!showHud) return; // spectator screen never shakes
    shake = Math.max(shake, Math.min(16, amount));
    flash = Math.min(1, flash + 0.35 + amount * 0.03);
    try { navigator.vibrate?.(Math.round(vibrateMs)); } catch { /* iOS: no vibrate */ }
  }

  function sparks(x, y, n, colors, speed) {
    const count = Math.round(n * fx);
    for (let i = 0; i < count && particles.length < MAX_PARTICLES; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = speed * (0.3 + Math.random() * 0.7);
      particles.push({
        x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
        life: 0, max: 250 + Math.random() * 300,
        color: colors[(Math.random() * colors.length) | 0],
        size: 2 + Math.random() * 3,
      });
    }
  }

  function floatText(x, y, text, color, size) {
    if (fx === 0 && text[0] !== '-') return; // with effects off, keep only damage numbers
    texts.push({ x, y, text, color, size, life: 0, max: 900 });
  }

  /** A car bumped a wall or obstacle: if it was an obstacle, make that one flash and wobble. */
  function markObstacle(c) {
    if (!c) return;
    let best = -1, bestD = 30;
    obstacles.forEach((o, i) => {
      let d;
      if (o.kind === 'box') { // distance to the rotated barrier
        const dx = c.x - o.x, dy = c.y - o.y, ca = Math.cos(-o.a), sa = Math.sin(-o.a);
        const lx = Math.abs(dx * ca - dy * sa) - o.w / 2, ly = Math.abs(dx * sa + dy * ca) - o.h / 2;
        d = Math.hypot(Math.max(lx, 0), Math.max(ly, 0));
      } else d = Math.hypot(c.x - o.x, c.y - o.y) - o.r;
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best >= 0) {
      obstacleHitAt.set(best, lastNow);
      const o = obstacles[best];
      sparks((c.x + o.x) / 2, (c.y + o.y) / 2, 8, ['#c8cfdc', '#f6b93b', '#ffffff'], 160);
    }
  }

  function stepEffects(dt) {
    for (let i = skids.length - 1; i >= 0; i--) if ((skids[i].life -= dt) <= 0) skids.splice(i, 1);
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dt;
      if (p.life >= p.max) { particles.splice(i, 1); continue; }
      const k = Math.exp(-dt / 160);
      p.vx *= k; p.vy *= k;
      p.x += p.vx * dt / 1000; p.y += p.vy * dt / 1000;
    }
    for (const list of [texts, rings, blasts]) {
      for (let i = list.length - 1; i >= 0; i--) {
        list[i].life += dt;
        if (list[i].life >= list[i].max) list.splice(i, 1);
      }
    }
    for (const d of debris) { // KO pieces skid to a stop off the walls and cool down
      if (d.vx || d.vy) {
        const k = Math.exp(-dt / 280);
        d.vx *= k; d.vy *= k; d.va *= k;
        d.x += d.vx * dt / 1000; d.y += d.vy * dt / 1000; d.a += d.va * dt / 1000;
        if (d.x < 10 || d.x > ARENA.W - 10) { d.vx *= -0.4; d.x = Math.max(10, Math.min(ARENA.W - 10, d.x)); }
        if (d.y < 10 || d.y > ARENA.H - 10) { d.vy *= -0.4; d.y = Math.max(10, Math.min(ARENA.H - 10, d.y)); }
        if (Math.abs(d.vx) + Math.abs(d.vy) < 3) d.vx = d.vy = d.va = 0;
      }
      if (d.heat > 0) d.heat = Math.max(0, d.heat - dt / 1700);
    }
    for (let i = smoke.length - 1; i >= 0; i--) {
      const s = smoke[i];
      if ((s.life += dt) >= s.max) { smoke.splice(i, 1); continue; }
      s.x += s.vx * dt / 1000; s.y += s.vy * dt / 1000;
    }
    for (const d of dust) { // drift and wrap around the arena
      d.x += d.vx * dt / 1000; d.y += d.vy * dt / 1000;
      if (d.x > ARENA.W + 8) d.x -= ARENA.W + 16;
      if (d.y > ARENA.H + 8) d.y -= ARENA.H + 16;
    }
    shake *= Math.exp(-dt / 90);
    if (shake < 0.2) shake = 0;
    flash *= Math.exp(-dt / 220);
    flashWhite *= Math.exp(-dt / 120);
    if (banner && (banner.life += dt) >= banner.max) banner = null;
    for (let i = feed.length - 1; i >= 0; i--) if ((feed[i].life += dt) > 8000) feed.splice(i, 1);
    for (let i = toasts.length - 1; i >= 0; i--) if ((toasts[i].life += dt) > 2200) toasts.splice(i, 1);
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  /**
   * view: interp.sample() result or null (arena only).
   * hud:  { tilt, countdown, flip: { taps, shakes } | null, banner }  (ignored when showHud is false)
   */
  function draw(view, now = performance.now(), hud = {}) {
    const dt = lastNow ? Math.min(100, now - lastNow) : 16;
    lastNow = now;
    fpsAvg += (1000 / Math.max(1, dt) - fpsAvg) * 0.05;
    stepEffects(dt);
    pal = themed ? themePalette(opts.corrupt()) : DARK_CSS;
    if (view && typeof view.timeLeft === 'number') { // timer back up = a new round (spectator): fresh floor
      if (view.timeLeft > lastTimeLeft + 2) clearRoundMarks();
      lastTimeLeft = view.timeLeft;
    }
    if (view && now < freezeUntil && frozenView) view = frozenView; // hit-stop: hold the frame
    else { frozenView = view; if (view) trackMotion(view.cars, now); }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawSurround();

    // World space
    const sx = shake ? (Math.random() * 2 - 1) * shake : 0;
    const sy = shake ? (Math.random() * 2 - 1) * shake : 0;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (ox + sx), dpr * (oy + sy));
    drawArena(view?.obstaclesDisabled, view?.timeLeft); // once (a merge had left a second, flag-less call)
    const cars = view?.cars || [];
    markMissedKos(cars, now);
    drawScars();
    drawSkids();
    drawDebris();
    drawSmoke();

    const order = [...cars].sort((a, b) => rank(a) - rank(b));
    if (showHud) drawAim(cars);
    for (const c of order) if (c.s !== CAR_STATE.DEAD) drawCarShadow(c);
    for (const c of order) drawCar(c, now);
    for (const c of order) if (c.s !== CAR_STATE.DEAD) drawHpBar(c);
    drawWinner(cars, now);
    drawEffects();

    // Screen space (CSS pixels)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (themed) drawCrt();
    if (flash > 0.02) drawFlash();
    if (flashWhite > 0.02) { ctx.fillStyle = `rgba(255,255,255,${(flashWhite * 0.7).toFixed(3)})`; ctx.fillRect(0, 0, cssW, cssH); }
    if (showHud) drawRoster(cars);
    if (showHud) drawHud(view, cars, hud, now);
    if (showHud) drawYouMarker(cars, now); // on top of everything, the countdown dimming included
    if (showBoard) drawBoard(cars);
    if (showFps) {
      ctx.fillStyle = '#7f8aa3';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`${Math.round(fpsAvg)} fps`, 8, cssH - 8);
    }
  }

  /** Per-car speed and turn rate from frame to frame: drives skid marks, speed streaks, the wheel. */
  function trackMotion(cars, now) {
    const W = CAR_SIZE.W, H = CAR_SIZE.H;
    const rear = (x, y, a, side) => [x - Math.cos(a) * (W / 2 - 5) - Math.sin(a) * side * (H / 2 - 3),
      y - Math.sin(a) * (W / 2 - 5) + Math.cos(a) * side * (H / 2 - 3)];
    for (const c of cars) {
      const m = motion.get(c.id);
      if (!m) { motion.set(c.id, { x: c.x, y: c.y, a: c.a, t: now, speed: 0, turn: 0, squashAt: -1e9, steer: 0 }); continue; }
      const dt = (now - m.t) / 1000;
      if (dt <= 0) continue;
      let da = c.a - m.a;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      m.speed += (Math.hypot(c.x - m.x, c.y - m.y) / SCALE / dt - m.speed) * 0.3;
      m.turn += (da / dt - m.turn) * 0.3;
      m.steer = Math.max(-1, Math.min(1, m.turn / 3));
      if (c.s === CAR_STATE.ALIVE && Math.abs(m.turn) > 2.2 && m.speed > 7 && skids.length < 400) {
        for (const side of [-1, 1]) {
          const [x1, y1] = rear(m.x, m.y, m.a, side), [x2, y2] = rear(c.x, c.y, c.a, side);
          skids.push({ x1, y1, x2, y2, life: 2500 });
        }
      }
      // Exhaust puffs out the back, more the faster it goes; under 30% HP, dark heavy smoke.
      if (fx > 0 && c.s === CAR_STATE.ALIVE && m.speed > 1.5) {
        const wrecked = c.hp / maxHpOf(c) < 0.3;
        m.puff = (m.puff || 0) + dt * fx * (wrecked ? 22 : 4 + m.speed * 0.6);
        while (m.puff >= 1 && smoke.length < MAX_SMOKE) {
          m.puff -= 1;
          const bx = c.x - Math.cos(c.a) * (W / 2 + 4), by = c.y - Math.sin(c.a) * (W / 2 + 4);
          smoke.push({
            x: bx + (Math.random() - 0.5) * 6, y: by + (Math.random() - 0.5) * 6,
            vx: -Math.cos(c.a) * 18 + (Math.random() - 0.5) * 16, vy: -Math.sin(c.a) * 18 + (Math.random() - 0.5) * 16,
            r0: 3, r1: wrecked ? 17 : 10, life: 0, max: wrecked ? 1100 : 650, dark: wrecked,
          });
        }
        if (m.puff > 2) m.puff = 0; // the list is full: no backlog
      }
      m.x = c.x; m.y = c.y; m.a = c.a; m.t = now;
    }
  }

  function drawSkids() {
    if (!skids.length) return;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (const s of skids) {
      ctx.strokeStyle = `rgba(20,16,20,${(0.32 * s.life / 2500).toFixed(3)})`;
      ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  function rank(c) {
    if (c.s === CAR_STATE.DEAD) return 0;
    if (c.id === me) return 3;
    return c.s === CAR_STATE.FLIPPED ? 1 : 2;
  }

  /** Victory lap: a pulsing gold ring around the round's winner and a crown over the car. */
  function drawWinner(cars, now) {
    const c = winnerId && cars.find((x) => x.id === winnerId);
    if (!c || c.s === CAR_STATE.DEAD) return;
    const pulse = 1 + Math.sin(now / 180) * 0.08;
    ctx.save();
    glow('#f6b93b', 14);
    ctx.strokeStyle = '#f6b93b';
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(c.x, c.y, 34 * pulse, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(c.x, c.y, 45 * pulse, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
    const x = c.x, y = c.y - 52 + Math.sin(now / 240) * 2; // the crown bobs above the HP bar
    ctx.fillStyle = '#f6b93b';
    ctx.beginPath();
    ctx.moveTo(x - 13, y + 7); ctx.lineTo(x - 13, y - 5); ctx.lineTo(x - 6.5, y + 1); ctx.lineTo(x, y - 9);
    ctx.lineTo(x + 6.5, y + 1); ctx.lineTo(x + 13, y - 5); ctx.lineTo(x + 13, y + 7); ctx.closePath();
    ctx.fill();
    noGlow();
    ctx.strokeStyle = '#8a5a0c';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  /** Phone: a bobbing "YOU" tag with an arrow over your car (under it near the top wall). */
  function drawYouMarker(cars, now) {
    const mine = cars.find((c) => c.id === me);
    if (!mine || mine.s === CAR_STATE.DEAD || winnerId === me) return; // the winner wears the crown instead
    const sx = ox + mine.x * scale, sy = oy + mine.y * scale;
    const bob = Math.sin(now / 200) * 3 * ui;
    const aw = 8 * ui, ah = 9 * ui, th = 20 * ui;
    const above = sy - 40 * scale - ah - th - 4 > 0;
    const dir = above ? 1 : -1; // the arrow points down at the car, or up at it from below
    const tipY = above ? sy - 40 * scale - 2 + bob : sy + 40 * scale + 2 - bob;
    const color = colorOf(me);
    ctx.save();
    ctx.font = `900 ${12 * ui}px system-ui, sans-serif`;
    const tw = ctx.measureText('YOU').width + 16 * ui, ly = tipY - dir * (ah + th / 2 - 1);
    glow(color, 12);
    ctx.fillStyle = color;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx, tipY); ctx.lineTo(sx - aw, tipY - dir * ah); ctx.lineTo(sx + aw, tipY - dir * ah); ctx.closePath();
    ctx.fill(); ctx.stroke();
    roundRect(sx - tw / 2, ly - th / 2, tw, th, th / 2);
    ctx.fill(); ctx.stroke();
    noGlow();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; // white on any paint color
    ctx.strokeText('YOU', sx, ly + 1);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('YOU', sx, ly + 1);
    ctx.restore();
  }

  /** A soft shadow under a car, as if lit from the top left: it lifts the cars off the floor. */
  function drawCarShadow(c) {
    const W = CAR_SIZE.W, H = CAR_SIZE.H;
    ctx.save();
    ctx.translate(c.x + 3, c.y + 5);
    ctx.rotate(c.a);
    if (c.s === CAR_STATE.DISCONNECTED) ctx.globalAlpha = 0.3;
    ctx.fillStyle = 'rgba(0,0,0,0.14)';
    roundRect(-W / 2 - 7, -H / 2 - 7, W + 14, H + 14, (H + 14) / 2); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    roundRect(-W / 2 - 3, -H / 2 - 3, W + 6, H + 6, (H + 6) / 2); ctx.fill();
    ctx.restore();
  }

  /**
   * A knockout: the car shatters into glowing pieces of its paint that skid to a stop (mostly
   * on along the blow), a red fireball and a shockwave go off, the screen kicks, and a scorch
   * mark stays on the floor for the rest of the round.
   */
  function explode(c, killer) {
    const color = colorOf(c.id);
    const away = killer ? Math.atan2(c.y - killer.y, c.x - killer.x) : null;
    const n = fx > 0 ? Math.max(6, Math.round(16 * fx)) : 0;
    for (let i = 0; i < n && debris.length < MAX_DEBRIS; i++) {
      const ang = away !== null && Math.random() < 0.6 ? away + (Math.random() - 0.5) * 1.6 : Math.random() * Math.PI * 2;
      const sp = 140 + Math.random() * 320;
      debris.push({
        x: c.x + (Math.random() - 0.5) * 16, y: c.y + (Math.random() - 0.5) * 10,
        vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
        a: Math.random() * Math.PI * 2, va: (Math.random() - 0.5) * 20,
        w: 4 + Math.random() * 8, h: 3 + Math.random() * 6,
        color: Math.random() < 0.25 ? '#262230' : color, // some black rubber, mostly paint
        heat: 1, shard: Math.random() < 0.55,
      });
    }
    blasts.push({ x: c.x, y: c.y, life: 0, max: 460 });
    rings.push({ x: c.x, y: c.y, r0: 12, r1: 130, life: 0, max: 520, color: '#ff9f43' });
    sparks(c.x, c.y, 34, ['#fff3b0', '#ffd23f', '#ff9f43', '#ff5a5f', '#ff2a2a'], 420);
    addScar(c, color);
    if (showHud) shake = Math.max(shake, c.id === me ? 18 : 11);
  }

  function addScar(c, color) {
    if (scarred.has(c.id)) return;
    scarred.add(c.id);
    const blots = Array.from({ length: 6 }, () => ({ dx: (Math.random() - 0.5) * 40, dy: (Math.random() - 0.5) * 30, r: 9 + Math.random() * 14 }));
    scars.push({ x: c.x, y: c.y, r: 38 + Math.random() * 10, blots, born: lastNow, color });
  }

  /** A wreck whose KO we never saw (joined late): give it a cold scorch mark and settled pieces. */
  function markMissedKos(cars, now) {
    for (const c of cars) {
      if (c.s !== CAR_STATE.DEAD || scarred.has(c.id)) continue;
      if (!deadSince.has(c.id)) { deadSince.set(c.id, now); continue; }
      if (now - deadSince.get(c.id) < 800) continue; // its KILL event is probably on the way
      addScar(c, colorOf(c.id));
      scars[scars.length - 1].born = -1e9;
      for (let i = 0; i < 8 && debris.length < MAX_DEBRIS; i++) {
        debris.push({ x: c.x + (Math.random() - 0.5) * 60, y: c.y + (Math.random() - 0.5) * 44, vx: 0, vy: 0,
          a: Math.random() * Math.PI * 2, va: 0, w: 4 + Math.random() * 8, h: 3 + Math.random() * 6,
          color: Math.random() < 0.25 ? '#262230' : colorOf(c.id), heat: 0, shard: Math.random() < 0.55 });
      }
    }
  }

  function clearRoundMarks() {
    debris.length = 0; scars.length = 0; blasts.length = 0; smoke.length = 0; skids.length = 0;
    scarred.clear(); deadSince.clear();
    winnerId = null;
  }

  /** Scorch marks: charred blots, and embers that cool to a faint glow that stays as a record. */
  function drawScars() {
    for (const s of scars) {
      const g = ctx.createRadialGradient(s.x, s.y, 2, s.x, s.y, s.r);
      g.addColorStop(0, 'rgba(8,6,6,0.62)');
      g.addColorStop(0.6, 'rgba(12,8,8,0.34)');
      g.addColorStop(1, 'rgba(12,8,8,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(10,7,7,0.26)';
      for (const b of s.blots) { ctx.beginPath(); ctx.arc(s.x + b.dx, s.y + b.dy, b.r, 0, Math.PI * 2); ctx.fill(); }
      const heat = Math.max(0.14, 1 - (lastNow - s.born) / 5000);
      const e = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 0.75);
      e.addColorStop(0, `rgba(255,130,40,${(0.5 * heat).toFixed(3)})`);
      e.addColorStop(0.5, `rgba(240,60,30,${(0.28 * heat).toFixed(3)})`);
      e.addColorStop(1, 'rgba(200,30,20,0)');
      ctx.fillStyle = e;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r * 0.75, 0, Math.PI * 2); ctx.fill();
    }
  }

  /** KO pieces: paint-colored shards and chunks, white-hot at first, glowing orange as they cool. */
  function drawDebris() {
    for (const d of debris) {
      ctx.save();
      ctx.translate(d.x, d.y);
      ctx.rotate(d.a);
      if (d.heat > 0.04) { // hot glow around the piece
        ctx.globalAlpha = d.heat * 0.45;
        ctx.fillStyle = '#ff7a2a';
        ctx.beginPath(); ctx.arc(0, 0, Math.max(d.w, d.h) * 0.9, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = d.color;
      ctx.beginPath();
      if (d.shard) { ctx.moveTo(-d.w / 2, d.h / 2); ctx.lineTo(d.w / 2, d.h / 2); ctx.lineTo(d.w * 0.1, -d.h / 2); ctx.closePath(); }
      else ctx.rect(-d.w / 2, -d.h / 2, d.w, d.h);
      ctx.fill();
      if (d.heat > 0.35) { ctx.globalAlpha = (d.heat - 0.35) / 0.65 * 0.85; ctx.fillStyle = '#fff3b0'; ctx.fill(); }
      ctx.restore();
    }
  }

  /** Exhaust: puffs swell and fade behind moving cars; a badly hurt car trails dark, heavy smoke. */
  function drawSmoke() {
    for (const s of smoke) {
      const f = s.life / s.max;
      ctx.globalAlpha = (s.dark ? 0.34 : 0.15) * (1 - f);
      ctx.fillStyle = s.dark ? '#141012' : pal.text;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r0 + (s.r1 - s.r0) * f, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** Sparks sprayed along a direction (radians) within a spread, drawn as streaks. */
  function sparkSpray(x, y, ang, spread, n, colors, speed) {
    const count = Math.round(n * fx);
    for (let i = 0; i < count && particles.length < MAX_PARTICLES; i++) {
      const a = ang + (Math.random() - 0.5) * spread;
      const sp = speed * (0.4 + Math.random() * 0.6);
      particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, max: 220 + Math.random() * 280,
        color: colors[(Math.random() * colors.length) | 0], size: 1.6 + Math.random() * 2, streak: true,
      });
    }
  }

  // The surround's hazard stripes: black and the rail's dash color, as one seamless tile with the
  // glow baked in, repeated as a pattern. Rebuilt only when that color or the pixel size changes.
  let hazard = null; // { key, pattern, period } in device pixels
  function hazardPattern() {
    const P = Math.max(8, Math.round(30 * dpr)), [r, g, b] = (pal.raw || PAL_DARK).dash;
    const key = `${r | 0},${g | 0},${b | 0}|${P}`;
    if (hazard?.key === key) return hazard;
    const cv = document.createElement('canvas');
    cv.width = cv.height = P;
    const tc = cv.getContext('2d'), yellow = `rgb(${r | 0},${g | 0},${b | 0})`;
    tc.fillStyle = '#17151b';
    tc.fillRect(0, 0, P, P);
    tc.fillStyle = yellow;
    tc.shadowColor = yellow;
    tc.shadowBlur = 7 * dpr;
    for (let k = -1; k <= 2; k++) { // "/" bands where (x + y) mod P < P/2, drawn past the edges so the glow wraps seamlessly
      const o = k * P;
      tc.beginPath();
      tc.moveTo(o, 0); tc.lineTo(o + P / 2, 0); tc.lineTo(o + P / 2 - P, P); tc.lineTo(o - P, P);
      tc.closePath();
      tc.fill();
    }
    hazard = { key, pattern: ctx.createPattern(cv, 'repeat'), period: P };
    return hazard;
  }

  /**
   * The rink around the mat (screen space): glowing black-and-yellow hazard stripes all around
   * the arena, creeping clockwise like the rail's dashes (up the left side, along the top, down
   * the right, back along the bottom); a shadow under the mat so it sits above them; and a
   * JERITY sign down the side on a dark plate (both sides on the spectator screen; phones keep
   * the right margin for the standings).
   */
  function drawSurround() {
    const aw = ARENA.W * scale, ah = ARENA.H * scale;
    const { pattern, period } = hazardPattern();
    const off = ((lastNow / 1000) * 20 * dpr) % period;
    const X0 = Math.round(ox * dpr), Y0 = Math.round(oy * dpr);
    const X1 = Math.round((ox + aw) * dpr), Y1 = Math.round((oy + ah) * dpr);
    const CW = canvas.width, CH = canvas.height;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = pattern;
    for (const [x, y, w, h, dx, dy] of [
      [0, 0, X0, CH, 0, -off],              // left side: up
      [X0, 0, X1 - X0, Y0, off, 0],         // top: right
      [X1, 0, CW - X1, CH, 0, off],         // right side: down
      [X0, Y1, X1 - X0, CH - Y1, -off, 0],  // bottom: left
    ]) {
      if (w <= 0 || h <= 0) continue;
      ctx.save();
      ctx.translate(dx, dy); // moves the pattern; the rect stays put
      ctx.fillRect(x - dx, y - dy, w, h);
      ctx.restore();
    }
    ctx.restore();

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 24 * dpr; // shadows ignore the transform: device pixels
    ctx.shadowOffsetY = 6 * dpr;
    ctx.fillStyle = pal.floor;
    ctx.fillRect(ox, oy, aw, ah);
    ctx.restore();

    if (ox < 48) return;
    const size = Math.min(ox * 0.5, ah / 8);
    const [r, g, b] = (pal.raw || PAL_DARK).dash, yellow = `rgb(${r | 0},${g | 0},${b | 0})`;
    ctx.save();
    ctx.font = `700 ${size}px Fredoka, 'Trebuchet MS', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const pw = ctx.measureText('JERITY').width + size * 0.9, ph = size * 1.35;
    for (const side of showHud ? [-1] : [-1, 1]) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.translate(side < 0 ? ox / 2 : cssW - ox / 2, cssH / 2);
      ctx.rotate(side * Math.PI / 2);
      ctx.fillStyle = 'rgba(14,12,16,0.86)';
      roundRect(-pw / 2, -ph / 2, pw, ph, ph * 0.3);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = yellow;
      glow(yellow, 8);
      ctx.stroke();
      ctx.fillStyle = yellow;
      ctx.fillText('JERITY', 0, size * 0.05);
      noGlow();
    }
    ctx.restore();
  }

  /** Phone: everyone's HP down the right margin, between Re-center and the move pad. */
  function drawRoster(cars) {
    if (ox < 64 || !cars.length) return;
    const top = 92, bottom = cssH - movePadRadius() * 2 - 34;
    const rh = Math.min(30 * ui, (bottom - top - 12) / cars.length);
    if (rh < 14) return; // too short a screen: the HP bars over the cars still show it
    const twoLine = rh >= 24;
    const x = cssW - ox + 8, w = ox - 16;
    const list = [...cars].sort((a, b) => ((a.s === CAR_STATE.DEAD) - (b.s === CAR_STATE.DEAD)) || (b.hp - a.hp));
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    roundRect(x, top, w, list.length * rh + 12, 10); ctx.fill();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const k = Math.min(ui, 1.3), bh = 5 * k; // text and bars grow a little; the margin is narrow
    list.forEach((c, i) => {
      const y = top + 6 + i * rh, dead = c.s === CAR_STATE.DEAD;
      const f = dead ? 0 : Math.max(0, Math.min(1, c.hp / maxHpOf(c)));
      ctx.globalAlpha = dead ? 0.4 : c.s === CAR_STATE.DISCONNECTED ? 0.6 : 1;
      ctx.fillStyle = colorOf(c.id);
      ctx.beginPath(); ctx.arc(x + 10, y + (twoLine ? 8 * k : rh / 2), 4 * k, 0, Math.PI * 2); ctx.fill();
      const bx = twoLine ? x + 6 : x + 18, bw = x + w - 6 - bx, by = twoLine ? y + rh - bh - 4 : y + rh / 2 - bh / 2;
      if (twoLine) {
        ctx.font = `${c.id === me ? 800 : 600} ${11 * k}px system-ui, sans-serif`;
        ctx.fillStyle = c.id === me ? '#ffffff' : '#c8cfdc';
        let name = c.id === me ? 'You' : nameOf(c.id);
        while (name.length > 1 && ctx.measureText(name).width > w - 26) name = name.slice(0, -1);
        ctx.fillText(name, x + 18, y + 8 * k);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(bx, by, bw, bh);
      const color = f > 0.5 ? '#5ce1a0' : f > 0.25 ? '#ffd23f' : '#ff5a5f';
      if (!dead) glow(color, 6);
      ctx.fillStyle = color;
      ctx.fillRect(bx, by, bw * f, bh);
      noGlow();
    });
    ctx.globalAlpha = 1;
    ctx.textBaseline = 'alphabetic';
  }

  /** Verity theme: CRT scanlines and a red bleed from the edges, both stronger as he turns. */
  function drawCrt() {
    if (!scanPattern) {
      const tile = document.createElement('canvas');
      tile.width = 1; tile.height = 3;
      const tc = tile.getContext('2d');
      tc.fillStyle = '#000';
      tc.fillRect(0, 2, 1, 1);
      scanPattern = ctx.createPattern(tile, 'repeat');
    }
    ctx.globalAlpha = pal.scan;
    ctx.fillStyle = scanPattern;
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.globalAlpha = 1;
    if (pal.bleed < 0.02) return;
    const key = `${cssW}x${cssH}:${pal.bleed.toFixed(2)}`;
    if (key !== bleedKey) {
      bleedKey = key;
      bleedGrad = ctx.createRadialGradient(cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.35, cssW / 2, cssH / 2, Math.max(cssW, cssH) * 0.7);
      bleedGrad.addColorStop(0, 'rgba(140,0,16,0)');
      bleedGrad.addColorStop(1, `rgba(140,0,16,${pal.bleed.toFixed(3)})`);
    }
    ctx.fillStyle = bleedGrad;
    ctx.fillRect(0, 0, cssW, cssH);
  }

  /**
   * The floor picture at device resolution, repainted only when the map, the palette (in 5%
   * steps of Verity's darkness), the size or the emblem's font changes.
   */
  function floorLayer(c) {
    const step = themed ? Math.round(c * 20) : -1;
    const px = Math.min(3, scale * dpr);
    const key = `${mapId}|${step}|${px.toFixed(3)}|${fontGen}`;
    if (floor?.key === key) return floor.canvas;
    const M = FLOOR_MARGIN, cv = floor?.canvas || document.createElement('canvas');
    cv.width = Math.ceil((ARENA.W + 2 * M) * px);
    cv.height = Math.ceil((ARENA.H + 2 * M) * px);
    const fc = cv.getContext('2d');
    fc.setTransform(px, 0, 0, px, M * px, M * px);
    paintFloor(fc, { map: mapId, pal: themed ? themePalette(step / 20).raw : PAL_DARK, c: themed ? step / 20 : 0, px });
    floor = { key, canvas: cv };
    return cv;
  }

  /** A soft pool of light over the middle, drifting a little, darker toward the rail; late in Verity's arc it reddens and stutters. */
  function drawSpotlight(t, c) {
    const { W, H } = ARENA;
    const cx = W / 2 + Math.sin(t * 0.13) * 60, cy = H / 2 + Math.cos(t * 0.17) * 30;
    let light = 0.12;
    if (c >= 0.75 && Math.sin(t * 9.1) * Math.sin(t * 3.7 + 1) < -0.2) light *= 0.3; // a dying light
    const warm = c >= 0.5 ? '255,170,140' : '255,248,225';
    const g = ctx.createRadialGradient(cx, cy, 20, cx, cy, 640);
    g.addColorStop(0, `rgba(${warm},${light.toFixed(3)})`);
    g.addColorStop(0.45, `rgba(${warm},0)`);
    g.addColorStop(1, `rgba(0,0,0,${(0.22 + c * 0.12).toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  /** From halfway through Verity's arc, a few patches of floor flicker dark, like failing lights overhead. */
  function drawFlicker(t, c) {
    if (c < 0.5 || fx === 0) return;
    const k = (c - 0.5) / 0.5;
    for (const s of spots) {
      if (Math.sin(t * 11 + s.phase) * Math.sin(t * 4.3 + s.phase * 2) < 0.25) continue; // lit most of the time
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r);
      g.addColorStop(0, `rgba(0,0,0,${(0.24 * k).toFixed(3)})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
    }
  }

  // Marquee bulbs on the rail: a warm chase, a fast red chase in the last 10 seconds, everything
  // flashing gold for the victory lap. Late in Verity's arc some bulbs are dead and others stutter.
  const BULB_COLORS = { warm: [255, 226, 150], gold: [246, 185, 59], red: [255, 77, 77] };
  const halos = {};
  function haloSprite(mode) { // a soft glow, drawn once per color and stamped behind each lit bulb
    if (!halos[mode]) {
      const cv = document.createElement('canvas'), [r, g, b] = BULB_COLORS[mode];
      cv.width = cv.height = 48;
      const hc = cv.getContext('2d'), grad = hc.createRadialGradient(24, 24, 0, 24, 24, 24);
      grad.addColorStop(0, `rgba(${r},${g},${b},0.95)`);
      grad.addColorStop(0.35, `rgba(${r},${g},${b},0.45)`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      hc.fillStyle = grad;
      hc.fillRect(0, 0, 48, 48);
      halos[mode] = cv;
    }
    return halos[mode];
  }
  const bulbNoise = (i) => (Math.imul(i + 1, 2654435761) >>> 0) / 4294967296; // fixed per bulb: which ones die

  function drawRailLights(t, c, timeLeft) {
    const { W, H } = ARENA;
    // hazard dashes along the rail's inner half, creeping clockwise and glowing
    ctx.setLineDash([24, 24]);
    ctx.lineDashOffset = -t * 18;
    ctx.lineWidth = 3;
    ctx.strokeStyle = pal.dash;
    glow(pal.dash, 9);
    ctx.strokeRect(RAIL.DASH, RAIL.DASH, W - 2 * RAIL.DASH, H - 2 * RAIL.DASH);
    noGlow();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    const hurry = !winnerId && typeof timeLeft === 'number' && timeLeft > 0 && timeLeft <= 10;
    const mode = winnerId ? 'gold' : hurry ? 'red' : 'warm';
    const step = Math.floor(t * (winnerId ? 4 : hurry ? 14 : 5));
    const [r, g, b] = BULB_COLORS[mode];
    const core = `rgb(${Math.min(255, r + 40)},${Math.min(255, g + 50)},${Math.min(255, b + 60)})`;
    BULBS.forEach((p, i) => {
      const dead = c > 0.5 && bulbNoise(i) < (c - 0.5) * 0.6;
      let lit = !dead && (winnerId ? (i + step) % 2 === 0 : (i + step) % 3 === 0);
      if (lit && c > 0.75 && Math.random() < 0.12) lit = false;
      if (lit && fx > 0) ctx.drawImage(haloSprite(mode), p.x - 10, p.y - 10, 20, 20);
      ctx.fillStyle = lit ? core : 'rgba(30,26,34,0.85)';
      ctx.beginPath(); ctx.arc(p.x, p.y, lit ? 2.9 : 2.3, 0, Math.PI * 2); ctx.fill();
    });
  }

  function drawArena(obstaclesDisabled = false, timeLeft = null) {
    const { W, H } = ARENA;
    const t = lastNow / 1000;
    const c = themed ? Math.max(0, Math.min(1, opts.corrupt())) : 0;
    const style = floorStyle(mapId, pal.raw || PAL_DARK);

    // The floor picture (floor.js): the map's own floor, Verity's face, the ceiling mesh's
    // shadow, start lines, wear and the rail, painted once and copied every frame.
    const M = FLOOR_MARGIN;
    ctx.drawImage(floorLayer(c), -M, -M, W + 2 * M, H + 2 * M);

    // Grid with a slow wave of brightness rolling across it, where the floor has one.
    if (style.grid) {
      ctx.strokeStyle = style.grid.color;
      ctx.lineWidth = 1;
      for (let x = 50; x < W; x += 50) {
        ctx.globalAlpha = style.grid.alpha * (0.7 + 0.3 * Math.sin(x / 140 - t * 0.6));
        ctx.beginPath(); ctx.moveTo(x, RAIL.IN); ctx.lineTo(x, H - RAIL.IN); ctx.stroke();
      }
      for (let y = 50; y < H; y += 50) {
        ctx.globalAlpha = style.grid.alpha * (0.7 + 0.3 * Math.sin(y / 110 + t * 0.45));
        ctx.beginPath(); ctx.moveTo(RAIL.IN, y); ctx.lineTo(W - RAIL.IN, y); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    drawSpotlight(t, c);
    drawFlicker(t, c);
    // Faint drifting specks, a slow far layer and a faster near one (parallax).
    if (!dust.length && fx > 0) {
      for (let i = 0; i < 36; i++) {
        const near = i % 3 === 0;
        dust.push({ x: Math.random() * W, y: Math.random() * H, vx: near ? 15 : 6, vy: near ? 6 : 2.4, s: near ? 3 : 1.6, near });
      }
    }
    ctx.fillStyle = pal.text;
    for (const d of dust) {
      ctx.globalAlpha = d.near ? 0.09 : 0.05;
      ctx.fillRect(d.x, d.y, d.s * 2.4, d.s * 0.9);
    }
    ctx.globalAlpha = 1;

    // painted markings: center circle, and the dashed ring around it turning slowly
    ctx.strokeStyle = style.ink;
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 70, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 3;
    ctx.setLineDash([14, 12]);
    ctx.lineDashOffset = t * 12; // the opposite way to the border, slowly
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 120, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    // Spawn pads in their player's color, glowing (players spawn in join order: SPAWN_POINTS[i]).
    const order = [...players.keys()];
    SPAWN_POINTS.forEach((s, i) => {
      ctx.beginPath(); ctx.arc(s.x, s.y, 22, 0, Math.PI * 2);
      if (!order[i]) { ctx.strokeStyle = style.ink; ctx.lineWidth = 3; ctx.stroke(); return; } // nobody starts here
      const color = colorOf(order[i]);
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      glow(color, 10);
      ctx.stroke();
      noGlow();
      ctx.globalAlpha = 1;
    });

    drawRailLights(t, c, timeLeft);

    for (const o of obstacles) { // shadows first, so every obstacle stands up off the floor
      if (obstaclesDisabled) break;
      ctx.save();
      ctx.translate(o.x + 4, o.y + 6);
      ctx.rotate(o.a || 0);
      ctx.fillStyle = 'rgba(0,0,0,0.14)';
      if (o.kind === 'box') { roundRect(-o.w / 2 - 5, -o.h / 2 - 5, o.w + 10, o.h + 10, o.h / 2 + 5); ctx.fill(); }
      else { ctx.beginPath(); ctx.arc(0, 0, o.r + 6, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      if (o.kind === 'box') { roundRect(-o.w / 2 - 1, -o.h / 2 - 1, o.w + 2, o.h + 2, o.h / 2 + 1); ctx.fill(); }
      else { ctx.beginPath(); ctx.arc(0, 0, o.r + 1, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    }
    const ringGlow = fx >= 1 ? 9 * dpr : 0; // neon bloom on the obstacles' warning rings
    obstacles.forEach((o, i) => {
      if (obstaclesDisabled) return;
      const since = lastNow - (obstacleHitAt.get(i) ?? -1e9);
      drawObstacle(ctx, o, pal, since < 260 ? 1 - since / 260 : 0, ringGlow, t); // t: moving patterns
    });
  }

  function drawCar(c, now) {
    const W = CAR_SIZE.W, H = CAR_SIZE.H;
    const color = colorOf(c.id);
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.a);
    if (c.s === CAR_STATE.DISCONNECTED) ctx.globalAlpha = 0.3; // a ghost until the phone rejoins

    if (c.buff === BUFF.BOOST && c.s !== CAR_STATE.DEAD) { // flame trail out the back
      const len = 16 + Math.random() * 10;
      ctx.fillStyle = '#ff9f43';
      ctx.beginPath(); ctx.moveTo(-W / 2, -7); ctx.lineTo(-W / 2 - len, 0); ctx.lineTo(-W / 2, 7); ctx.fill();
      ctx.fillStyle = '#fff3b0';
      ctx.beginPath(); ctx.moveTo(-W / 2, -4); ctx.lineTo(-W / 2 - len * 0.55, 0); ctx.lineTo(-W / 2, 4); ctx.fill();
    }

    if (c.s === CAR_STATE.DEAD) { // shattered: its pieces and scorch mark are drawn with the floor
      ctx.restore();
      return;
    }

    const m = motion.get(c.id);
    if (c.s === CAR_STATE.FLIPPED) {
      drawFlippedCar(ctx, { w: W, h: H, color, t: now });
    } else {
      if (m && m.speed > 10 && c.s === CAR_STATE.ALIVE) { // speed streaks behind the car
        ctx.strokeStyle = pal.text;
        ctx.globalAlpha = Math.min(0.35, (m.speed - 10) / 12);
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (const y of [-H * 0.3, 0, H * 0.3]) { ctx.moveTo(-W / 2 - 8, y); ctx.lineTo(-W / 2 - 8 - m.speed * 1.6, y); }
        ctx.stroke();
        ctx.globalAlpha = c.s === CAR_STATE.DISCONNECTED ? 0.3 : 1;
      }
      const since = now - (m?.squashAt ?? -1e9);
      const squash = since < 260 ? Math.sin((since / 260) * Math.PI) * (1 - since / 260) * 1.6 : 0;
      drawBumperCar(ctx, { w: W, h: H, color, squash, steer: m?.steer || 0, t: now + c.id.length * 97 });
    }

    const since = now - (carFlash.get(c.id) ?? -1e9);
    if (since < 180) { // just got hit: white flash
      ctx.fillStyle = `rgba(255,255,255,${(0.85 * (1 - since / 180)).toFixed(3)})`;
      roundRect(-W / 2 - 3, -H / 2 - 3, W + 6, H + 6, (H + 6) / 2); ctx.fill();
    }

    if (c.id === me) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = pal.me; // dark on the cream theme, white elsewhere
      roundRect(-W / 2 - 6, -H / 2 - 6, W + 12, H + 12, (H + 12) / 2);
      ctx.stroke();
    }
    ctx.restore();

    if (c.buff === BUFF.SHIELD && c.s !== CAR_STATE.DEAD) {
      ctx.save();
      ctx.globalAlpha = 0.6 + Math.sin(now / 80) * 0.2;
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#4dd0e1';
      ctx.beginPath();
      ctx.arc(c.x, c.y, 32, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (c.s === CAR_STATE.STUNNED) { // spinning stars
      ctx.save();
      ctx.font = '14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffd23f';
      for (let i = 0; i < 3; i++) {
        const t = now / 220 + (i * Math.PI * 2) / 3;
        ctx.fillText('★', c.x + Math.cos(t) * 20, c.y - 6 + Math.sin(t) * 8);
      }
      ctx.restore();
    }

    if (c.s === CAR_STATE.DISCONNECTED) { // phone dropped: bubble + "Disconnected" with a spinning coil
      ctx.save();
      ctx.globalAlpha = 0.55 + Math.sin(now / 300) * 0.15;
      ctx.fillStyle = 'rgba(200,214,255,0.08)';
      ctx.strokeStyle = '#c8d6ff';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(c.x, c.y, 34, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

      ctx.globalAlpha = 1;
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const label = 'Disconnected';
      const w = ctx.measureText(label).width + 30, y = c.y - 50;
      ctx.fillStyle = 'rgba(11,13,18,0.75)';
      roundRect(c.x - w / 2, y - 10, w, 20, 10); ctx.fill();
      ctx.beginPath(); ctx.arc(c.x - w / 2 + 12, y, 5, now / 150, now / 150 + Math.PI * 1.5); ctx.stroke();
      ctx.fillStyle = '#c8d6ff';
      ctx.fillText(label, c.x - w / 2 + 22, y);
      ctx.restore();
    }
  }

  /**
   * Aim line: from your nose to the car you're lined up on, labeled with the hit you'd land.
   * Green REAR / yellow SIDE are good hits; red HEAD-ON means you'll both be stunned.
   */
  function drawAim(cars) {
    const mine = cars.find((c) => c.id === me);
    if (!mine || mine.s !== CAR_STATE.ALIVE) return;
    const fx = Math.cos(mine.a), fy = Math.sin(mine.a);
    let target = null, best = 280;
    for (const c of cars) {
      if (c.id === me || c.s === CAR_STATE.DEAD || c.s === CAR_STATE.DISCONNECTED) continue;
      const dx = c.x - mine.x, dy = c.y - mine.y, d = Math.hypot(dx, dy);
      if (d < best && (dx * fx + dy * fy) / d > Math.cos(0.5)) { best = d; target = c; } // within ~30 deg
    }
    if (!target) return;
    const dx = (target.x - mine.x) / best, dy = (target.y - mine.y) / best;
    const tfx = Math.cos(target.a), tfy = Math.sin(target.a);
    const headOn = -(tfx * dx + tfy * dy) >= (CONFIG.HEADON_THRESHOLD ?? 0.7);
    const rear = tfx * dx + tfy * dy > 0.5;
    const [label, color] = headOn ? ['HEAD-ON!', '#ff5a5f'] : rear ? ['REAR HIT', '#5ce1a0'] : ['SIDE HIT', '#ffd23f'];
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.setLineDash([8, 8]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(mine.x + fx * 22, mine.y + fy * 22);
    ctx.lineTo(target.x - dx * 26, target.y - dy * 26);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(target.x, target.y, 28, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = '800 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(label, target.x, target.y + 44);
    ctx.fillStyle = color;
    ctx.fillText(label, target.x, target.y + 44);
    ctx.restore();
  }

  function drawHpBar(c) {
    const max = maxHpOf(c);
    const f = Math.max(0, Math.min(1, c.hp / max));
    const w = 48, h = 7, x = c.x - w / 2, y = c.y - 34;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - 1.5, y - 1.5, w + 3, h + 3);
    const color = f > 0.5 ? '#5ce1a0' : f > 0.25 ? '#ffd23f' : '#ff5a5f';
    glow(color, 7);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w * f, h);
    noGlow();
    if (showNames) {
      const name = players.get(c.id)?.name;
      if (name) {
        ctx.font = '600 12px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = pal.text;
        ctx.fillText(name, c.x, y - 4);
      }
    }
  }

  function drawEffects() {
    for (const b of blasts) { // KO fireball: white-hot core, orange body, red rim, fading out
      const f = b.life / b.max, r = 14 + 72 * easeOut(f), a = 1 - f;
      const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, r);
      g.addColorStop(0, `rgba(255,250,220,${a.toFixed(3)})`);
      g.addColorStop(0.35, `rgba(255,170,60,${(0.9 * a).toFixed(3)})`);
      g.addColorStop(0.75, `rgba(232,40,30,${(0.6 * a).toFixed(3)})`);
      g.addColorStop(1, 'rgba(200,20,20,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, Math.PI * 2); ctx.fill();
    }
    for (const r of rings) {
      const f = r.life / r.max;
      ctx.globalAlpha = 1 - f;
      ctx.lineWidth = 4 * (1 - f) + 1;
      ctx.strokeStyle = r.color;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * easeOut(f), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.lineCap = 'round';
    for (const p of particles) {
      ctx.globalAlpha = 1 - p.life / p.max;
      if (p.streak) { // directional sparks: a short streak along the way it flies
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03); ctx.stroke();
      } else {
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
    }
    ctx.lineCap = 'butt';
    ctx.textAlign = 'center';
    for (const t of texts) {
      const f = t.life / t.max;
      ctx.globalAlpha = f < 0.7 ? 1 : 1 - (f - 0.7) / 0.3;
      ctx.font = `800 ${t.size}px system-ui, sans-serif`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      const y = t.y - 30 * easeOut(f);
      ctx.strokeText(t.text, t.x, y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, y);
    }
    ctx.globalAlpha = 1;
  }

  function drawFlash() {
    const g = ctx.createRadialGradient(cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.35,
      cssW / 2, cssH / 2, Math.max(cssW, cssH) * 0.75);
    g.addColorStop(0, 'rgba(255,40,40,0)');
    g.addColorStop(1, `rgba(255,40,40,${(flash * 0.6).toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cssW, cssH);
  }

  function drawHud(view, cars, hud, now) {
    ctx.textBaseline = 'middle';
    const mine = cars.find((c) => c.id === me);

    if (hud.danger > 0) { // close to the flip limit: red screen edge
      const a = hud.danger * (0.45 + Math.sin(now / 60) * 0.2);
      const g = ctx.createRadialGradient(cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.45,
        cssW / 2, cssH / 2, Math.max(cssW, cssH) * 0.62);
      g.addColorStop(0, 'rgba(255,40,40,0)');
      g.addColorStop(1, `rgba(255,40,40,${a.toFixed(3)})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, cssW, cssH);
    }

    if (view && typeof view.timeLeft === 'number') {
      const s = Math.max(0, Math.ceil(view.timeLeft));
      const label = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      const timerX = hud.jerity ? cssW / 2 - 92 : cssW / 2;
      pill(timerX, 20, label, s <= 10 ? '#ff5a5f' : '#e8ecf4', 18);
    }

    if (mine) { // own HP (top left) and score (top right), with a neon glow
      const max = maxHpOf(mine), f = Math.max(0, Math.min(1, mine.hp / max));
      // The HP bar runs over the top wall; on a wide phone the speed meter and score sit in the
      // side margins, so nothing covers the corner spawns.
      const inMargin = ox >= 92;
      const x = 12, y = 10, w = Math.min(150 * ui, cssW * 0.26), h = 16 * ui;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      roundRect(x - 4, y - 4, w + 8, h + 8, 8 * ui); ctx.fill();
      const hpColor = f > 0.5 ? '#5ce1a0' : f > 0.25 ? '#ffd23f' : '#ff5a5f';
      glow(hpColor, 12);
      ctx.fillStyle = hpColor;
      ctx.fillRect(x, y, w * f, h);
      noGlow();
      ctx.font = `800 ${13 * ui}px system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.lineWidth = 3; // readable over the bar and the empty track alike
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.strokeText(`${Math.max(0, Math.round(mine.hp))} HP`, x + 6, y + h / 2 + 1);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(`${Math.max(0, Math.round(mine.hp))} HP`, x + 6, y + h / 2 + 1);
      const sc = `${Math.round(mine.sc || 0)} pts`;
      let ss = 15 * ui;
      ctx.font = `700 ${ss}px system-ui, sans-serif`;
      let sw = ctx.measureText(sc).width + ss * 1.2;
      if (inMargin && sw > ox - 16) { ss *= (ox - 16) / sw; sw = ox - 16; } // shrink to fit the margin
      pill(cssW - 10 - sw / 2, 20 * ui, sc, '#ffd23f', ss, true);
      if (typeof hud.speed === 'number') drawSpeed(x, y + h + 12 * ui, inMargin ? ox - 24 : w, hud);
    }

    // Who hit whom, newest on top, just above the tilt meter
    toasts.forEach((t, i) => {
      ctx.globalAlpha = t.life < 1700 ? 1 : 1 - (t.life - 1700) / 500;
      pill(cssW / 2 + Math.min(100, cssW * 0.1), cssH - 50 * ui - i * 26 * ui, t.text, t.color, 13 * ui); // clear of Verity (bottom left)
    });
    ctx.globalAlpha = 1;

    if (typeof hud.tilt === 'number') drawTiltMeter(hud.tilt);
    if (typeof hud.throttle === 'number') drawThrottleMeter(hud.throttle);
    if (hud.move) drawMovePad(hud.move);

    if (hud.banner && hud.countdown == null) pill(cssW / 2, cssH - 64 * ui, hud.banner, '#e8ecf4', 15 * ui);

    if (banner) {
      const f = banner.life / banner.max;
      ctx.globalAlpha = f < 0.8 ? 1 : 1 - (f - 0.8) / 0.2;
      ctx.textAlign = 'center';
      ctx.font = `900 ${Math.round(30 * ui * (1 + 0.15 * (1 - Math.min(1, f * 6))))}px system-ui, sans-serif`;
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(banner.text, cssW / 2, cssH * 0.3);
      ctx.fillStyle = banner.color;
      ctx.fillText(banner.text, cssW / 2, cssH * 0.3);
      ctx.globalAlpha = 1;
    }

    if (hud.flip) {
      const need = CONFIG.RECOVER_TAPS ?? 8;
      const prog = Math.min(1, hud.flip.taps / need);
      ctx.fillStyle = 'rgba(10,8,4,0.55)';
      ctx.fillRect(0, cssH / 2 - 62 * ui, cssW, 124 * ui);
      const pulse = 1 + Math.sin(now / 90) * 0.06;
      ctx.textAlign = 'center';
      ctx.font = `900 ${Math.round(34 * ui * pulse)}px system-ui, sans-serif`;
      ctx.fillStyle = '#ff9f43';
      ctx.fillText('FLIPPED! TAP!', cssW / 2, cssH / 2 - 22 * ui);
      ctx.font = `600 ${15 * ui}px system-ui, sans-serif`;
      ctx.fillStyle = '#ffe2c2';
      ctx.fillText(`${Math.min(hud.flip.taps, need)}/${need}  ·  shaking works too`, cssW / 2, cssH / 2 + 12 * ui);
      const bw = Math.min(320 * ui, cssW * 0.6), bx = (cssW - bw) / 2, by = cssH / 2 + 32 * ui;
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(bx, by, bw, 10 * ui);
      ctx.fillStyle = '#5ce1a0';
      ctx.fillRect(bx, by, bw * prog, 10 * ui);
    }

    if (hud.countdown != null) {
      ctx.fillStyle = 'rgba(6,8,12,0.6)';
      ctx.fillRect(0, 0, cssW, cssH);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffffff';
      const num = Math.min(96 * ui, cssH * 0.3), ny = cssH / 2 - 8 * ui;
      ctx.font = `900 ${num}px system-ui, sans-serif`;
      ctx.fillText(hud.countdown > 0 ? String(hud.countdown) : 'GO!', cssW / 2, ny);
      if (hud.banner) { // "Round 2 of 5" over the number
        ctx.font = `800 ${16 * ui}px system-ui, sans-serif`;
        ctx.fillStyle = '#ffd23f';
        ctx.fillText(hud.banner.toUpperCase(), cssW / 2, ny - num * 0.55 - 6 * ui);
      }
      if (hud.countdown > 0) { // driving guide while we calibrate (each line shrinks to fit the screen)
        const fit = (text, weight, size) => {
          ctx.font = `${weight} ${size}px system-ui, sans-serif`;
          const w = ctx.measureText(text).width;
          if (w > cssW - 24) ctx.font = `${weight} ${size * (cssW - 24) / w}px system-ui, sans-serif`;
        };
        const guide = "Hold your phone the way you'll play and keep it still: that's 'stopped'";
        fit(guide, 700, 16 * ui);
        ctx.fillStyle = '#ffd23f';
        ctx.fillText(guide, cssW / 2, cssH / 2 + 44 * ui);
        ctx.fillStyle = '#c8cfdc';
        const tips = [
          CONFIG.DRIVE_MODE === 'omni'
            ? 'Tilt the phone the way you want to go  ·  level = stop'
            : 'Roll left/right to steer  ·  tip the top away to drive, toward you to reverse',
          'Ram SIDES and REARS — head-ons stun you both',
          CONFIG.DRIVE_MODE === 'omni'
            ? 'Yanking the other way at full speed flips you. Ease off when the edges glow red'
            : 'Full speed + hard turn = you flip. Ease off when the edges glow red',
        ];
        tips.forEach((t, i) => { fit(t, 600, 14 * ui); ctx.fillText(t, cssW / 2, cssH / 2 + 44 * ui + (28 + i * 22) * Math.min(ui, 1.25)); });
      }
    }
    ctx.textBaseline = 'alphabetic';
  }

  /** Speedometer under the HP bar, with the speed where full steering starts to flip you. */
  function drawSpeed(x, y, w, hud) {
    const max = hud.maxSpeed || 14, f = Math.max(0, Math.min(1, hud.speed / max));
    const flipAt = Math.min(1, (hud.flipSpeed || max) / max), h = 8 * ui;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    roundRect(x - 4, y - 4, w + 8, h + 22 * ui, 8 * ui); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(255,90,95,0.35)'; // flip zone
    ctx.fillRect(x + w * flipAt, y, w * (1 - flipAt), h);
    const color = f >= flipAt ? '#ff5a5f' : '#4dd0e1';
    glow(color, 10);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w * f, h);
    noGlow();
    ctx.font = `700 ${11 * ui}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillStyle = f >= flipAt ? '#ff8a8e' : '#c8cfdc';
    ctx.fillText(`${hud.speed.toFixed(0)} m/s${f >= flipAt && w >= 140 ? '  · no hard turns' : ''}`, x, y + h + 8 * ui);
  }

  /** Spectator: live leaderboard from `sc` (top right) and kill feed (top left). */
  function drawBoard(cars) {
    ctx.textBaseline = 'middle';
    const rows = cars.map((c) => ({ c, sc: Math.round(c.sc || 0) })).sort((a, b) => b.sc - a.sc);
    const w = 190, rh = 22, x = cssW - w - 12, y = 12;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(x, y, w, 28 + rows.length * rh, 10); ctx.fill();
    ctx.font = '800 13px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#9aa3b5';
    ctx.fillText('LEADERBOARD', x + 12, y + 15);
    rows.forEach(({ c, sc }, i) => {
      const ry = y + 28 + i * rh + rh / 2;
      ctx.globalAlpha = c.s === CAR_STATE.DEAD ? 0.45 : 1;
      ctx.fillStyle = colorOf(c.id);
      ctx.fillRect(x + 12, ry - 5, 10, 10);
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#e8ecf4';
      ctx.fillText(nameOf(c.id).slice(0, 14), x + 30, ry);
      ctx.textAlign = 'right';
      ctx.fillText(String(sc), x + w - 12, ry);
    });
    ctx.globalAlpha = 1;
    feed.forEach((f, i) => {
      ctx.globalAlpha = f.life < 6500 ? 1 : 1 - (f.life - 6500) / 1500;
      pillLeft(12, 24 + i * 28, f.text);
    });
    ctx.globalAlpha = 1;
    ctx.textBaseline = 'alphabetic';
  }

  function pillLeft(x, cy, text) {
    ctx.font = '700 13px system-ui, sans-serif';
    const w = ctx.measureText(text).width + 20;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(x, cy - 11, w, 22, 11); ctx.fill();
    ctx.fillStyle = '#e8ecf4';
    ctx.textAlign = 'left';
    ctx.fillText(text, x + 10, cy + 1);
  }

  function drawTiltMeter(tilt) {
    const w = Math.min(220 * ui, cssW * 0.36), h = 8 * ui, x = (cssW - w) / 2, y = cssH - 14 - h;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(x - 4, y - 4, w + 8, h + 8);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x, y, w, h);
    // Center mark: green and wider while you're inside the straight zone
    ctx.fillStyle = tilt === 0 ? '#5ce1a0' : 'rgba(255,255,255,0.35)';
    ctx.fillRect(x + w / 2 - (tilt === 0 ? 3 : 1), y - 3, tilt === 0 ? 6 : 2, h + 6);
    const t = Math.max(-1, Math.min(1, tilt));
    ctx.fillStyle = '#ffd23f';
    ctx.fillRect(Math.min(x + w / 2, x + w / 2 + (t * w) / 2), y, Math.abs(t * w) / 2, h);
  }

  /** Omni: which way you're tilting, as a dot in a ring (bottom right). Center ring = deadzone. */
  const movePadRadius = () => Math.min(46 * ui, cssH * 0.15);
  function drawMovePad(m) {
    const r = movePadRadius(), cx = cssW - r - 18, cy = cssH - r - 18;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath(); ctx.arc(cx, cy, r + 8, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    const dz = (CONFIG.OMNI_DEADZONE ?? 0.2) * r;
    ctx.beginPath(); ctx.arc(cx, cy, dz, 0, Math.PI * 2); ctx.stroke();
    const len = Math.hypot(m.x, m.y), x = cx + m.x * r, y = cy - m.y * r;
    if (len > 0) {
      const color = len >= (CONFIG.FLIP_TILT ?? 0.85) ? '#ff9f43' : '#5ce1a0';
      glow(color, 10);
      ctx.strokeStyle = color;
      ctx.lineWidth = 4 * ui;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
      noGlow();
    }
    ctx.fillStyle = len > 0 ? '#ffffff' : '#5ce1a0';
    ctx.beginPath(); ctx.arc(x, y, 7 * ui, 0, Math.PI * 2); ctx.fill();
  }

  /** Vertical gauge on the right: up = forward (green), down = reverse (orange). */
  function drawThrottleMeter(t) {
    const h = Math.min(170 * ui, cssH * 0.45), w = 12 * ui, x = cssW - 18 - w, y = (cssH - h) / 2 + 20, mid = y + h / 2;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    roundRect(x - 6, y - 22, w + 12, h + 44, 10); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x, y, w, h);
    const v = Math.max(-1, Math.min(1, t));
    ctx.fillStyle = v >= 0 ? '#5ce1a0' : '#ff9f43';
    ctx.fillRect(x, v >= 0 ? mid - (v * h) / 2 : mid, w, (Math.abs(v) * h) / 2);
    ctx.fillStyle = v === 0 ? '#e8ecf4' : 'rgba(255,255,255,0.35)'; // neutral notch
    ctx.fillRect(x - 3, mid - 1, w + 6, 2);
    ctx.font = `800 ${10 * ui}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = v > 0 ? '#5ce1a0' : '#9aa3b5';
    ctx.fillText('GO', x + w / 2, y - 10);
    ctx.fillStyle = v < 0 ? '#ff9f43' : '#9aa3b5';
    ctx.fillText('REV', x + w / 2, y + h + 11);
  }

  function pill(cx, cy, text, color, size, bloom = false) {
    ctx.font = `700 ${size}px system-ui, sans-serif`;
    const w = ctx.measureText(text).width + size * 1.2;
    const h = size * 1.6;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    roundRect(cx - w / 2, cy - h / 2, w, h, h / 2);
    ctx.fill();
    if (bloom) glow(color, 10);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(text, cx, cy + 1);
    noGlow();
  }

  // Neon bloom: a soft colored glow (shadowBlur, which counts device pixels) on full effects only.
  function glow(color, blur) {
    if (fx < 1) return;
    ctx.shadowColor = color;
    ctx.shadowBlur = blur * dpr;
  }
  function noGlow() { ctx.shadowBlur = 0; }

  // ctx.roundRect is missing before iOS 16, so draw the path by hand.
  function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function destroy() {
    if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
  }

  return {
    resize, draw, addEvents, setPlayers, destroy,
    project: (x, y) => {
      const rect = canvas.getBoundingClientRect();
      return { x: rect.left + ox + x * scale, y: rect.top + oy + y * scale };
    },
    setMe: (id) => { me = id; },
    /** Arena layout from the lobby (a key of MAPS). */
    setMap: (id) => {
      mapId = MAPS[id] ? id : DEFAULT_MAP;
      obstacles = MAPS[mapId]?.obstacles ?? OBSTACLES;
      spots = flickerSpots(mapId);
      obstacleHitAt.clear();
    },
    /** The victory lap's winner (gold ring and crown), or null. */
    setWinner: (id) => { winnerId = id || null; },
    setFx: (level) => { fx = FX_SCALE[level] ?? fx; },
    fps: () => fpsAvg,
  };
}

function easeOut(f) {
  return 1 - (1 - f) * (1 - f);
}
