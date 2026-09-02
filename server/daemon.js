#!/usr/bin/env node
// claude-draw daemon. Long-lived: holds the canvas page open between requests so it
// never lands on a dead terminal state. Dependency-free (http + fs only).
//
//   node daemon.js [--port 7331] [--lan] [--out <dir>]
//
// Binds loopback only by default. --lan (or CLAUDE_DRAW_LAN=1) binds 0.0.0.0 so other
// devices on the same network can open the canvas. Those devices must pair with the
// six-digit code printed here before they see anything.
//
// Claude talks to it over loopback. Asking (POST /request) and waiting for the answer
// (POST /collect) are separate calls, so Claude is never stuck holding a socket open
// while the user draws. Browsers hold a GET /events SSE stream and are pushed each new
// request as it arrives.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.indexOf(n) !== -1;

const PORT = parseInt(flag('--port', process.env.CLAUDE_DRAW_PORT || '7331'), 10);
// Loopback only unless LAN exposure is asked for explicitly, by flag or env.
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));
const HOST = (has('--lan') || truthy(process.env.CLAUDE_DRAW_LAN)) ? '0.0.0.0' : '127.0.0.1';
const DEFAULT_OUT = flag('--out', path.join(os.tmpdir(), 'claude-draw'));
const CANVAS = path.join(__dirname, 'canvas.html');

// How long a request stays live on the canvas before it goes stale, and how much a
// "yes I'm still here" adds. Generous on purpose: running out of time should be rare,
// and when it happens nothing drawn is thrown away.
const DEFAULT_EXPIRY = 1800;
const MAX_EXPIRY = 21600;
const EXTEND_BY = 900;
const WARN_BEFORE = 120;

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp'
};

// ---- state ----------------------------------------------------------------
let seq = 0;
let active = null;      // { id, prompt, imagePath, outDir, timers, expiresAt, stale }
const queue = [];       // pending requests waiting their turn
const clients = new Set();
const results = new Map();   // id -> settled result, kept so a late collect still finds it
const waiters = new Map();   // id -> [ { res, timer } ], Claude-side collectors
const RESULTS_MAX = 40;

// Pairing. Devices that are not on loopback trade this code for a token once, then
// remember the token, so a phone pairs on its first visit and not again after that.
const CODE = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const tokens = new Set();
let badAttempts = 0, lockedUntil = 0;

function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function tokenOf(req, url) {
  const q = req.url.indexOf('?') !== -1 ? new URLSearchParams(req.url.slice(req.url.indexOf('?') + 1)) : null;
  return req.headers['x-draw-token'] || (q && q.get('token')) || '';
}

// Loopback is trusted: it is the machine Claude is running on. Everything else pairs.
function authed(req) {
  return isLocal(req) || tokens.has(tokenOf(req));
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
  return {
    id: r.id,
    prompt: r.prompt || null,
    image: r.imagePath ? '/image/' + r.id : null,
    expires_at: r.expiresAt || null,
    stale: !!r.stale
  };
}

// ---- request lifecycle ----------------------------------------------------
function armTimers(r) {
  clearTimeout(r.warnTimer); clearTimeout(r.expireTimer);
  const left = r.expiresAt - Date.now();
  // Warn well before the deadline, but never later than halfway through a short window.
  const warnIn = left - Math.min(WARN_BEFORE * 1000, r.expiresMs / 2);
  if (warnIn > 0) {
    r.warnTimer = setTimeout(() => {
      if (active === r && !r.stale) push('expiring', { id: r.id, seconds_left: Math.round((r.expiresAt - Date.now()) / 1000) });
    }, warnIn);
  }
  r.expireTimer = setTimeout(() => { if (active === r) goStale(r); }, Math.max(0, left));
}

// Running out of time answers Claude, but does not clear the canvas. Whatever the user
// has drawn stays exactly where it is and can still be sent; it just gets picked up on
// Claude's next turn instead of unblocking a waiting call.
function goStale(r) {
  r.stale = true;
  clearTimeout(r.warnTimer); clearTimeout(r.expireTimer);
  resolve(r.id, { ok: true, outcome: 'timeout', id: r.id });
  push('expired', { id: r.id });
}

