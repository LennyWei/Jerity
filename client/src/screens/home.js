// client/src/screens/home.js
// Name, Create room, Join with code (prefilled from /join/ABCD), and Practice with bots.
// Person 4 owns this file.
//
//   mount(root, { code, error, onCreate(name, bots), onJoin(name, code) }) -> unmount

import { h, store } from '../ui.js';
import { CODE_LENGTH, CODE_ALPHABET } from '../../../shared/protocol.js';
import { NAME_MAX } from '../../../shared/constants.js';

export function mount(root, { code = '', error = '', onCreate, onJoin }) {
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

  const join = h('button.btn.primary', { onclick: () => busy((n) => {
    if (codeEl.value.length !== CODE_LENGTH) { codeEl.focus(); return `Enter the ${CODE_LENGTH}-letter room code`; }
    return onJoin(n, codeEl.value);
  }) }, 'Join room');
  const create = h('button.btn', { onclick: () => busy((n) => onCreate(n, 0)) }, 'Create room');
  const practice = h('button.btn.ghost', { onclick: () => busy((n) => onCreate(n, 3)) }, 'Practice vs 3 bots');
  buttons.push(join, create, practice);

  const el = h('div.screen.center', {},
    h('h1.brand', {}, 'Bumper ', h('span', {}, 'Brawl')),
    h('p.tagline', {}, 'Tilt to steer. Ram their side. Last car standing wins.'),
    h('div.stack', {},
      name,
      h('div.row', {}, codeEl, join),
      h('div.divider', {}, 'or'),
      create,
      practice,
      err,
      h('p.muted', { style: { textAlign: 'center' } }, 'Phones need motion access: allow it when asked.'),
    ));
  root.append(el);
  (code ? name.value ? join : name : name).focus?.();
  return () => el.remove();
}
