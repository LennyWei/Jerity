// Optional browser smoke test using installed Chrome and its native debugging protocol.
// No live AI calls: real browser microphone capture feeds an injected offline ruling.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { createRooms } from '../server/rooms.js';
import { JERITY } from '../shared/jerity.js';
import { S2C } from '../shared/protocol.js';

const app = express(), server = http.createServer(app), io = new Server(server);
const captures = [];
const cueRequests = [];
const rooms = createRooms(io, {
  jerityLimits: { ...JERITY, LISTEN_MS: 1200, UPLOAD_GRACE_MS: 300 },
  pipelineFactory: () => ({ runCycle: async (_state, audios) => {
    captures.push(...audios);
    return { events: [{ action: 'boost_player', target: audios[0]?.playerId, params: { duration: 3 } }],
      internalState: { mood: 'playful' }, audioBuffers: [] };
  } }),
});
io.on('connection', rooms.attach);
const dist = path.resolve('client/dist');
// A short silent WAV exercises actual cue playback without requiring the user's MP3s.
const cueAudio = Buffer.alloc(44 + 1600, 0);
cueAudio.write('RIFF', 0); cueAudio.writeUInt32LE(cueAudio.length - 8, 4); cueAudio.write('WAVEfmt ', 8);
cueAudio.writeUInt32LE(16, 16); cueAudio.writeUInt16LE(1, 20); cueAudio.writeUInt16LE(1, 22);
cueAudio.writeUInt32LE(8000, 24); cueAudio.writeUInt32LE(16000, 28);
cueAudio.writeUInt16LE(2, 32); cueAudio.writeUInt16LE(16, 34);
cueAudio.write('data', 36); cueAudio.writeUInt32LE(1600, 40);
app.get('/audio/jerity/listening-:clip.mp3', (req, res) => {
  cueRequests.push(req.params.clip); res.type('audio/wav').send(cueAudio);
});
app.use(express.static(dist));
app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(path.join(tmpdir(), 'jerity-browser-'));
const chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let ws, sequence = 0, sessionId;
const pending = new Map(), errors = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function call(method, params = {}, session = sessionId) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve: result => { clearTimeout(timeout); resolve(result); },
      reject: error => { clearTimeout(timeout); reject(error); } });
    ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
  });
}
const evaluate = async expression => {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};
async function until(expression, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await evaluate(expression)) return; await pause(100); }
  throw new Error(`Browser condition timed out: ${expression}`);
}
async function checkMute(screen) {
  const position = await evaluate(`(() => {
    const button = document.querySelector('.v-sound'), rect = button.getBoundingClientRect();
    return { count: document.querySelectorAll('.v-sound').length,
      fixed: getComputedStyle(button).position, body: button.parentElement === document.body,
      right: document.documentElement.clientWidth - rect.right, bottom: innerHeight - rect.bottom };
  })()`);
  assert.equal(position.count, 1, screen);
  assert.equal(position.fixed, 'fixed', screen);
  assert.equal(position.body, true, screen);
  assert.ok(position.right >= 9 && position.right <= 11, `${screen}: ${JSON.stringify(position)}`);
  assert.ok(position.bottom >= 9 && position.bottom <= 11, `${screen}: ${JSON.stringify(position)}`);
}
try {
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not start')), 10000);
    chrome.once('error', reject);
    chrome.stderr.on('data', data => {
      output += data;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  ws = new WebSocket(endpoint); await once(ws, 'open');
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    const handler = pending.get(message.id);
    if (!handler) return;
    pending.delete(message.id);
    if (message.error) handler.reject(new Error(message.error.message)); else handler.resolve(message.result);
  });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' }, null);
  ({ sessionId } = await call('Target.attachToTarget', { targetId, flatten: true }, null));
  await call('Runtime.enable'); await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: origin });
  await until("!!document.querySelector('input.field')");
  assert.equal(await evaluate("!!document.querySelector('.screen .verity .v-face')"), true, 'home face is attached');
  // Previous visits must not carry corruption into a reload.
  await evaluate("localStorage.setItem('jerity-visits', '99'); localStorage.setItem('jerity-corruption', '1')");
  await call('Page.reload');
  await until("!!document.querySelector('.screen .verity .v-face')");
  assert.equal(await evaluate("document.documentElement.dataset.verityStage"), '0');
  assert.ok(Number(await evaluate("getComputedStyle(document.documentElement).getPropertyValue('--corrupt')")) < .05);
  await checkMute('home');
  await evaluate('window.scrollTo(0, document.body.scrollHeight)');
  await checkMute('scrolled home');
  assert.equal(await evaluate("document.querySelectorAll('.v-bubble').length"), 0);
  await evaluate("document.querySelector('input.field').value = 'Browser Driver'; [...document.querySelectorAll('button')].find(b => b.textContent === 'Practice vs 3 bots').click()");
  await until("!!document.querySelector('.v-mic')");
  await checkMute('lobby');
  await evaluate("document.querySelector('.v-mic').click()");
  await until("document.querySelector('.v-mic')?.textContent === 'Mic on'");
  await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent === 'Start').click()");
  await until("document.querySelector('.bb-verity')?.dataset.phase === 'listening'");
  assert.equal(await evaluate("document.querySelector('.bb-verity .v-phase').textContent"), 'Speak now');
  await checkMute('game');
  const listening = await call('Page.captureScreenshot', { format: 'png' });
  const screenshot = path.join(tmpdir(), 'jerity-listening.png');
  await writeFile(screenshot, Buffer.from(listening.data, 'base64'));
  await until("document.querySelector('.bb-verity')?.dataset.phase === 'idle'");
  await pause(500);
  assert.equal(captures.length, 1);
  assert.ok(captures[0].audioBase64.length > 100);
  const layout = await evaluate(`(() => {
    const face = document.querySelector('.bb-verity .v-face').getBoundingClientRect();
    const pupil = document.querySelector('.v-pupil');
    return { center: face.left + face.width / 2, top: face.top, pupilY: Number(pupil.getAttribute('cy')),
      bubbles: document.querySelectorAll('.v-bubble').length };
  })()`);
  assert.ok(Math.abs(layout.center - 422) < 2);
  assert.ok(layout.top < 20);
  assert.ok(layout.pupilY > 42);
  assert.equal(layout.bubbles, 0);
  assert.deepEqual(cueRequests, ['1']);
  assert.equal(await evaluate("document.querySelector('.bb-verity').classList.contains('v-away')"), false);
  await until("document.querySelector('.bb-verity')?.classList.contains('v-away')", 5000);
  await until("getComputedStyle(document.querySelector('.bb-verity .v-eyes')).opacity === '0'");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.bb-verity .v-mouth')).opacity"), '0');
  const awayScreenshot = path.join(tmpdir(), 'jerity-looking-away.png');
  const away = await call('Page.captureScreenshot', { format: 'png' });
  await writeFile(awayScreenshot, Buffer.from(away.data, 'base64'));
  const code = await evaluate("location.pathname.split('/').pop()");
  io.to(code).emit(S2C.JERITY_STATE, { roundId: 'next-browser-round', phase: 'inviting', turnAwayInMs: null });
  await until("!document.querySelector('.bb-verity').classList.contains('v-away')");
  await until("getComputedStyle(document.querySelector('.bb-verity .v-eyes')).opacity === '1'");
  const playerId = [...io.sockets.sockets.values()].find(socket => socket.data.code === code).data.pid;
  await evaluate("document.documentElement.dataset.verityStage = '3'; document.documentElement.style.setProperty('--corrupt', '1')");
  io.to(code).emit(S2C.ROUND_END, { winnerId: playerId,
    leaderboard: [{ id: playerId, name: 'Browser Driver', kills: 0, damage: 0, survived: 10, score: 20 }] });
  await until("!!document.querySelector('.rs')");
  assert.equal(await evaluate("document.documentElement.dataset.verityStage"), '0', 'game completion resets corruption');
  await checkMute('results');
  const spectator = await call('Target.createTarget', { url: 'about:blank' }, null);
  ({ sessionId } = await call('Target.attachToTarget', { targetId: spectator.targetId, flatten: true }, null));
  await call('Runtime.enable'); await call('Page.enable');
  await call('Page.navigate', { url: `${origin}/spectate/${code}` });
  await until("!!document.querySelector('.spectate-verity')");
  await checkMute('spectate');
  // Simulate an old deployed server without Jerity's lobby field.
  io.to(code).emit(S2C.LOBBY, { code, state: 'playing', players: [] });
  await until("document.querySelector('.spectate-verity .v-phase')?.textContent === 'Jerity unavailable'");
  io.to(code).emit(S2C.JERITY_STATE, { roundId: 'recovered', phase: 'listening', remainingMs: 1000 });
  await until("document.querySelector('.spectate-verity .v-phase')?.textContent === 'Speak now'");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, recordedClips: captures.length, layout, screenshot, awayScreenshot,
    muteScreens: ['home', 'lobby', 'game', 'results', 'spectate'], cueRequests }));
} finally {
  if (ws?.readyState === WebSocket.OPEN) { await call('Browser.close', {}, null).catch(() => {}); ws.close(); }
  if (chrome.exitCode === null) await Promise.race([once(chrome, 'exit'), pause(2000)]);
  if (chrome.exitCode === null) chrome.kill();
  rooms.close(); await new Promise(resolve => io.close(resolve));
  // Only the isolated temporary Chrome profile created above can be removed.
  if (path.dirname(profile) === path.resolve(tmpdir()) && path.basename(profile).startsWith('jerity-browser-')) {
    await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
