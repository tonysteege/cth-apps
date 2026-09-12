// The public share page. `watch.html?v=<id>` (or `#v=<id>`) plays one video
// with the CTH scrub feel and nothing else: no library, no key, no account,
// which is why a parent can open it and Notion can embed it.
//
// PUBLIC URL FORMAT - never break it:
//   watch.html?v=<id>&t=<start seconds>&autoplay=1

import * as api from './api.js';
import { mountPlayer } from './player.js';
import { h } from '../../studio/js/ui.js';

const wrap = document.getElementById('wrap');
let player = null;

addEventListener('hashchange', render);
render();

function params() {
  const q = new URLSearchParams(location.search);
  const hq = new URLSearchParams(location.hash.replace(/^#/, ''));
  const g = (k) => hq.get(k) ?? q.get(k);
  return { id: (g('v') || '').trim(), t: Number(g('t') || 0) || 0, autoplay: g('autoplay') === '1' };
}

async function render() {
  if (player) { player.destroy(); player = null; }
  wrap.replaceChildren();
  const { id, t, autoplay } = params();
  if (!/^[a-z0-9]{8,16}$/.test(id)) {
    wrap.appendChild(h('p', { class: 'msg' }, 'This page needs a video link. ',
      h('a', { href: './', text: 'Open CTH Videos' }), ' and copy a share link.'));
    return;
  }
  let v = null;
  try { v = await api.get(id); } catch (e) {
    wrap.appendChild(h('p', { class: 'msg', text: e.status === 404 ? 'That video is no longer available.' : 'The video could not be loaded right now.' }));
    return;
  }
  document.title = `${v.name} - CTH Videos`;
  const host = h('div', { class: 'w-player' });
  const bar = h('div', { class: 'w-bar' },
    h('b', { class: 'w-title', text: v.name }),
    h('span', { class: 'grow' }),
    h('a', { class: 'w-link', href: api.fileUrl(v), download: v.fileName || '', target: '_blank', rel: 'noopener', text: 'Download' }));
  wrap.append(host, bar);
  player = mountPlayer(host, {
    url: api.fileUrl(v), id: v.id, title: v.name, poster: api.posterUrl(v), start: t, autoplay,
    onError: () => {
      bar.appendChild(h('span', { class: 'w-note', text: 'This browser cannot play the file. Try Safari, or download it.' }));
    },
  });
}
