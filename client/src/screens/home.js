// client/src/screens/home.js
// Name, Join with code (prefilled from /join/ABCD), Create room with a bot count, Practice vs
// bots, and a live list of open rooms to join with one tap. Person 4 owns this file.
//
//   mount(root, { net, code, error, onCreate(name, bots), onJoin(name, code) }) -> unmount

import { h, store } from '../ui.js';
import { mountVerity, LINES } from '../verity-ui.js';
import { mountMenuCars } from '../menu-cars.js';
import { C2S, CODE_LENGTH, CODE_ALPHABET, ROOM_STATE } from '../../../shared/protocol.js';
import { NAME_MAX, MAX_PLAYERS } from '../../../shared/constants.js';

const LIST_EVERY_MS = 3000;
const STATE_LABEL = {
  [ROOM_STATE.LOBBY]: 'in lobby',
  [ROOM_STATE.COUNTDOWN]: 'starting',
  [ROOM_STATE.PLAYING]: 'playing',
  [ROOM_STATE.ROUND_END]: 'round over',
};

export function mount(root, { net, code = '', error = '', onCreate, onJoin }) {
  const name = h('input.field', {
    placeholder: 'Your name', maxLength: NAME_MAX, autocomplete: 'off', value: store.get('bb-name'),
  });
  const codeEl = h('input.field.code', {
    placeholder: 'CODE', maxLength: CODE_LENGTH, autocomplete: 'off', autocapitalize: 'characters', value: code,
  });
  const err = h('div.error', {}, error);
  const buttons = [];

  // Keep only letters the server uses in codes (no I, L, O).
  codeEl.addEventListener('input', () => {
    codeEl.value = codeEl.value.toUpperCase().split('').filter((c) => CODE_ALPHABET.includes(c)).join('');
  });

  const busy = async (fn) => {
    const n = name.value.trim();
    if (!n) { err.textContent = 'Type your name first'; name.focus(); return; }
    store.set('bb-name', n);
    err.textContent = '';
    buttons.forEach((b) => { b.disabled = true; });
    const msg = await fn(n);
    buttons.forEach((b) => { b.disabled = false; });
    if (msg) err.textContent = msg;
  };
  const joinCode = (c) => busy((n) => onJoin(n, c));

  // Bots to fill empty seats when creating a room (a room with bots can start with just you).
  let bots = Math.max(0, Math.min(MAX_PLAYERS - 1, Number(store.get('bb-bots', '0')) || 0));
  const botCount = h('span.count');
  const setBots = (v) => {
    bots = Math.max(0, Math.min(MAX_PLAYERS - 1, v));
    botCount.textContent = String(bots);
    store.set('bb-bots', String(bots));
    create.textContent = bots ? `Create room with ${bots} bot${bots === 1 ? '' : 's'}` : 'Create room';
  };
  const less = h('button.btn.small.ghost', { onclick: () => setBots(bots - 1), 'aria-label': 'Fewer bots' }, '−');
  const more = h('button.btn.small.ghost', { onclick: () => setBots(bots + 1), 'aria-label': 'More bots' }, '+');

  const join = h('button.btn.primary', { onclick: () => {
    if (codeEl.value.length !== CODE_LENGTH) { err.textContent = `Enter the ${CODE_LENGTH}-letter room code`; codeEl.focus(); return; }
    joinCode(codeEl.value);
  } }, 'Join room');
  const create = h('button.btn', { onclick: () => busy((n) => onCreate(n, bots)) });
  const practice = h('button.btn.ghost', { onclick: () => busy((n) => onCreate(n, 3)) }, 'Practice vs 3 bots');
  buttons.push(join, create, practice);
  setBots(bots);

  // Open rooms, refreshed while this screen is up.
  const list = h('ul.rooms');
  const listNote = h('p.muted', { style: { margin: 0 } }, 'Looking for rooms…');
  let alive = true, timer = 0;
  const refresh = async () => {
    if (!alive) return;
    const res = await net.request(C2S.LIST_ROOMS, {});
    if (!alive) return;
    const rooms = res?.rooms || [];
    listNote.textContent = res?.error ? '' : rooms.length ? '' : 'No open rooms yet. Create one!';
    list.replaceChildren(...rooms.map((r) => h(`li.room${r.joinable ? '' : '.closed'}`, {},
      h('div.room-main', {},
        h('div.room-title', {}, r.practice ? 'Practice arena' : `${r.host || 'Someone'}’s room`,
          h('span.room-tag', {}, r.code)),
        h('div.muted', {}, r.practice
          ? 'Always running · bots · jump in any time'
          : `${r.humans} player${r.humans === 1 ? '' : 's'}${r.players > r.humans ? ` + ${r.players - r.humans} bot${r.players - r.humans === 1 ? '' : 's'}` : ''} · ${r.players}/${r.max} · ${STATE_LABEL[r.state] || r.state}`)),
      r.joinable
        ? (() => { const b = h('button.btn.small.primary', { onclick: () => joinCode(r.code) }, 'Join'); buttons.push(b); return b; })()
        : h('span.tag', {}, r.players >= r.max ? 'full' : 'in game'),
    )));
    timer = setTimeout(refresh, LIST_EVERY_MS);
  };
  refresh();

  const helper = h('div');
  const rink = h('canvas.menu-rink', { 'aria-hidden': 'true' });
  const el = h('div.screen.center.crt', {},
    h('h1.brand', {}, 'JER', h('span', {}, 'ITY')),
    rink,
    helper,
    h('div.stack', {},
      name,
      h('div.row', {}, codeEl, join),
      h('div.divider', {}, 'or'),
      h('div.row.bots', {}, h('span.muted', {}, 'Bots to fill seats'), h('div.stepper', {}, less, botCount, more)),
      create,
      practice,
      err,
      h('div.divider', {}, 'open rooms'),
      list,
      listNote,
      h('p.muted', { style: { textAlign: 'center' } }, 'Phones need motion access: allow it when asked.'),
    ));
  root.append(el);
  const verity = mountVerity(helper, { lines: LINES.home, name: () => name.value.trim() });
  const stopRink = mountMenuCars(rink);
  (code ? name.value ? join : name : name).focus?.();
  return () => { alive = false; clearTimeout(timer); verity.destroy(); stopRink(); el.remove(); };
}
