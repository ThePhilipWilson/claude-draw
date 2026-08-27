#!/usr/bin/env node
// End-to-end test: daemon lifecycle, SSE push, submit/skip, and the MCP stdio layer.
// Machine-independent: derives everything from this file's location and the temp dir.
//
//   node test/e2e.js
//
// Exits non-zero on any failure, so it works as a pre-commit or CI gate.

'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.TEST_PORT || '7333', 10);
const BASE = 'http://127.0.0.1:' + PORT;
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-draw-test-'));
const SEED = path.join(OUT, 'seed.png');

// A 2x2 PNG, enough to prove the seeding path serves bytes back intact.
const TINY = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYEJRIAAIxUCBSNBP0oAAAAASUVORK5CYII=',
  'base64'
);
fs.writeFileSync(SEED, TINY);
const DATA_URL = 'data:image/png;base64,' + TINY.toString('base64');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, extra) {
  ok ? pass++ : fail++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra ? '   ' + extra : ''));
}
const post = (p, body) => fetch(BASE + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

// Minimal SSE reader, so we assert the daemon really pushes rather than trusting it.
function sse(onEvent) {
  return http.get(BASE + '/events', (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = (block.match(/^event: (.+)$/m) || [])[1];
        const data = (block.match(/^data: (.+)$/m) || [])[1];
        if (ev) onEvent(ev, data ? JSON.parse(data) : null);
      }
    });
  });
}

