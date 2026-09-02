#!/usr/bin/env node
// End-to-end test: daemon lifecycle, SSE push, ask/collect, pairing, expiry and the
// MCP stdio layer. Machine-independent: derives everything from this file's location
// and the temp dir.
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
const post = (p, body, base) => fetch((base || BASE) + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});
const postJson = (p, body, base) => post(p, body, base).then((r) => r.json());

// Minimal SSE reader, so we assert the daemon really pushes rather than trusting it.
function sse(onEvent, url) {
  return http.get(url || (BASE + '/events'), (res) => {
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
  check('pairing code readable from loopback', /^\d{6}$/.test(s1.code || ''), s1.code);
  check('pairing demanded of other devices', s1.pair_required === true);

  console.log('\n=== canvas connects (SSE) ===');
  const events = [];
  const stream = sse((ev, data) => events.push({ ev, data }));
  await sleep(400);
  const s2 = await (await fetch(BASE + '/state')).json();
  // Count the change, not the total: a canvas tab left open on this machine from an
  // earlier session is reconnecting to this port every two seconds.
  check('daemon sees the connected canvas', s2.canvases === s1.canvases + 1,
    'canvases=' + s2.canvases + ' (was ' + s1.canvases + ')');
  check('hello sent on connect', events.some((e) => e.ev === 'hello'));
  check('hello reports idle', events.filter((e) => e.ev === 'hello')[0].data.active === null);

  console.log('\n=== asking does not block ===');
  const t0 = Date.now();
  const asked = await postJson('/request', { prompt: 'Circle the wrong bit', image_path: SEED, expires_seconds: 120 });
  check('request accepted and answered immediately', asked.ok === true && !!asked.id, Date.now() - t0 + 'ms');
  await sleep(400);
  const reqEv = events.filter((e) => e.ev === 'request')[0];
  check('request pushed over SSE without a refresh', !!reqEv, reqEv ? JSON.stringify(reqEv.data) : '');
  check('prompt carried', !!reqEv && reqEv.data.prompt === 'Circle the wrong bit');
  check('image url offered', !!reqEv && /^\/image\/\d+$/.test(reqEv.data.image || ''));

  const bytes = Buffer.from(await (await fetch(BASE + reqEv.data.image)).arrayBuffer());
  check('seeded image served intact', bytes.equals(fs.readFileSync(SEED)), bytes.length + ' bytes');

  const nowait = await postJson('/collect', { id: asked.id, wait_seconds: 0 });
  check('collect says pending while they draw', nowait.outcome === 'pending' && nowait.state === 'open');

  const t1 = Date.now();
  const short = await postJson('/collect', { id: asked.id, wait_seconds: 1 });
  const waited = Date.now() - t1;
  check('a bounded wait releases the turn', short.outcome === 'pending' && waited >= 900 && waited < 4000, waited + 'ms');

  console.log('\n=== submit resolves a waiting collector ===');
  const collecting = postJson('/collect', { id: asked.id, wait_seconds: 20 });
  await sleep(200);
  const sub = await postJson('/submit', {
    id: asked.id, png: DATA_URL, caption: 'the header', background: 'seeded', strokes: [{ tool: 'box' }]
  });
  check('submit accepted', sub.ok === true);
  check('canvas told somebody was waiting', sub.waiting === true);

  const result = await collecting;
  check('waiting collect returned the drawing', result.ok === true && result.outcome === 'drawing', 'outcome=' + result.outcome);
  check('png written to disk', fs.existsSync(result.path), path.basename(result.path || ''));
  check('caption returned', result.caption === 'the header');
  check('background kind returned', result.background === 'seeded');
  check('stroke data written', !!result.strokes_path && fs.existsSync(result.strokes_path));

  console.log('\n=== an answer is kept for a late collector ===');
  const beforeCollect = await (await fetch(BASE + '/state')).json();
  check('a drawing handed to a waiting call is not left queued for collection',
    (beforeCollect.uncollected || []).indexOf(asked.id) === -1);
  const late = await postJson('/collect', { id: asked.id, wait_seconds: 0 });
  check('collecting again returns the same drawing', late.outcome === 'drawing' && late.path === result.path);
  const afterCollect = await (await fetch(BASE + '/state')).json();
  check('status stops nagging about a drawing already read', (afterCollect.uncollected || []).indexOf(asked.id) === -1);

  await sleep(300);
  check('page told the request settled (returns to idle)', events.some((e) => e.ev === 'settled'));

  console.log('\n=== stale submit rejected ===');
  const stale = await post('/submit', { id: asked.id, png: DATA_URL });
  check('resubmitting a closed request is refused', stale.status === 409);

  console.log('\n=== second request on the same page ===');
  const asked2 = await postJson('/request', { prompt: 'and again', expires_seconds: 120 });
  await sleep(400);
  const reqs = events.filter((e) => e.ev === 'request');
  check('same page receives a second request live', reqs.length === 2, 'requests seen=' + reqs.length);
  check('blank canvas request has no image', reqs[1].data.image === null);
  await postJson('/cancel', { id: asked2.id });
  check('skip reports cancelled', (await postJson('/collect', { id: asked2.id, wait_seconds: 0 })).outcome === 'cancelled');

  console.log('\n=== "send me a screenshot" ===');
  const asked3 = await postJson('/request', { prompt: 'mark the bug', expires_seconds: 120 });
  await sleep(400);
  check('third request pushed', events.filter((e) => e.ev === 'request').length === 3);
  await postJson('/screenshot', { id: asked3.id, note: 'the settings panel' });
  const shot = await postJson('/collect', { id: asked3.id, wait_seconds: 0 });
  check('screenshot ask unblocks the request', shot.outcome === 'want_screenshot', 'outcome=' + shot.outcome);
  check('note carried back to Claude', shot.note === 'the settings panel');
  await sleep(200);
  check('page told to return to idle', events.filter((e) => e.ev === 'settled').length === 3);

  console.log('\n=== running out of time keeps the drawing ===');
  const asked4 = await postJson('/request', { prompt: 'slow one', expires_seconds: 10 });
  await sleep(5600);
  const warn = events.filter((e) => e.ev === 'expiring')[0];
  check('canvas warned before the deadline', !!warn && warn.data.id === asked4.id, warn ? warn.data.seconds_left + 's left' : 'no warning');

  const extended = await postJson('/extend', { id: asked4.id, seconds: 60 });
  check('"still drawing" pushes the deadline out', extended.ok === true);
  await sleep(300);
  check('canvas told the deadline moved', events.some((e) => e.ev === 'extended'));
  const stillOpen = await postJson('/collect', { id: asked4.id, wait_seconds: 0 });
  check('request still open after extending', stillOpen.outcome === 'pending');

  const asked5Id = asked4.id;
  await postJson('/extend', { id: asked5Id, seconds: 10 });
  await sleep(10600);
  const lapsed = await postJson('/collect', { id: asked5Id, wait_seconds: 0 });
  check('lapsing answers Claude with a timeout', lapsed.outcome === 'timeout');
  check('canvas told it lapsed rather than being closed', events.some((e) => e.ev === 'expired'));
  check('lapsed request is still the open one, not discarded',
    (await (await fetch(BASE + '/state')).json()).active.stale === true);
  const lateSend = await postJson('/submit', {
    id: asked5Id, png: DATA_URL, caption: 'sent late', background: 'blank', strokes: []
  });
  check('a lapsed request still accepts the drawing', lateSend.ok === true);
  check('canvas told nobody was waiting for it', lateSend.waiting === false);
  const recovered = await postJson('/collect', { id: asked5Id, wait_seconds: 0 });
  check('the late drawing replaces the timeout', recovered.outcome === 'drawing' && recovered.late === true);
  check('late caption survived', recovered.caption === 'sent late');

  console.log('\n=== bad input ===');
  const missing = await postJson('/request', { prompt: 'x', image_path: path.join(OUT, 'nope.png') });
  check('missing seed image rejected with a reason', missing.ok === false && /not found/.test(missing.error || ''));
  const unknown = await post('/collect', { id: 99999, wait_seconds: 0 });
  check('collecting a request that never existed 404s', unknown.status === 404);

  stream.destroy();

  console.log('\n=== another device has to pair ===');
  // Reaching the daemon by its LAN address makes this connection non-loopback, which
  // is exactly what a phone on the same Wi-Fi looks like to it.
  const LAN_BASE = (s1.urls.lan[0] || {}).url ? s1.urls.lan[0].url.replace(/\/$/, '') : null;
  if (!LAN_BASE) {
    console.log('  SKIP  no LAN address on this machine');
  } else {
    const page = await fetch(LAN_BASE + '/');
    check('the page itself still loads unpaired', page.status === 200);
    const blocked = await fetch(LAN_BASE + '/state');
    check('state refused before pairing', blocked.status === 401);
    const blockedBody = await blocked.json();
    check('refusal says to pair', blockedBody.pair === true);
    const wrong = await post('/pair', { code: '000000' === s1.code ? '111111' : '000000' }, LAN_BASE);
    check('a wrong code is refused', wrong.status === 403);
    const paired = await postJson('/pair', { code: s1.code }, LAN_BASE);
    check('the right code hands back a token', paired.ok === true && (paired.token || '').length > 20);
    const withToken = await fetch(LAN_BASE + '/state', { headers: { 'x-draw-token': paired.token } });
    check('the token unlocks the session', withToken.status === 200);
    const withQuery = await fetch(LAN_BASE + '/state?token=' + paired.token);
    check('a token in the query string works too (EventSource cannot set headers)', withQuery.status === 200);
    const remoteState = await withToken.json();
    check('the code is not readable from another device', remoteState.code === null);
    const drive = await fetch(LAN_BASE + '/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-draw-token': paired.token },
      body: JSON.stringify({ prompt: 'from the phone' })
    });
    check('a paired device still cannot drive the session', drive.status === 403, 'status=' + drive.status);
    const stranger = await post('/request', { prompt: 'from a stranger' }, LAN_BASE);
    check('an unpaired device is turned away earlier still', stranger.status === 401, 'status=' + stranger.status);
  }

  console.log('\n=== LAN exposure is opt-in ===');
  const LOOP_PORT = PORT + 1;
  const d2 = spawn(process.execPath, [path.join(ROOT, 'server', 'daemon.js'), '--port', String(LOOP_PORT), '--out', OUT],
    { stdio: ['ignore', 'ignore', 'pipe'], env: Object.assign({}, process.env, { CLAUDE_DRAW_LAN: '' }) });
  d2.stderr.on('data', (b) => process.stdout.write('  [daemon2:err] ' + b));
  await sleep(900);
  const s5 = await (await fetch('http://127.0.0.1:' + LOOP_PORT + '/state')).json().catch(() => null);
  check('default daemon comes up', !!s5 && s5.ok === true);
  check('default is loopback only', !!s5 && s5.lan === false);
  check('no LAN address advertised by default', !!s5 && (s5.urls.lan || []).length === 0);
  check('no pairing to do when nothing else can reach it', !!s5 && s5.pair_required === false);
  await fetch('http://127.0.0.1:' + LOOP_PORT + '/shutdown', { method: 'POST', body: '{}' }).catch(() => {});
  await sleep(300);
  d2.kill();

  console.log('\n=== MCP stdio layer ===');
  // A page has to be watching again, or every ask below reports an empty room.
  const stream2 = sse(() => {});
  await sleep(300);
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
  const said = (id) => (got(id) ? got(id).result.content[0].text : '');

  rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  await sleep(500);
  check('initialize answered', !!got(1) && !!got(1).result, got(1) ? got(1).result.serverInfo.name : '');
  check('protocol version echoed', !!got(1) && got(1).result.protocolVersion === '2025-06-18');
  check('declares tools capability', !!got(1) && !!got(1).result.capabilities.tools);

  rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await sleep(300);
  const names = got(2) ? got(2).result.tools.map((t) => t.name) : [];
  check('tools/list offers ask, collect, status and open', names.length === 4, names.join(', '));
  check('collect_drawing is offered', names.indexOf('collect_drawing') !== -1);
  check('request_drawing requires a prompt', !!got(2) && got(2).result.tools[0].inputSchema.required[0] === 'prompt');

  rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'draw_status', arguments: {} } });
  await sleep(700);
  check('draw_status works through MCP', /Daemon running/.test(said(3)));
  check('draw_status gives the pairing code', /Pairing code/.test(said(3)));

  rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'request_drawing', arguments: { image_path: path.join(OUT, 'nope.png'), prompt: 'x' } } });
  await sleep(500);
  check('missing image reported as a clean error', !!got(4) && got(4).result.isError === true);

  console.log('\n--- asking through MCP hands the turn back ---');
  const t2 = Date.now();
  rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'request_drawing', arguments: { prompt: 'sketch it', wait_seconds: 1 } } });
  await sleep(3000);
  check('request_drawing returns without blocking', !!got(6), Date.now() - t2 + 'ms');
  check('it says it is not blocking and how to pick it up', /Not blocking/.test(said(6)) && /collect_drawing/.test(said(6)));
  const openId = ((await (await fetch(BASE + '/state')).json()).active || {}).id;
  check('the request is still live on the canvas', !!openId);

  await postJson('/submit', { id: openId, png: DATA_URL, caption: 'here you go', background: 'blank', strokes: [] });
  rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'collect_drawing', arguments: { id: openId, wait_seconds: 0 } } });
  await sleep(700);
  check('collect_drawing picks up the drawing sent meanwhile', /submitted a drawing/.test(said(7)));
  check('collect_drawing reports the caption', /here you go/.test(said(7)));

  console.log('\n--- an interrupt lets go of the socket ---');
  rpc({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'request_drawing', arguments: { prompt: 'take your time', wait_seconds: 120 } } });
  await sleep(1200);
  const liveId = ((await (await fetch(BASE + '/state')).json()).active || {}).id;
  rpc({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 8, reason: 'user pressed escape' } });
  await sleep(800);
  check('a cancelled call answers instead of hanging', !!got(8));
  check('it says the request is still open', /still open on the canvas/.test(said(8)));
  const afterCancel = await (await fetch(BASE + '/state')).json();
  check('the interrupt did not strand the canvas', (afterCancel.active || {}).id === liveId);
  await postJson('/cancel', { id: liveId });

  rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  await sleep(300);
  check('unknown tool handled without crashing', !!got(9));

  m.kill();
  stream2.destroy();
  await post('/shutdown', {}).catch(() => {});
  await sleep(300);
  d.kill();
  try { fs.rmSync(OUT, { recursive: true, force: true }); } catch (e) { /* best effort */ }

  console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
