// client/src/art.js
// Drawings shared by the arena (render.js) and the menu animation: bumper cars and obstacles.
// Plain canvas calls, no state. Person 2 owns this file.
//
// Cars are drawn around (0, 0) facing +x, so callers translate and rotate first.

/** Rounded rectangle path. */
export function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * A bumper car seen from above: fat rubber ring, colored tub, seat, driver, steering wheel, and
 * the pole at the back with its spark. squash (0..1) wobbles it on impact; steer (-1..1) turns the wheel.
 */
export function drawBumperCar(ctx, { w = 40, h = 24, color = '#ff5a5f', squash = 0, steer = 0, t = 0, spark = true, rubber = '#262230' } = {}) {
  ctx.save();
  if (squash > 0) ctx.scale(1 - squash * 0.16, 1 + squash * 0.2); // squashed along the hit, bulges sideways
  // rubber bumper ring
  ctx.fillStyle = rubber;
  roundRect(ctx, -w / 2 - 3, -h / 2 - 3, w + 6, h + 6, (h + 6) / 2);
  ctx.fill();
  // the tub
  ctx.fillStyle = color;
  roundRect(ctx, -w / 2 + 1, -h / 2 + 1, w - 2, h - 2, (h - 2) / 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.28)'; // shine along the top edge
  roundRect(ctx, -w * 0.3, -h / 2 + 3, w * 0.62, h * 0.18, h * 0.09);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.18)'; // shade along the bottom edge
  roundRect(ctx, -w * 0.32, h / 2 - 3 - h * 0.14, w * 0.66, h * 0.14, h * 0.07);
  ctx.fill();
  // seat
  ctx.fillStyle = 'rgba(20,16,26,0.82)';
  roundRect(ctx, -w * 0.36, -h * 0.3, w * 0.34, h * 0.6, h * 0.16);
  ctx.fill();
  // driver: head and helmet stripe
  ctx.fillStyle = '#f3d6bc';
  ctx.beginPath(); ctx.arc(-w * 0.14, 0, h * 0.21, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(20,16,26,0.55)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // steering wheel, turning with the input
  ctx.save();
  ctx.translate(w * 0.1, 0);
  ctx.rotate(steer * 0.9);
  ctx.strokeStyle = '#1b1820';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0, 0, h * 0.17, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, -h * 0.17); ctx.lineTo(0, h * 0.17); ctx.stroke();
  ctx.restore();
  // headlights
  ctx.fillStyle = '#fff6c8';
  ctx.beginPath(); ctx.arc(w / 2 - 4, -h * 0.27, 1.9, 0, Math.PI * 2); ctx.arc(w / 2 - 4, h * 0.27, 1.9, 0, Math.PI * 2); ctx.fill();
  // the pole at the back, with a spark at the top (classic bumper-car ceiling pickup)
  const px = -w * 0.43;
  ctx.fillStyle = '#1b1820';
  ctx.beginPath(); ctx.arc(px, 0, 2.6, 0, Math.PI * 2); ctx.fill();
  if (spark && Math.sin(t / 47) > 0.55) {
    ctx.strokeStyle = '#fff3a0';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = t / 90 + (i * Math.PI) / 2;
      ctx.moveTo(px + Math.cos(a) * 3, Math.sin(a) * 3);
      ctx.lineTo(px + Math.cos(a) * 6.5, Math.sin(a) * 6.5);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** Upside down: dark underside with caster wheels and the colored rim showing. */
export function drawFlippedCar(ctx, { w = 40, h = 24, color = '#ff5a5f', t = 0 } = {}) {
  ctx.save();
  ctx.rotate(Math.sin(t / 70) * 0.08); // helpless wobble
  ctx.fillStyle = color;
  roundRect(ctx, -w / 2 - 3, -h / 2 - 3, w + 6, h + 6, (h + 6) / 2);
  ctx.fill();
  ctx.fillStyle = '#2a2730';
  roundRect(ctx, -w / 2 + 1, -h / 2 + 1, w - 2, h - 2, (h - 2) / 2);
  ctx.fill();
  ctx.fillStyle = '#0e0d12';
  for (const [x, y] of [[-w * 0.3, -h * 0.28], [w * 0.3, -h * 0.28], [-w * 0.3, h * 0.28], [w * 0.3, h * 0.28]]) {
    ctx.beginPath(); ctx.arc(x, y, 3.6, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = '#59546a';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-w * 0.3, 0); ctx.lineTo(w * 0.3, 0); ctx.stroke();
  ctx.restore();
}

/** Knocked out: a scorched, cracked tub. */
export function drawWreck(ctx, { w = 40, h = 24 } = {}) {
  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.fillStyle = '#2a2628';
  roundRect(ctx, -w / 2 - 3, -h / 2 - 3, w + 6, h + 6, (h + 6) / 2);
  ctx.fill();
  ctx.strokeStyle = '#0c0a0b';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-w * 0.3, -h * 0.2); ctx.lineTo(-w * 0.05, h * 0.05); ctx.lineTo(w * 0.1, -h * 0.15); ctx.lineTo(w * 0.32, h * 0.2);
  ctx.stroke();
  ctx.restore();
}

/**
 * One obstacle. o: { x, y, r } (bollard or, with kind 'tire', a tire stack) or
 * { kind: 'box', x, y, w, h, a } (rubber barrier). pal: arena palette. hit: 0..1 just-hit glow.
 */
export function drawObstacle(ctx, o, pal, hit = 0) {
  ctx.save();
  ctx.translate(o.x, o.y);
  const squash = hit > 0 ? 1 - hit * 0.08 : 1;
  if (o.kind === 'box') {
    ctx.rotate(o.a || 0);
    ctx.scale(1, squash);
    ctx.fillStyle = pal.wall;
    roundRect(ctx, -o.w / 2, -o.h / 2, o.w, o.h, o.h / 2);
    ctx.fill();
    ctx.save(); // hazard stripes
    roundRect(ctx, -o.w / 2 + 3, -o.h / 2 + 3, o.w - 6, o.h - 6, (o.h - 6) / 2);
    ctx.clip();
    ctx.fillStyle = pal.dash;
    for (let x = -o.w / 2 - o.h; x < o.w / 2 + o.h; x += 16) {
      ctx.beginPath();
      ctx.moveTo(x, o.h / 2); ctx.lineTo(x + 8, o.h / 2); ctx.lineTo(x + 8 + o.h, -o.h / 2); ctx.lineTo(x + o.h, -o.h / 2);
      ctx.fill();
    }
    ctx.restore();
  } else if (o.kind === 'tire') {
    ctx.scale(squash, squash);
    ctx.fillStyle = '#1c1a1f';
    ctx.beginPath(); ctx.arc(0, 0, o.r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#34303a'; // tread
    ctx.lineWidth = 3;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.arc(0, 0, o.r - 3, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = pal.floor; // the hole in the middle
    ctx.beginPath(); ctx.arc(0, 0, o.r * 0.42, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = pal.pillarEdge;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, o.r * 0.42, 0, Math.PI * 2); ctx.stroke();
  } else {
    ctx.scale(squash, squash); // rubber bollard: dark base, colored cap, warning band
    ctx.fillStyle = pal.wall;
    ctx.beginPath(); ctx.arc(0, 0, o.r, 0, Math.PI * 2); ctx.fill();
    const g = ctx.createRadialGradient(-o.r * 0.3, -o.r * 0.3, o.r * 0.1, 0, 0, o.r * 0.82);
    g.addColorStop(0, pal.pillarA);
    g.addColorStop(1, pal.pillarB);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, o.r * 0.82, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = pal.dash;
    ctx.lineWidth = o.r * 0.14;
    ctx.setLineDash([o.r * 0.32, o.r * 0.26]);
    ctx.beginPath(); ctx.arc(0, 0, o.r * 0.55, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }
  if (hit > 0) { // just hit: a bright ring
    ctx.globalAlpha = hit;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    if (o.kind === 'box') roundRect(ctx, -o.w / 2 - 2, -o.h / 2 - 2, o.w + 4, o.h + 4, o.h / 2 + 2);
    else ctx.arc(0, 0, o.r + 3, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}
