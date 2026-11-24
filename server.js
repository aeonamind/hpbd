// Birthday page server — no dependencies, Node >= 18.
// Builds the page CONFIG from env vars / .env, or from CONFIG_DIR (one file per key), and serves public/.
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

/* ---------- settings source: CONFIG_DIR files (k8s Secret volume) > env vars ---------- */
// In k8s the Vault-backed Secret is mounted as a directory: one file per key. Kubelet refreshes
// those files when the Secret changes, so the page picks up new content without a restart.
const CONFIG_DIR = process.env.CONFIG_DIR || '';
function readSettings() {
  const out = { ...process.env };
  if (CONFIG_DIR) {
    for (const name of fs.readdirSync(CONFIG_DIR)) {
      if (name.startsWith('.')) continue; // skip kubelet's ..data / ..timestamp entries
      const file = path.join(CONFIG_DIR, name);
      try { if (fs.statSync(file).isFile()) out[name] = fs.readFileSync(file, 'utf8'); } catch {}
    }
  }
  return out;
}

const unquote = v => {
  v = String(v ?? '').trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
  return v;
};

function buildState(env) {
  // A literal backslash-n (as written in .env) becomes a real newline.
  const str = (key, def = '') => (unquote(env[key]) || def).replace(/\\n/g, '\n');
  // Lists: one item per line (handy in the Vault UI) or separated by | (handy in .env).
  const list = key => str(key).split(/\r?\n|\|/).map(s => s.trim()).filter(Boolean);

  const age = parseInt(str('AGE', '17'), 10);
  if (!Number.isFinite(age) || age < 1 || age > 120) throw new Error(`AGE không hợp lệ: "${env.AGE}"`);
  const unlockAt = str('UNLOCK_AT');
  if (unlockAt && Number.isNaN(new Date(unlockAt).getTime())) throw new Error(`UNLOCK_AT không hợp lệ: "${unlockAt}"`);
  const wishes = list('WISHES');
  if (!wishes.length) throw new Error('WISHES đang trống');

  const config = {
    herName: str('HER_NAME', 'em'),
    fromName: str('FROM_NAME', 'Anh'),
    age,
    unlockAt,
    music: str('MUSIC'),
    intro: list('INTRO'),
    letter: str('LETTER'),
    wishesTitle: str('WISHES_TITLE', '{age} điều anh chúc em'),
    wishes,
    photos: list('PHOTOS').map(p => {
      const [src, caption = ''] = p.split('::');
      return { src: src.trim(), caption: caption.trim() };
    }),
    finalTitle: str('FINAL_TITLE', 'Chúc mừng sinh nhật, {name}!'),
    finalMessage: str('FINAL_MESSAGE'),
    theme: str('THEME', 'pastel'), // pastel | mint | navy | night
    track: true, // client always reports to /api/track; server decides whether to push
  };
  const fill = s => s.split('{name}').join(config.herName).split('{from}').join(config.fromName).split('{age}').join(config.age);
  const page = TEMPLATE
    .replace('/*__TITLE__*/', () => escHtml(fill(str('PAGE_TITLE', 'Sinh nhật vui vẻ, {name} 🎂'))))
    .replace('/*__CONFIG__*/null', () => JSON.stringify(config).replace(/</g, '\\u003c')); // keep '</script>' in content from closing the tag
  return {
    config,
    page,
    trackTopic: str('TRACK_TOPIC'),
    ntfyUrl: str('NTFY_URL', 'https://ntfy.sh').replace(/\/+$/, ''),
  };
}

const escHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TEMPLATE = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const PORT = parseInt(process.env.PORT || '8080', 10);

// Startup must succeed (invalid content = crash, so a bad deploy is visible).
let state = buildState(readSettings());
let stateKey = JSON.stringify(readSettings());

// Afterwards, re-read at most every RELOAD_SECONDS; on invalid content keep serving the last good page.
const RELOAD_MS = parseInt(process.env.RELOAD_SECONDS || '15', 10) * 1000;
let checkedAt = Date.now();
function current() {
  if (Date.now() - checkedAt < RELOAD_MS) return state;
  checkedAt = Date.now();
  try {
    const env = readSettings(), key = JSON.stringify(env);
    if (key !== stateKey) {
      state = buildState(env); stateKey = key;
      console.log(`[config] reloaded: "${state.config.herName}", ${state.config.age} tuổi, ${state.config.wishes.length} điều chúc`);
    }
  } catch (e) {
    console.error('[config] reload failed, keeping previous content:', e.message);
  }
  return state;
}

/* ---------- tracking ---------- */
async function track(msg, req) {
  const { trackTopic, ntfyUrl, config } = current();
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  console.log(`[track] ${new Date().toISOString()} ${ip} ${msg}`);
  if (!trackTopic) return;
  try {
    await fetch(`${ntfyUrl}/${encodeURIComponent(trackTopic)}`, {
      method: 'POST',
      body: msg,
      headers: { Title: `🎂 ${config.herName}` },
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
    res.end(req.method === 'HEAD' ? undefined : current().page);
    return;
  }
  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  const { config: c, trackTopic, ntfyUrl } = state;
  console.log(`🎂 Trang sinh nhật cho "${c.herName}" (${c.age} tuổi, ${c.wishes.length} điều chúc) tại http://localhost:${PORT}`);
  console.log(CONFIG_DIR ? `📂 Đọc nội dung từ ${CONFIG_DIR} (tự cập nhật mỗi ${RELOAD_MS / 1000}s)` : '📄 Đọc nội dung từ biến môi trường / .env');
  console.log(trackTopic ? `🔔 Push tracking → ${ntfyUrl} (topic đã cấu hình)` : '🔕 TRACK_TOPIC trống: chỉ ghi log, không push');
});
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
