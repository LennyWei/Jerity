// client/src/menu-cars.js
// The home screen's little rink: toy bumper cars bouncing and bonking, so people see at a glance
// that this is a bumper-car game. Follows Verity's mood: lively, then twitchy, then the cars
// creep in a slow circle with one of them flipped. Person 2 owns this file.
//
//   const stop = mountMenuCars(canvas);   ...   stop();

import { drawBumperCar, drawFlippedCar, roundRect } from './art.js';
import { corruption, stageOf } from './verity-ui.js';
import { PLAYER_COLORS } from '../../shared/constants.js';

const W = 40, H = 24, R = 17; // car size and collision radius (canvas px)
const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function mountMenuCars(canvas) {
  const ctx = canvas.getContext('2d');
  let cw = 0, ch = 0, dpr = 1, raf = 0, last = 0, alive = true;
  const pops = []; // { x, y, life } "BONK!" and spark bursts

  function size() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    cw = canvas.clientWidth; ch = canvas.clientHeight;
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
  }
  size();
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(size) : null;
  ro?.observe(canvas);

  const cars = [0, 1, 2].map((i) => {
    const a = Math.random() * Math.PI * 2;
    return { x: (cw || 300) * (0.25 + i * 0.25), y: (ch || 110) / 2, vx: Math.cos(a) * 70, vy: Math.sin(a) * 45, a, color: PLAYER_COLORS[[0, 1, 3][i]], squashAt: -1e9 };
  });

  function step(dt, now) {
    const stage = stageOf(corruption());
    const speedK = [1, 0.75, 0.5, 0.25][stage];
    cars.forEach((c, i) => {
      if (stage === 3) { // the slow, ominous circle
        const ang = now / 3000 + (i * Math.PI * 2) / 3, rx = cw * 0.28, ry = ch * 0.26;
        const tx = cw / 2 + Math.cos(ang) * rx, ty = ch / 2 + Math.sin(ang) * ry;
        c.vx = (tx - c.x) * 2; c.vy = (ty - c.y) * 2;
      } else if (stage >= 1 && Math.random() < 0.01 * stage) { // twitch
        c.vx += (Math.random() - 0.5) * 160; c.vy += (Math.random() - 0.5) * 120;
      }
      // keep a lively speed
      const sp = Math.hypot(c.vx, c.vy), want = 85 * speedK;
      if (stage < 3 && sp > 1) { c.vx *= 1 + (want / sp - 1) * 0.05; c.vy *= 1 + (want / sp - 1) * 0.05; }
      c.x += c.vx * dt; c.y += c.vy * dt;
      // bounce off the rink walls
      if (c.x < R + 6) { c.x = R + 6; c.vx = Math.abs(c.vx); c.squashAt = now; }
      if (c.x > cw - R - 6) { c.x = cw - R - 6; c.vx = -Math.abs(c.vx); c.squashAt = now; }
      if (c.y < R + 6) { c.y = R + 6; c.vy = Math.abs(c.vy); c.squashAt = now; }
      if (c.y > ch - R - 6) { c.y = ch - R - 6; c.vy = -Math.abs(c.vy); c.squashAt = now; }
      if (Math.hypot(c.vx, c.vy) > 5) { // nose turns toward travel
        let d = Math.atan2(c.vy, c.vx) - c.a;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        c.a += d * Math.min(1, dt * 8);
      }
    });
    // car-on-car: elastic bump, BONK
    for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i], b = cars[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      if (d >= R * 2 || d === 0) continue;
      const nx = dx / d, ny = dy / d, push = (R * 2 - d) / 2;
      a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
      const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
      if (rel > 0) {
        a.vx -= rel * nx; a.vy -= rel * ny; b.vx += rel * nx; b.vy += rel * ny;
        a.squashAt = b.squashAt = now;
        if (rel > 25 && stage < 3) pops.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, life: 0 });
      }
    }
    for (let i = pops.length - 1; i >= 0; i--) if ((pops[i].life += dt) > 0.7) pops.splice(i, 1);
  }

  function draw(now) {
    const stage = stageOf(corruption());
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    // the rink: rubber wall with hazard dashes
    const css = getComputedStyle(canvas);
    const fg = css.getPropertyValue('--fg').trim() || '#2b2733';
    ctx.fillStyle = css.getPropertyValue('--panel').trim() || '#fffaf0';
    roundRect(ctx, 2, 2, cw - 4, ch - 4, 18); ctx.fill();
    ctx.lineWidth = 4; ctx.strokeStyle = fg; ctx.stroke();
    ctx.setLineDash([12, 12]); ctx.lineWidth = 2; ctx.strokeStyle = stage < 3 ? '#f6b93b' : '#8c1d24';
    roundRect(ctx, 8, 8, cw - 16, ch - 16, 13); ctx.stroke(); ctx.setLineDash([]);

    cars.forEach((c, i) => {
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.a);
      if (stage === 3 && i === 2) drawFlippedCar(ctx, { w: W, h: H, color: c.color, t: now });
      else {
        const since = now - c.squashAt;
        const squash = since < 260 ? Math.sin((since / 260) * Math.PI) * (1 - since / 260) * 1.6 : 0;
        drawBumperCar(ctx, { w: W, h: H, color: c.color, squash, t: now + i * 300, spark: stage < 2 });
      }
      ctx.restore();
    });
    // BONK! pops
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of pops) {
      const f = p.life / 0.7;
      ctx.globalAlpha = 1 - f;
      ctx.strokeStyle = '#f6b93b'; ctx.lineWidth = 2;
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const ang = (k * Math.PI) / 3;
        ctx.moveTo(p.x + Math.cos(ang) * (6 + f * 10), p.y + Math.sin(ang) * (6 + f * 10));
        ctx.lineTo(p.x + Math.cos(ang) * (12 + f * 16), p.y + Math.sin(ang) * (12 + f * 16));
      }
      ctx.stroke();
      ctx.font = `700 ${14 + f * 4}px 'Fredoka', system-ui, sans-serif`;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeText('BONK!', p.x, p.y - 14 - f * 10);
      ctx.fillStyle = fg;
      ctx.fillText('BONK!', p.x, p.y - 14 - f * 10);
    }
    ctx.globalAlpha = 1;
  }

  function frame(now) {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    if (document.hidden) { last = now; return; }
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now;
    step(dt, now);
    draw(now);
  }
  if (reduceMotion) { step(0.016, 0); draw(0); }
  else raf = requestAnimationFrame(frame);

  return () => { alive = false; cancelAnimationFrame(raf); ro?.disconnect(); };
}
