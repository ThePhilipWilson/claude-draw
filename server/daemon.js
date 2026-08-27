#!/usr/bin/env node
// claude-draw daemon. Long-lived: holds the canvas page open between requests so it
// never lands on a dead terminal state. Dependency-free (http + fs only).
//
//   node daemon.js [--port 7331] [--lan] [--out <dir>]
//
// Binds loopback only by default. --lan (or CLAUDE_DRAW_LAN=1) binds 0.0.0.0 so other
// devices on the same network can open the canvas.
//
// Claude talks to it over loopback (POST /request, which blocks until the user submits).
// Browsers, including ones on other devices, hold a GET /events SSE stream and are pushed
// each new request as it arrives.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.indexOf(n) !== -1;

const PORT = parseInt(flag('--port', process.env.CLAUDE_DRAW_PORT || '7331'), 10);
// Loopback only unless LAN exposure is asked for explicitly, by flag or env.
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));
const HOST = (has('--lan') || truthy(process.env.CLAUDE_DRAW_LAN)) ? '0.0.0.0' : '127.0.0.1';
const DEFAULT_OUT = flag('--out', path.join(os.tmpdir(), 'claude-draw'));
const CANVAS = path.join(__dirname, 'canvas.html');

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp'
};

// ---- state ----------------------------------------------------------------
let seq = 0;
let active = null;      // { id, prompt, imagePath, outDir, res, timer, startedAt }
const queue = [];       // pending requests waiting their turn
const clients = new Set();

function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, 'application/json', JSON.stringify(obj));

function readBody(req, limit, cb) {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    try { cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch (e) { cb(e); }
  });
}

// ---- SSE ------------------------------------------------------------------
function push(event, data) {
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  clients.forEach((c) => { try { c.write(payload); } catch (e) { /* dropped */ } });
}

function describe(r) {
  if (!r) return null;
  return { id: r.id, prompt: r.prompt || null, image: r.imagePath ? '/image/' + r.id : null };
}

// ---- request lifecycle ----------------------------------------------------
function activateNext() {
  if (active || !queue.length) return;
  active = queue.shift();
  active.startedAt = Date.now();
  push('request', describe(active));
}

function settle(result) {
  if (!active) return;
  const r = active;
  active = null;
  clearTimeout(r.timer);
  if (!r.res.writableEnded) json(r.res, 200, result);
  push('settled', { id: r.id, outcome: result.outcome });
  activateNext();
}

// ---- server ---------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/') {
    return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(CANVAS));
  }

  if (req.method === 'GET' && url === '/state') {
    return json(res, 200, {
      ok: true, pid: process.pid, port: PORT, lan: HOST === '0.0.0.0',
      canvases: clients.size, active: describe(active), queued: queue.length,
      urls: addresses()
    });
  }

  if (req.method === 'GET' && url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    // A page that connects mid-request should pick it up immediately.
    res.write('event: hello\ndata: ' + JSON.stringify({ active: describe(active) }) + '\n\n');
    const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* dropped */ } }, 25000);
    req.on('close', () => { clearInterval(ka); clients.delete(res); });
    return;
  }

  if (req.method === 'GET' && url.indexOf('/image/') === 0) {
    const id = url.slice('/image/'.length);
    const r = (active && String(active.id) === id) ? active : queue.filter((q) => String(q.id) === id)[0];
    if (!r || !r.imagePath) return send(res, 404, 'text/plain', 'no image');
    const type = MIME[path.extname(r.imagePath).toLowerCase()] || 'application/octet-stream';
    return send(res, 200, type, fs.readFileSync(r.imagePath));
  }

  // Claude side. Loopback only, so a device on the LAN cannot drive the session.
  if (req.method === 'POST' && url === '/request') {
    if (!isLocal(req)) return json(res, 403, { ok: false, error: 'local only' });
    return readBody(req, 1 << 20, (err, body) => {
      if (err) return json(res, 400, { ok: false, error: 'bad json' });
      body = body || {};
      let imagePath = null;
      if (body.image_path) {
        imagePath = path.resolve(body.image_path);
        if (!fs.existsSync(imagePath)) return json(res, 400, { ok: false, error: 'image not found: ' + imagePath });
        if (!MIME[path.extname(imagePath).toLowerCase()]) return json(res, 400, { ok: false, error: 'unsupported image type: ' + imagePath });
      }
      const r = {
        id: ++seq,
        prompt: body.prompt || null,
        imagePath: imagePath,
        outDir: path.resolve(body.out_dir || DEFAULT_OUT),
        res: res
      };
      fs.mkdirSync(r.outDir, { recursive: true });
      const secs = Math.max(30, Math.min(3600, parseInt(body.timeout_seconds, 10) || 600));
      r.timer = setTimeout(() => {
        if (active && active.id === r.id) settle({ ok: true, outcome: 'timeout' });
        else {
          const i = queue.indexOf(r);
          if (i !== -1) { queue.splice(i, 1); json(r.res, 200, { ok: true, outcome: 'timeout' }); }
        }
      }, secs * 1000);
      queue.push(r);
      activateNext();
    });
  }

  if (req.method === 'POST' && url === '/submit') {
    return readBody(req, 64 << 20, (err, body) => {
      if (err || !body || !body.png) return json(res, 400, { ok: false, error: 'no image' });
      if (!active || String(active.id) !== String(body.id)) {
        return json(res, 409, { ok: false, error: 'that request is no longer open' });
      }
      const stem = 'draw-' + stamp();
      const pngPath = path.join(active.outDir, stem + '.png');
      fs.writeFileSync(pngPath, Buffer.from(String(body.png).replace(/^data:image\/png;base64,/, ''), 'base64'));
      let strokesPath = null;
      if (body.strokes) {
        strokesPath = path.join(active.outDir, stem + '.strokes.json');
        fs.writeFileSync(strokesPath, JSON.stringify(body.strokes));
      }
      json(res, 200, { ok: true });
      settle({
        ok: true, outcome: 'drawing',
        path: pngPath, strokes_path: strokesPath,
        caption: String(body.caption || '').trim(),
        background: body.background || 'blank'
      });
    });
  }

  if (req.method === 'POST' && url === '/cancel') {
    return readBody(req, 1 << 16, (err, body) => {
      json(res, 200, { ok: true });
      if (active && body && String(active.id) === String(body.id)) settle({ ok: true, outcome: 'cancelled' });
    });
  }

  if (req.method === 'POST' && url === '/shutdown') {
    if (!isLocal(req)) return json(res, 403, { ok: false, error: 'local only' });
    json(res, 200, { ok: true });
    return setTimeout(() => process.exit(0), 100);
  }

  send(res, 404, 'text/plain', 'not found');
});

function stamp() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' +
         p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + '-' + (seq || 0);
}

function addresses() {
  const out = { local: 'http://127.0.0.1:' + PORT + '/', lan: [] };
  if (HOST === '0.0.0.0') {
    const ifaces = os.networkInterfaces();
    Object.keys(ifaces).forEach((name) => {
      (ifaces[name] || []).forEach((a) => {
        if (a.family === 'IPv4' && !a.internal) out.lan.push({ url: 'http://' + a.address + ':' + PORT + '/', iface: name });
      });
    });
  }
  return out;
}

server.on('error', (err) => {
  process.stderr.write('claude-draw daemon: ' + err.message + '\n');
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const a = addresses();
  process.stdout.write('claude-draw daemon on ' + a.local + ' (pid ' + process.pid + ')\n');
  a.lan.forEach((l) => process.stdout.write('  lan: ' + l.url + '  (' + l.iface + ')\n'));
});
