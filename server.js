// Birthday page server — no dependencies, Node >= 18.
// Builds the page CONFIG from environment variables (see .env) and serves public/.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'public');

/* ---------- .env loader (local dev only; real env vars win) ---------- */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!(key in process.env)) process.env[key] = line.slice(eq + 1);
  }
}
loadDotEnv(path.join(__dirname, '.env'));

/* ---------- env -> CONFIG ---------- */
const unquote = v => {
  v = String(v ?? '').trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
  return v;
};
const str = (key, def = '') => {
  const v = unquote(process.env[key]);
  return (v || def).replace(/\\n/g, '\n');
};
const list = key => str(key).split('|').map(s => s.trim()).filter(Boolean);

function buildConfig() {
  const age = parseInt(str('AGE', '17'), 10);
  if (!Number.isFinite(age) || age < 1 || age > 120) throw new Error(`AGE không hợp lệ: "${process.env.AGE}"`);
  const unlockAt = str('UNLOCK_AT');
  if (unlockAt && Number.isNaN(new Date(unlockAt).getTime())) throw new Error(`UNLOCK_AT không hợp lệ: "${unlockAt}"`);
  const wishes = list('WISHES');
  if (!wishes.length) throw new Error('WISHES đang trống');
  return {
    herName: str('HER_NAME', 'cậu'),
    fromName: str('FROM_NAME', 'Tớ'),
    age,
    unlockAt,
    music: str('MUSIC'),
    intro: list('INTRO'),
    letter: str('LETTER'),
    wishesTitle: str('WISHES_TITLE', '{age} điều tớ chúc cậu'),
    wishes,
    photos: list('PHOTOS').map(p => {
      const [src, caption = ''] = p.split('::');
      return { src: src.trim(), caption: caption.trim() };
    }),
    finalTitle: str('FINAL_TITLE', 'Chúc mừng sinh nhật, {name}!'),
    finalMessage: str('FINAL_MESSAGE'),
    track: true, // client always reports to /api/track; server decides whether to push
  };
}

const CONFIG = buildConfig();
const TRACK_TOPIC = str('TRACK_TOPIC');
const NTFY_URL = str('NTFY_URL', 'https://ntfy.sh').replace(/\/+$/, '');
const PORT = parseInt(str('PORT', '8080'), 10);

const escHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fillText = s => s.split('{name}').join(CONFIG.herName).split('{from}').join(CONFIG.fromName).split('{age}').join(CONFIG.age);

// Render once at startup: config only changes on restart (k8s rolls the pod when the ConfigMap changes).
const PAGE = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .replace('/*__TITLE__*/', () => escHtml(fillText(str('PAGE_TITLE', 'Gửi cậu 💌'))))
  .replace('/*__CONFIG__*/null', () => JSON.stringify(CONFIG).replace(/</g, '\\u003c'));

/* ---------- tracking ---------- */
async function track(msg, req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  console.log(`[track] ${new Date().toISOString()} ${ip} ${msg}`);
  if (!TRACK_TOPIC) return;
  try {
    await fetch(`${NTFY_URL}/${encodeURIComponent(TRACK_TOPIC)}`, {
      method: 'POST',
      body: msg,
      headers: { Title: `🎂 ${CONFIG.herName}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error('[track] ntfy error:', e.message);
  }
}

/* ---------- static files ---------- */
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch { res.writeHead(400).end(); return; }
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'public, max-age=86400',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------- server ---------- */
const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');

  if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok'); return; }

  if (pathname === '/api/track' && req.method === 'POST') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', c => { body += c; if (body.length > 2000) req.destroy(); });
    req.on('end', () => {
      res.writeHead(204).end();
      const msg = body.trim().slice(0, 1000);
      if (msg) track(msg, req);
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }

  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : PAGE);
    return;
  }
  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`🎂 Trang sinh nhật cho "${CONFIG.herName}" (${CONFIG.age} tuổi, ${CONFIG.wishes.length} điều chúc) tại http://localhost:${PORT}`);
  console.log(TRACK_TOPIC ? `🔔 Push tracking → ${NTFY_URL}/${TRACK_TOPIC}` : '🔕 TRACK_TOPIC trống: chỉ ghi log, không push');
});
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
