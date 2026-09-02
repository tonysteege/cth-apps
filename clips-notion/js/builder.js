// The link builder: a direct video URL in, two Notion-ready links out.
const $ = (s) => document.querySelector(s);
const base = `${location.origin}/clips-notion/embed.html`;
function update() {
  const src = $('#src').value.trim(); const t = Number($('#t').value) || 0;
  const ok = /^https?:\/\//i.test(src);
  $('#links').hidden = !ok; $('#previewCard').hidden = !ok;
  if (!ok) { $('#status').textContent = src ? 'That is not a web address. It must start with http:// or https://.' : 'Paste a link above. The Present link carries the annotation toolbar for live sessions; the Public link plays without it and is safe to share with players.'; return; }
  const q = (mode) => `${base}#src=${encodeURIComponent(src)}${t ? `&t=${t}` : ''}&mode=${mode}`;
  $('#editLink').textContent = q('edit'); $('#viewLink').textContent = q('view');
  $('#preview').src = q('edit');
  $('#status').textContent = 'Links ready. Copy one and paste it into Notion with /embed.';
  try { localStorage.setItem('cthcn.last', JSON.stringify({ src, t })); } catch (_) {}
}
$('#src').oninput = update; $('#t').oninput = update;
document.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = async () => { const text = $('#' + b.dataset.copy).textContent; try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; setTimeout(() => { b.textContent = b.dataset.copy === 'editLink' ? 'Copy Present Link' : 'Copy Public Link'; }, 1200); } catch (_) { prompt('Copy this link', text); } }; });
try { const last = JSON.parse(localStorage.getItem('cthcn.last') || 'null'); if (last?.src) { $('#src').value = last.src; if (last.t) $('#t').value = last.t; update(); } } catch (_) {}
