// diagrammer.coachtonyhockey.com - the diagrammer's OLD address.
//
// Two jobs, both in service of the move to apps.coachtonyhockey.com/diagrams:
//   1. /export serves a tiny page that reads the OLD origin's IndexedDB and
//      localStorage and posts them to the new origin. The app at the new
//      address embeds it once, invisibly, to migrate saved diagrams -
//      browser storage is per-origin, so without this bridge the move would
//      strand everything saved under the old domain.
//   2. Every other path 301-redirects to the new home.
//
// Deployed with wrangler from redirect-worker/ (route
// diagrammer.coachtonyhockey.com/* - the DNS record must stay PROXIED or
// the route never runs). This folder is not part of the web app.

const NEW_HOME = 'https://apps.coachtonyhockey.com/diagrams/';
const NEW_ORIGIN = 'https://apps.coachtonyhockey.com';

const EXPORT_HTML = `<!doctype html>
<meta charset="utf-8">
<title>CTH Diagrammer Migration</title>
<body>
<scr` + `ipt>
(async () => {
  const out = { app: 'cthd-migrate', drills: [], folders: [], locals: {} };
  try {
    for (const k of ['cthd.settings.v1', 'cthd.folders.v1', 'cthd.edside.v1']) {
      const v = localStorage.getItem(k);
      if (v != null) out.locals[k] = v;
    }
    try { out.folders = JSON.parse(out.locals['cthd.folders.v1'] || '[]'); } catch (e) {}
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('cth-diagrammer', 1);
      r.onupgradeneeded = () => {};
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (db.objectStoreNames.contains('drills')) {
      out.drills = await new Promise((res, rej) => {
        const g = db.transaction('drills', 'readonly').objectStore('drills').getAll();
        g.onsuccess = () => res(g.result || []);
        g.onerror = () => rej(g.error);
      });
    }
  } catch (e) { /* send whatever was gathered */ }
  parent.postMessage(out, '${NEW_ORIGIN}');
})();
</scr` + `ipt>
</body>`;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/export') {
      return new Response(EXPORT_HTML, {
        headers: { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    return Response.redirect(NEW_HOME, 301);
  },
};
