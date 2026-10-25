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

const app = express(), server = http.createServer(app), io = new Server(server);
const captures = [];
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
  assert.equal(await evaluate("document.querySelectorAll('.v-bubble').length"), 0);
  await evaluate("document.querySelector('input.field').value = 'Browser Driver'; [...document.querySelectorAll('button')].find(b => b.textContent === 'Practice vs 3 bots').click()");
  await until("!!document.querySelector('.v-mic')");
  await evaluate("document.querySelector('.v-mic').click()");
  await until("document.querySelector('.v-mic')?.textContent === 'Mic on'");
  await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent === 'Start').click()");
  await until("document.querySelector('.bb-verity')?.dataset.phase === 'listening'");
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
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, recordedClips: captures.length, layout, screenshot }));
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