function activateNext() {
  if (active || !queue.length) return;
  active = queue.shift();
  active.startedAt = Date.now();
  active.expiresAt = active.startedAt + active.expiresMs;
  armTimers(active);
  push('request', describe(active));
}

// Answer anyone waiting on this request, and remember the answer for anyone who asks
// later. Claude may well have moved on by the time the drawing arrives.
function resolve(id, result) {
  results.set(id, result);
  while (results.size > RESULTS_MAX) results.delete(results.keys().next().value);
  const list = waiters.get(id) || [];
  waiters.delete(id);
  list.forEach((w) => {
    clearTimeout(w.timer);
    if (!w.res.writableEnded) json(w.res, 200, result);
  });
  if (list.length) result.collected = true;
  return list.length;
}

// Take the request off the canvas.
function close(r, outcome) {
  if (active !== r) return;
  active = null;
  clearTimeout(r.warnTimer); clearTimeout(r.expireTimer);
  push('settled', { id: r.id, outcome: outcome });
  activateNext();
}

function findRequest(id) {
  id = String(id);
  if (active && String(active.id) === id) return active;
  return queue.filter((q) => String(q.id) === id)[0] || null;
}

// ---- server ---------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // The page itself is always served: it has to load before it can ask to pair.
  if (req.method === 'GET' && url === '/') {
    return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(CANVAS));
  }

  if (req.method === 'POST' && url === '/pair') {
    return readBody(req, 1 << 12, (err, body) => {
      if (isLocal(req)) return json(res, 200, { ok: true, token: '', local: true });
      if (Date.now() < lockedUntil) {
        return json(res, 429, { ok: false, error: 'too many wrong codes; try again in a minute' });
      }
      const given = String((body && body.code) || '').replace(/\D/g, '');
      const a = Buffer.from(given.padEnd(6, ' ').slice(0, 6));
      const b = Buffer.from(CODE);
      if (given.length !== 6 || !crypto.timingSafeEqual(a, b)) {
        if (++badAttempts >= 8) { lockedUntil = Date.now() + 60000; badAttempts = 0; }
        return json(res, 403, { ok: false, error: 'wrong code' });
      }
      badAttempts = 0;
      const token = crypto.randomBytes(24).toString('hex');
      tokens.add(token);
      process.stdout.write('claude-draw: paired ' + (req.socket.remoteAddress || 'a device') + '\n');
      return json(res, 200, { ok: true, token: token });
    });
  }

  if (!authed(req)) return json(res, 401, { ok: false, error: 'pair required', pair: true });

  if (req.method === 'GET' && url === '/state') {
    return json(res, 200, {
      ok: true, pid: process.pid, port: PORT, lan: HOST === '0.0.0.0',
      canvases: clients.size, active: describe(active), queued: queue.length,
      pending: [].concat(active ? [active.id] : [], queue.map((q) => q.id)),
      // Drawings that arrived while Claude was busy and have not been read back yet.
      uncollected: [...results.keys()].filter((id) => {
        const r = results.get(id) || {};
        return r.outcome === 'drawing' && !r.collected;
      }),
      // Only the machine Claude runs on gets to read the code out.
      code: isLocal(req) ? CODE : null,
      pair_required: HOST === '0.0.0.0',
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
    res.write('event: hello\ndata: ' + JSON.stringify({ active: describe(active), urls: addresses() }) + '\n\n');
    // A real event, not a comment: the page listens for these to notice a socket that
    // died quietly, which is what a backgrounded phone browser does to it.
    const ka = setInterval(() => {
      try { res.write('event: ping\ndata: {}\n\n'); } catch (e) { /* dropped */ }
    }, 20000);
    // Watch the response, not the request: for a GET with no body, the request stream
    // is finished the moment it arrives.
    res.on('close', () => { clearInterval(ka); clients.delete(res); });
    return;
  }

  if (req.method === 'GET' && url.indexOf('/image/') === 0) {
    const r = findRequest(url.slice('/image/'.length));
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
      const secs = Math.max(10, Math.min(MAX_EXPIRY, parseInt(body.expires_seconds, 10) || DEFAULT_EXPIRY));
      const r = {
        id: ++seq,
        prompt: body.prompt || null,
        imagePath: imagePath,
        outDir: path.resolve(body.out_dir || DEFAULT_OUT),
        createdAt: Date.now(),
        expiresMs: secs * 1000,
        stale: false
      };
      fs.mkdirSync(r.outDir, { recursive: true });
      queue.push(r);
      // Answer straight away. Waiting is /collect's job, so nothing here holds a socket
      // open across the whole time the user spends drawing.
      json(res, 200, { ok: true, id: r.id, queued: !!active, canvases: clients.size, expires_seconds: secs });
      activateNext();
    });
  }

  // Claude side. Waits up to wait_seconds for an answer, then says "still drawing"
  // rather than hanging on. Safe to call again; the answer is kept either way.
  if (req.method === 'POST' && url === '/collect') {
    if (!isLocal(req)) return json(res, 403, { ok: false, error: 'local only' });
    return readBody(req, 1 << 16, (err, body) => {
      body = body || {};
      const id = body.id ? parseInt(body.id, 10) : (active ? active.id : seq);
      if (results.has(id)) {
        const known = results.get(id);
        known.collected = true;
        return json(res, 200, known);
      }
      const r = findRequest(id);
      if (!r) return json(res, 404, { ok: false, error: 'no request ' + id });
      const wait = Math.max(0, Math.min(600, parseInt(body.wait_seconds, 10) || 0));
      const state = active === r ? (r.stale ? 'stale' : 'open') : 'queued';
      if (!wait) return json(res, 200, { ok: true, outcome: 'pending', id: id, state: state, canvases: clients.size });
      const entry = { res: res };
      entry.timer = setTimeout(() => {
        const list = (waiters.get(id) || []).filter((w) => w !== entry);
        list.length ? waiters.set(id, list) : waiters.delete(id);
        if (!res.writableEnded) {
          json(res, 200, {
            ok: true, outcome: 'pending', id: id,
            state: active === r ? (r.stale ? 'stale' : 'open') : 'queued',
            canvases: clients.size
          });
        }
      }, wait * 1000);
      waiters.set(id, (waiters.get(id) || []).concat([entry]));
      // Only a connection that dropped before we answered counts as giving up. The
      // request stream itself is already complete by this point.
      res.on('close', () => {
        if (res.writableEnded) return;
        clearTimeout(entry.timer);
        const list = (waiters.get(id) || []).filter((w) => w !== entry);
        list.length ? waiters.set(id, list) : waiters.delete(id);
      });
    });
  }

  if (req.method === 'POST' && url === '/submit') {
    return readBody(req, 64 << 20, (err, body) => {
      if (err || !body || !body.png) return json(res, 400, { ok: false, error: 'no image' });
      const r = active;
      if (!r || String(r.id) !== String(body.id)) {
        return json(res, 409, { ok: false, error: 'that request is no longer open' });
      }
      const written = writeSubmission(r, body);
      const waiting = resolve(r.id, written.result);
      json(res, 200, { ok: true, waiting: waiting > 0, stale: r.stale });
      close(r, 'drawing');
    });
  }

  // Still here, just slow. Pushes the deadline out rather than losing the drawing.
  if (req.method === 'POST' && url === '/extend') {
    return readBody(req, 1 << 12, (err, body) => {
      const r = active;
      if (!r || !body || String(r.id) !== String(body.id)) return json(res, 409, { ok: false, error: 'not the open request' });
      const add = Math.max(10, Math.min(MAX_EXPIRY, parseInt(body.seconds, 10) || EXTEND_BY));
      r.stale = false;
      r.expiresMs = add * 1000;
      r.expiresAt = Date.now() + r.expiresMs;
      results.delete(r.id);   // it may have already been answered with a timeout
      armTimers(r);
      json(res, 200, { ok: true, expires_at: r.expiresAt });
      push('extended', { id: r.id, expires_at: r.expiresAt });
    });
  }

  // The user wants something to annotate and would rather Claude produced it. Settles the
  // open request so Claude is unblocked and can come back with an image.
  if (req.method === 'POST' && url === '/screenshot') {
    return readBody(req, 1 << 16, (err, body) => {
      const r = active;
      if (!r || !body || String(r.id) !== String(body.id)) return json(res, 409, { ok: false, error: 'not the open request' });
      const result = { ok: true, outcome: 'want_screenshot', id: r.id, note: String(body.note || '').trim() };
      const waiting = resolve(r.id, result);
      json(res, 200, { ok: true, waiting: waiting > 0 });
      close(r, 'want_screenshot');
    });
  }

  if (req.method === 'POST' && url === '/cancel') {
    return readBody(req, 1 << 16, (err, body) => {
      const r = active;
      if (!r || !body || String(r.id) !== String(body.id)) return json(res, 409, { ok: false, error: 'not the open request' });
      resolve(r.id, { ok: true, outcome: 'cancelled', id: r.id });
      json(res, 200, { ok: true });
      close(r, 'cancelled');
    });
  }

  if (req.method === 'POST' && url === '/shutdown') {
    if (!isLocal(req)) return json(res, 403, { ok: false, error: 'local only' });
    json(res, 200, { ok: true });
    return setTimeout(() => process.exit(0), 100);
  }

  send(res, 404, 'text/plain', 'not found');
});

