// client/src/render.js
// Draws the arena, cars, HP bars, effects and (on phones) the HUD.
// Shared with the spectator page: createRenderer(canvas, { showHud: false }).
// Person 2 owns this file.
//
//   const r = createRenderer(canvas, { showHud: true });
//   r.setPlayers(lobby.players, lobby.mode);
//   r.setMe(playerId);
//   // each frame:
//   r.addEvents(interp.takeEvents(), view);
//   r.draw(view, performance.now(), { tilt, countdown, flip, banner });

import { ARENA, CAR_SIZE, OBSTACLES, CARS, TEAM_COLORS, PLAYER_COLORS } from '../../shared/constants.js';
import { CAR_STATE, EVENT } from '../../shared/protocol.js';
import { CONFIG } from '../../shared/config.js';

const FX_SCALE = { full: 1, low: 0.4, off: 0 };
const MAX_PARTICLES = 250;

export function createRenderer(canvas, opts = {}) {
  const showHud = opts.showHud ?? true;
  const showNames = opts.names ?? !showHud;
  let fx = FX_SCALE[opts.fx] ?? 1;
  const showFps = !!opts.fps;
  const ctx = canvas.getContext('2d');

  let dpr = 1, cssW = 0, cssH = 0, scale = 1, ox = 0, oy = 0;
  let me = null;
  let players = new Map(); // id -> { name, color, maxHp }
  const seenMaxHp = new Map();

  const particles = [];
  const texts = [];
  const rings = [];
  let shake = 0;
  let flash = 0;          // 0..1 red vignette on own damage
  let lastNow = 0;
  let fpsAvg = 60;

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
  }
  resize();
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(canvas); else window.addEventListener('resize', resize);

  // -------------------------------------------------------------------------
  // Players and colors
  // -------------------------------------------------------------------------

  function setPlayers(list = [], mode = 'ffa') {
    players = new Map();
    list.forEach((p, i) => {
      const color = mode === 'ffa'
        ? PLAYER_COLORS[i % PLAYER_COLORS.length]
        : TEAM_COLORS[(p.team ?? 0) % TEAM_COLORS.length];
      players.set(p.id, { name: p.name, color, maxHp: CARS[p.car]?.hp });
    });
  }

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
    for (const e of events) {
      switch (e.type) {
        case EVENT.HIT: {
          const v = pos.get(e.victim), a = pos.get(e.attacker);
          if (!v) break;
          const x = a ? (a.x + v.x) / 2 : v.x, y = a ? (a.y + v.y) / 2 : v.y;
          const dmg = e.dmg || 0;
          sparks(x, y, 6 + Math.min(24, dmg * 0.6), ['#fff3b0', '#ffd23f', '#ff9f43'], 260);
          if (dmg >= 1) floatText(v.x, v.y - 20, `-${Math.round(dmg)}`, '#ff6b6b', 14 + Math.min(16, dmg * 0.4));
          if (e.victim === me) hurt(3 + dmg * 0.4, 40 + dmg * 2);
          else if (e.attacker === me) shake = Math.max(shake, 2);
          break;
        }
        case EVENT.WALL: {
          const c = pos.get(e.id);
          if (!c) break;
          sparks(c.x, c.y, 5, ['#9aa3b5', '#c8cfdc'], 120);
          if (e.dmg > 0) {
            floatText(c.x, c.y - 20, `-${Math.round(e.dmg)}`, '#ff6b6b', 14);
            if (e.id === me) hurt(4, 30);
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
        case EVENT.PARRY: {
          const c = pos.get(e.id);
          if (!c) break;
          rings.push({ x: c.x, y: c.y, r0: 24, r1: 90, life: 0, max: 350, color: '#4dd0e1' });
          sparks(c.x, c.y, 14, ['#ffffff', '#4dd0e1'], 300);
          floatText(c.x, c.y - 30, 'PARRY!', '#4dd0e1', 18);
          if (e.id === me || e.attacker === me) shake = Math.max(shake, 5);
          break;
        }
        case EVENT.KILL: {
          const c = pos.get(e.victim);
          if (!c) break;
          sparks(c.x, c.y, 40, ['#ffffff', '#ffd23f', '#ff5a5f', colorOf(e.victim)], 380);
          rings.push({ x: c.x, y: c.y, r0: 10, r1: 110, life: 0, max: 500, color: '#ffffff' });
          floatText(c.x, c.y - 30, 'KO', '#ffffff', 26);
          if (e.victim === me) hurt(16, 200);
          else if (e.attacker === me) floatText(c.x, c.y - 56, '+KO', '#ffd23f', 18);
          break;
        }
      }
    }
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

  function stepEffects(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dt;
      if (p.life >= p.max) { particles.splice(i, 1); continue; }
      const k = Math.exp(-dt / 160);
      p.vx *= k; p.vy *= k;
      p.x += p.vx * dt / 1000; p.y += p.vy * dt / 1000;
    }
    for (const list of [texts, rings]) {
      for (let i = list.length - 1; i >= 0; i--) {
        list[i].life += dt;
        if (list[i].life >= list[i].max) list.splice(i, 1);
      }
    }
    shake *= Math.exp(-dt / 90);
    if (shake < 0.2) shake = 0;
    flash *= Math.exp(-dt / 220);
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

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // World space
    const sx = shake ? (Math.random() * 2 - 1) * shake : 0;
    const sy = shake ? (Math.random() * 2 - 1) * shake : 0;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (ox + sx), dpr * (oy + sy));
    drawArena();

    const cars = view?.cars || [];
    const order = [...cars].sort((a, b) => rank(a) - rank(b));
    for (const c of order) drawCar(c, now);
    for (const c of order) if (c.s !== CAR_STATE.DEAD) drawHpBar(c);
    drawEffects();

    // Screen space (CSS pixels)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (flash > 0.02) drawFlash();
    if (showHud) drawHud(view, cars, hud, now);
    if (showFps) {
      ctx.fillStyle = '#7f8aa3';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`${Math.round(fpsAvg)} fps`, 8, cssH - 8);
    }
  }

  function rank(c) {
    if (c.s === CAR_STATE.DEAD) return 0;
    if (c.id === me) return 3;
    return c.s === CAR_STATE.FLIPPED ? 1 : 2;
  }

  function drawArena() {
    const { W, H } = ARENA;
    ctx.fillStyle = '#1a1e28';
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 50; x < W; x += 50) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = 50; y < H; y += 50) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 220, 0, Math.PI * 2);
    ctx.stroke();

    // Walls: rubber bumper with hazard dashes
    ctx.lineWidth = 8;
    ctx.strokeStyle = '#2b3242';
    ctx.strokeRect(4, 4, W - 8, H - 8);
    ctx.setLineDash([24, 24]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffd23f55';
    ctx.strokeRect(4, 4, W - 8, H - 8);
    ctx.setLineDash([]);

    for (const o of OBSTACLES) {
      const g = ctx.createRadialGradient(o.x - o.r * 0.3, o.y - o.r * 0.3, o.r * 0.1, o.x, o.y, o.r);
      g.addColorStop(0, '#5a647c');
      g.addColorStop(1, '#2a3040');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#ff5a5f';
      ctx.stroke();
    }
  }

  function drawCar(c, now) {
    const W = CAR_SIZE.W, H = CAR_SIZE.H;
    const color = colorOf(c.id);
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.a);

    if (c.s === CAR_STATE.DEAD) {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#3a3f4a';
      roundRect(-W / 2, -H / 2, W, H, 6); ctx.fill();
      ctx.strokeStyle = '#11141a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-8, -8); ctx.lineTo(8, 8); ctx.moveTo(8, -8); ctx.lineTo(-8, 8);
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (c.s === CAR_STATE.FLIPPED) {
      ctx.rotate(Math.sin(now / 70) * 0.08); // helpless wobble
      ctx.fillStyle = '#2a2d35';
      roundRect(-W / 2, -H / 2, W, H, 6); ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.fillStyle = '#0e0f12'; // wheels up
      for (const [wx, wy] of [[-12, -9], [12, -9], [-12, 9], [12, 9]]) {
        ctx.beginPath(); ctx.arc(wx, wy, 5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.strokeStyle = '#555b66';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-12, 0); ctx.lineTo(12, 0); ctx.stroke(); // axle
    } else {
      ctx.fillStyle = '#0e0f12'; // wheels
      for (const [wx, wy] of [[-13, -H / 2 - 2], [9, -H / 2 - 2], [-13, H / 2 - 2], [9, H / 2 - 2]]) {
        ctx.fillRect(wx, wy, 9, 4);
      }
      ctx.fillStyle = color;
      roundRect(-W / 2, -H / 2, W, H, 7); ctx.fill();
      ctx.lineWidth = 3; // rubber bumper
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.stroke();
      ctx.fillStyle = 'rgba(10,14,22,0.75)'; // windshield toward the nose (+x)
      roundRect(2, -H / 2 + 4, 9, H - 8, 3); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.22)'; // roof shine
      roundRect(-12, -H / 2 + 5, 12, H - 10, 3); ctx.fill();
      ctx.fillStyle = '#fff6c8'; // headlights
      ctx.fillRect(W / 2 - 3, -H / 2 + 3, 3, 4);
      ctx.fillRect(W / 2 - 3, H / 2 - 7, 3, 4);
    }

    if (c.id === me) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ffffff';
      roundRect(-W / 2 - 3, -H / 2 - 3, W + 6, H + 6, 9);
      ctx.stroke();
    }
    ctx.restore();

    if (c.parry) {
      ctx.save();
      ctx.globalAlpha = 0.6 + Math.sin(now / 40) * 0.25;
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#4dd0e1';
      ctx.beginPath();
      ctx.arc(c.x, c.y, 32, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawHpBar(c) {
    const max = maxHpOf(c);
    const f = Math.max(0, Math.min(1, c.hp / max));
    const w = 40, h = 5, x = c.x - w / 2, y = c.y - 30;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = f > 0.5 ? '#5ce1a0' : f > 0.25 ? '#ffd23f' : '#ff5a5f';
    ctx.fillRect(x, y, w * f, h);
    if (showNames) {
      const name = players.get(c.id)?.name;
      if (name) {
        ctx.font = '600 12px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#e8ecf4';
        ctx.fillText(name, c.x, y - 4);
      }
    }
  }

  function drawEffects() {
    for (const r of rings) {
      const f = r.life / r.max;
      ctx.globalAlpha = 1 - f;
      ctx.lineWidth = 4 * (1 - f) + 1;
      ctx.strokeStyle = r.color;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * easeOut(f), 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const p of particles) {
      ctx.globalAlpha = 1 - p.life / p.max;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
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

    if (view && typeof view.timeLeft === 'number') {
      const s = Math.max(0, Math.ceil(view.timeLeft));
      const label = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      pill(cssW / 2, 20, label, s <= 10 ? '#ff5a5f' : '#e8ecf4', 18);
      const left = cars.filter((c) => c.s !== CAR_STATE.DEAD).length;
      pill(cssW / 2, 48, `${left} left`, '#9aa3b5', 12);
    }

    if (typeof hud.tilt === 'number') drawTiltMeter(hud.tilt);

    if (hud.banner) pill(cssW / 2, cssH - 64, hud.banner, '#e8ecf4', 15);

    if (hud.flip) {
      const needShakes = CONFIG.RECOVER_SHAKES ?? 12;
      const needTaps = CONFIG.RECOVER_TAPS ?? 10;
      const prog = Math.min(1, Math.max(hud.flip.shakes / needShakes, hud.flip.taps / needTaps));
      ctx.fillStyle = 'rgba(10,8,4,0.55)';
      ctx.fillRect(0, cssH / 2 - 62, cssW, 124);
      const pulse = 1 + Math.sin(now / 90) * 0.06;
      ctx.textAlign = 'center';
      ctx.font = `900 ${Math.round(34 * pulse)}px system-ui, sans-serif`;
      ctx.fillStyle = '#ff9f43';
      ctx.fillText('FLIPPED! SHAKE!', cssW / 2, cssH / 2 - 22);
      ctx.font = '600 15px system-ui, sans-serif';
      ctx.fillStyle = '#ffe2c2';
      ctx.fillText(`shakes ${hud.flip.shakes}/${needShakes}  ·  or tap ${hud.flip.taps}/${needTaps}`,
        cssW / 2, cssH / 2 + 12);
      const bw = Math.min(320, cssW * 0.6), bx = (cssW - bw) / 2, by = cssH / 2 + 32;
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(bx, by, bw, 10);
      ctx.fillStyle = '#5ce1a0';
      ctx.fillRect(bx, by, bw * prog, 10);
    }

    if (hud.countdown != null) {
      ctx.fillStyle = 'rgba(6,8,12,0.6)';
      ctx.fillRect(0, 0, cssW, cssH);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffffff';
      ctx.font = '900 96px system-ui, sans-serif';
      ctx.fillText(hud.countdown > 0 ? String(hud.countdown) : 'GO!', cssW / 2, cssH / 2 - 20);
      ctx.font = '600 16px system-ui, sans-serif';
      ctx.fillStyle = '#c8cfdc';
      ctx.fillText(hud.countdown > 0 ? 'Hold your phone level like a steering wheel' : '',
        cssW / 2, cssH / 2 + 50);
    }
    ctx.textBaseline = 'alphabetic';
  }

  function drawTiltMeter(tilt) {
    const w = Math.min(220, cssW * 0.3), h = 8, x = (cssW - w) / 2, y = cssH - 22;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(x - 4, y - 4, w + 8, h + 8);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(x + w / 2 - 1, y - 2, 2, h + 4);
    const t = Math.max(-1, Math.min(1, tilt));
    ctx.fillStyle = '#ffd23f';
    ctx.fillRect(Math.min(x + w / 2, x + w / 2 + (t * w) / 2), y, Math.abs(t * w) / 2, h);
  }

  function pill(cx, cy, text, color, size) {
    ctx.font = `700 ${size}px system-ui, sans-serif`;
    const w = ctx.measureText(text).width + size * 1.2;
    const h = size * 1.6;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    roundRect(cx - w / 2, cy - h / 2, w, h, h / 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(text, cx, cy + 1);
  }

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
    setMe: (id) => { me = id; },
    setFx: (level) => { fx = FX_SCALE[level] ?? fx; },
    fps: () => fpsAvg,
  };
}

function easeOut(f) {
  return 1 - (1 - f) * (1 - f);
}