(async () => {
  console.log('\nclaude-draw e2e   root=' + ROOT + '\n');
  console.log('=== daemon ===');
  const d = spawn(process.execPath, [path.join(ROOT, 'server', 'daemon.js'), '--port', String(PORT), '--lan', '--out', OUT],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  d.stdout.on('data', (b) => process.stdout.write('  [daemon] ' + b));
  d.stderr.on('data', (b) => process.stdout.write('  [daemon:err] ' + b));
  await sleep(900);

  const s1 = await (await fetch(BASE + '/state')).json().catch(() => null);
  check('daemon up, reports state', !!s1 && s1.ok === true, s1 ? 'canvases=' + s1.canvases : 'no response');
  if (!s1) { d.kill(); process.exit(1); }
  check('LAN address advertised', Array.isArray(s1.urls.lan) && s1.urls.lan.length > 0, (s1.urls.lan[0] || {}).url);

  console.log('\n=== canvas connects (SSE) ===');
  const events = [];
  const stream = sse((ev, data) => events.push({ ev, data }));
  await sleep(400);
  const s2 = await (await fetch(BASE + '/state')).json();
  check('daemon sees the connected canvas', s2.canvases === 1, 'canvases=' + s2.canvases);
  check('hello sent on connect', events.some((e) => e.ev === 'hello'));
  check('hello reports idle', events.filter((e) => e.ev === 'hello')[0].data.active === null);

  console.log('\n=== request pushed to the open page ===');
  const pending = post('/request', { prompt: 'Circle the wrong bit', image_path: SEED, timeout_seconds: 60 }).then((r) => r.json());
  await sleep(500);
  const reqEv = events.filter((e) => e.ev === 'request')[0];
  check('request pushed over SSE without a refresh', !!reqEv, reqEv ? JSON.stringify(reqEv.data) : '');
  check('prompt carried', !!reqEv && reqEv.data.prompt === 'Circle the wrong bit');
  check('image url offered', !!reqEv && /^\/image\/\d+$/.test(reqEv.data.image || ''));

  const bytes = Buffer.from(await (await fetch(BASE + reqEv.data.image)).arrayBuffer());
  check('seeded image served intact', bytes.equals(fs.readFileSync(SEED)), bytes.length + ' bytes');

  console.log('\n=== submit resolves the waiting request ===');
  const sub = await (await post('/submit', {
    id: reqEv.data.id, png: DATA_URL, caption: 'the header', background: 'seeded', strokes: [{ tool: 'box' }]
  })).json();
  check('submit accepted', sub.ok === true);

  const result = await pending;
  check('blocked /request returned', result.ok === true, 'outcome=' + result.outcome);
  check('outcome is a drawing', result.outcome === 'drawing');
  check('png written to disk', fs.existsSync(result.path), path.basename(result.path || ''));
  check('caption returned', result.caption === 'the header');
  check('background kind returned', result.background === 'seeded');
  check('stroke data written', !!result.strokes_path && fs.existsSync(result.strokes_path));

  await sleep(300);
  check('page told the request settled (returns to idle)', events.some((e) => e.ev === 'settled'));

  console.log('\n=== stale submit rejected ===');
  const stale = await post('/submit', { id: reqEv.data.id, png: DATA_URL });
  check('resubmitting a closed request is refused', stale.status === 409);

  console.log('\n=== second request on the same page ===');
  const pending2 = post('/request', { prompt: 'and again', timeout_seconds: 30 }).then((r) => r.json());
  await sleep(400);
  const reqs = events.filter((e) => e.ev === 'request');
  check('same page receives a second request live', reqs.length === 2, 'requests seen=' + reqs.length);
  check('blank canvas request has no image', reqs[1].data.image === null);
  await post('/cancel', { id: reqs[1].data.id });
  check('skip reports cancelled', (await pending2).outcome === 'cancelled');

  console.log('\n=== bad input ===');
  const missing = await (await post('/request', { prompt: 'x', image_path: path.join(OUT, 'nope.png') })).json();
  check('missing seed image rejected with a reason', missing.ok === false && /not found/.test(missing.error || ''));

  stream.destroy();

  console.log('\n=== MCP stdio layer ===');
  const m = spawn(process.execPath, [path.join(ROOT, 'server', 'mcp.js')], {
    stdio: ['pipe', 'pipe', 'pipe'], env: Object.assign({}, process.env, { CLAUDE_DRAW_PORT: String(PORT) })
  });
  const replies = [];
  let mbuf = '';
  m.stdout.setEncoding('utf8');
  m.stdout.on('data', (c) => {
    mbuf += c;
    let i;
    while ((i = mbuf.indexOf('\n')) !== -1) {
      const line = mbuf.slice(0, i).trim(); mbuf = mbuf.slice(i + 1);
      if (line) replies.push(JSON.parse(line));
    }
  });
  m.stderr.on('data', (b) => process.stdout.write('  [mcp:err] ' + b));
  const rpc = (o) => m.stdin.write(JSON.stringify(o) + '\n');
  const got = (id) => replies.find((r) => r.id === id);

  rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  await sleep(500);
  check('initialize answered', !!got(1) && !!got(1).result, got(1) ? got(1).result.serverInfo.name : '');
  check('protocol version echoed', !!got(1) && got(1).result.protocolVersion === '2025-06-18');
  check('declares tools capability', !!got(1) && !!got(1).result.capabilities.tools);

  rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await sleep(300);
  const names = got(2) ? got(2).result.tools.map((t) => t.name) : [];
  check('tools/list returns the three tools', names.length === 3, names.join(', '));
  check('request_drawing requires a prompt', !!got(2) && got(2).result.tools[0].inputSchema.required[0] === 'prompt');

  rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'draw_status', arguments: {} } });
  await sleep(600);
  check('draw_status works through MCP', !!got(3) && /Daemon running/.test(got(3).result.content[0].text));

  rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'request_drawing', arguments: { image_path: path.join(OUT, 'nope.png'), prompt: 'x' } } });
  await sleep(500);
  check('missing image reported as a clean error', !!got(4) && got(4).result.isError === true);

  rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  await sleep(300);
  check('unknown tool handled without crashing', !!got(5));

  m.kill();
  await post('/shutdown', {}).catch(() => {});
  await sleep(300);
  d.kill();
  try { fs.rmSync(OUT, { recursive: true, force: true }); } catch (e) { /* best effort */ }

  console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