// ---- writing a submission -------------------------------------------------
// Three files per drawing, because the PNG is the only part that can be reconstructed
// from a screenshot afterwards. The caption exists for one moment only, so it goes to
// disk before anything else can go wrong, and again into an append-only log.
function writeSubmission(r, body) {
  const stem = 'draw-' + stamp(r.id);
  const pngPath = path.join(r.outDir, stem + '.png');
  fs.writeFileSync(pngPath, Buffer.from(String(body.png).replace(/^data:image\/png;base64,/, ''), 'base64'));

  const caption = String(body.caption || '').trim();
  const strokes = Array.isArray(body.strokes) ? body.strokes : [];
  const meta = {
    schema: 'claude-draw/submission@1',
    id: r.id,
    at: new Date().toISOString(),
    prompt: r.prompt || null,
    caption: caption,
    background: body.background || 'blank',
    canvas: { width: body.width || null, height: body.height || null },
    png: pngPath,
    stroke_count: strokes.length,
    note: 'Every stroke carries its colour under both "colour" and "color"; they are the same value.',
    strokes: strokes
  };
  const metaPath = path.join(r.outDir, stem + '.json');
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  let strokesPath = null;
  if (strokes.length) {
    strokesPath = path.join(r.outDir, stem + '.strokes.json');
    fs.writeFileSync(strokesPath, JSON.stringify(strokes));
  }

  // Append-only, one line per drawing, so a caption survives even if the reply to
  // Claude never lands.
  try {
    fs.appendFileSync(path.join(r.outDir, 'log.jsonl'), JSON.stringify({
      at: meta.at, id: r.id, prompt: meta.prompt, caption: caption,
      background: meta.background, png: pngPath, meta: metaPath, strokes: strokesPath
    }) + '\n');
  } catch (e) { /* logging must never fail a submission */ }

  return {
    result: {
      ok: true, outcome: 'drawing', id: r.id,
      path: pngPath, meta_path: metaPath, strokes_path: strokesPath,
      caption: caption, prompt: meta.prompt,
      background: meta.background, stroke_count: strokes.length,
      late: !!r.stale
    }
  };
}

function stamp(id) {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' +
         p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + '-' + (id || 0);
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
  if (HOST === '0.0.0.0') process.stdout.write('  pairing code: ' + CODE.slice(0, 3) + '-' + CODE.slice(3) + '\n');
});
