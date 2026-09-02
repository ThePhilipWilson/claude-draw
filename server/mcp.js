#!/usr/bin/env node
// claude-draw MCP server (stdio). Dependency-free: implements the JSON-RPC subset
// Claude Code needs rather than pulling in an SDK.
//
// Never write to stdout except protocol messages. Diagnostics go to stderr.

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = parseInt(process.env.CLAUDE_DRAW_PORT || '7331', 10);
const BASE = 'http://127.0.0.1:' + PORT;
// Off by default: loopback only. Opt in with CLAUDE_DRAW_LAN=1 to let other devices
// on the same network open the canvas.
const LAN = /^(1|true|yes|on)$/i.test(process.env.CLAUDE_DRAW_LAN || '');
const DAEMON = path.join(__dirname, 'daemon.js');
const NAME = 'claude-draw';
const VERSION = '1.2.0';

// How long a tool call is willing to sit and wait before handing the turn back. Short
// enough that the user can carry on talking while they draw; long enough that a quick
// sketch still comes back inside the call that asked for it.
const DEFAULT_WAIT = 45;
const MAX_WAIT = 300;

const log = (m) => process.stderr.write('[claude-draw] ' + m + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-flight waits, so an interrupt on the Claude side lets go of the socket instead of
// leaving it hanging. The request itself stays live on the canvas either way.
const inflight = new Map();

// ---- daemon lifecycle -----------------------------------------------------
async function state() {
  try {
    const r = await fetch(BASE + '/state', { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

async function ensureDaemon() {
  let s = await state();
  if (s) return s;
  const args = [DAEMON, '--port', String(PORT)];
  if (LAN) args.push('--lan');
  log('starting daemon: node ' + args.join(' '));
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    s = await state();
    if (s) return s;
  }
  throw new Error('daemon did not come up on port ' + PORT);
}

async function post(route, body, signal) {
  const r = await fetch(BASE + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal
  });
  return r.json();
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch (e) { return false; }
}

// Both addresses, every time, spelled out so they are click-through links in the
// terminal rather than something the user has to reconstruct.
function urlLines(s) {
  const out = ['On this machine: ' + s.urls.local];
  (s.urls.lan || []).forEach((l) => out.push('On another device: ' + l.url + '  (' + l.iface + ')'));
  if (!s.lan) out.push('Other devices: off. Set CLAUDE_DRAW_LAN=1 and restart Claude Code to allow them.');
  else if (!(s.urls.lan || []).length) out.push('Other devices: on, but no non-loopback IPv4 address was found.');
  else if (s.code) out.push('Pairing code for that device: ' + s.code.slice(0, 3) + '-' + s.code.slice(3) +
    '  (asked for once per device, then remembered)');
  return out;
}

// A daemon left over from an earlier session may be bound differently to what is
// configured now. Say so rather than quietly ignoring the setting.
function lanMismatch(s) {
  if (!s || s.lan === LAN) return null;
  return s.lan
    ? 'Note: the running daemon is exposed to the local network but CLAUDE_DRAW_LAN is not set. It started before the setting changed; restart it to bind loopback only.'
    : 'Note: CLAUDE_DRAW_LAN is set but the running daemon is bound to loopback only. It started before the setting changed; restart it to reach it from other devices.';
}

// ---- tools ----------------------------------------------------------------
const TOOLS = [
  {
    name: 'request_drawing',
    description:
      'Ask the user to draw or annotate something. Opens on any device with the canvas page open ' +
      '(phone, tablet, this machine). Pass image_path to have them mark up a screenshot or image; ' +
      'omit it for a blank sketch. Waits a short while for the answer and then hands the turn back ' +
      'with outcome "pending" rather than blocking the conversation: the request stays live on the ' +
      'canvas, the user carries on drawing while you carry on talking, and collect_drawing picks the ' +
      'answer up whenever it lands. Use this whenever a visual or spatial question would be faster ' +
      'pointed at than described: "which element", "where should it go", "what should this look like".',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The specific instruction shown to the user, e.g. "Circle the element that should move and draw an arrow where it goes". Be specific; this is your question and the drawing is their answer.'
        },
        image_path: { type: 'string', description: 'Absolute path to an image to annotate (png/jpg/gif/webp/bmp). Omit for a blank canvas.' },
        wait_seconds: { type: 'number', description: 'How long this call waits before returning "pending" and letting the conversation continue. Default 45, max 300. Use 0 to ask and return immediately.' },
        expires_seconds: { type: 'number', description: 'How long the request stays live on the canvas. Default 1800, max 21600. The user is asked whether they are still there before it lapses, and a lapsed request can still be sent.' },
        out_dir: { type: 'string', description: 'Where to write the resulting PNG, stroke data and caption. Defaults to the system temp dir.' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'collect_drawing',
    description:
      'Pick up the answer to a request_drawing that came back "pending". Returns the drawing if it ' +
      'has arrived, otherwise waits a short while and says it is still being drawn. Call it when the ' +
      'user says they have sent something, or before you act on anything you asked them to mark up. ' +
      'Answers are kept, so a drawing sent while you were doing something else is never lost.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The request id from request_drawing. Omit for the most recent one.' },
        wait_seconds: { type: 'number', description: 'How long to wait if it has not arrived yet. Default 45, max 300. Use 0 to check without waiting.' }
      }
    }
  },
  {
    name: 'draw_status',
    description: 'Check whether the drawing daemon is running, whether a canvas page is connected, and whether anything is waiting to be drawn or waiting to be collected. Gives the URLs to open the canvas on this machine or another device, and the pairing code another device needs.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'open_canvas',
    description: 'Open the canvas page in the default browser on this machine, and report both the local and network URLs.',
    inputSchema: { type: 'object', properties: {} }
  }
];

// How a settled request reads back to Claude. Everything the drawing carries is named
// here, including where the caption and stroke data were written, so nothing has to be
// guessed at from the filename.
function renderResult(out, timedWaited) {
  if (out.outcome === 'drawing') {
    return text([
      'The user submitted a drawing' + (out.late ? ' after the request had lapsed' : '') + '.',
      'Image: ' + out.path,
      'Caption: ' + (out.caption || '(none given)'),
      'Background: ' + out.background + (out.background === 'blank' ? ' (drawn from scratch)' : ' (marks on top of an image)'),
      out.meta_path ? 'Caption, prompt and stroke data together: ' + out.meta_path : '',
      out.strokes_path ? 'Stroke data on its own (' + out.stroke_count + ' marks): ' + out.strokes_path : '',
      '',
      'Read the image now. Describe what you see before acting on it, and trust the caption over your own reading where they disagree.'
    ].filter(Boolean).join('\n'));
  }
  if (out.outcome === 'want_screenshot') {
    return text([
      'The user pressed "Send me a screenshot": they want something to annotate rather than a blank canvas.',
      out.note ? 'What they asked for: ' + out.note : 'They did not say what of, so use the thing you are both currently working on.',
      '',
      'Capture or locate the relevant image now, then call request_drawing again with image_path set to it.',
      'They are waiting on the canvas, so do this straight away rather than asking a follow-up question.'
    ].join('\n'));
  }
  if (out.outcome === 'cancelled') {
    return text('The user skipped this request. Carry on without a drawing; do not ask again unprompted.');
  }
  if (out.outcome === 'timeout') {
    return text([
      'Request ' + out.id + ' lapsed before anything was sent.',
      'It is still on their canvas and anything they draw can still be sent, so try collect_drawing again later.',
      'Do not re-ask unless they say they missed it.'
    ].join('\n'));
  }
  if (out.outcome === 'pending') {
    return text([
      'Request ' + out.id + ' is ' + (out.state === 'queued' ? 'queued behind another one' : 'open on the canvas') + '; nothing sent yet after ' + timedWaited + 's.',
      out.canvases ? 'A canvas page is connected, so they can see it.' : 'No canvas page is connected, so nobody has seen it yet.',
      '',
      'Not blocking. Carry on with the conversation, and call collect_drawing(' + out.id + ') when they say they have sent it or when you next need the answer.'
    ].join('\n'));
  }
  return text('Unexpected outcome: ' + JSON.stringify(out));
}

async function collect(id, wait, callId) {
  // One controller for both the interrupt and the backstop timeout: AbortSignal.any is
  // Node 20+, and this has to run on 18.
  const ac = new AbortController();
  const cap = setTimeout(() => ac.abort(new Error('daemon did not answer in time')), (wait + 20) * 1000);
  if (callId !== undefined) inflight.set(callId, ac);
  try {
    return await post('/collect', { id: id, wait_seconds: wait }, ac.signal);
  } finally {
    clearTimeout(cap);
    if (callId !== undefined) inflight.delete(callId);
  }
}

async function callTool(name, args, callId) {
  args = args || {};

  if (name === 'draw_status') {
    const s = await state();
    if (!s) return text('Daemon is not running. It starts automatically on the next request_drawing call.');
    const lines = [
      'Daemon running (pid ' + s.pid + ', port ' + s.port + ').',
      'Canvas pages connected: ' + s.canvases + (s.canvases ? '' : '  <- nobody is looking at it yet'),
      s.active
        ? 'Open on the canvas now: request ' + s.active.id + (s.active.stale ? ' (lapsed, but still sendable)' : '')
        : 'Idle, waiting for a request.'
    ];
    if (s.queued) lines.push('Queued behind it: ' + s.queued);
    if ((s.uncollected || []).length) {
      lines.push('Drawings waiting to be collected: ' + s.uncollected.join(', ') + '  <- call collect_drawing on these');
    }
    lines.push('');
    return text(lines.concat(urlLines(s), [lanMismatch(s)].filter(Boolean)).join('\n'));
  }

  if (name === 'open_canvas') {
    const s = await ensureDaemon();
    const ok = openBrowser(s.urls.local);
    return text((ok ? 'Opened ' : 'Could not launch a browser. Open ') + s.urls.local + ' manually.\n' + urlLines(s).join('\n'));
  }

  if (name === 'collect_drawing') {
    const s = await state();
    if (!s) return text('Daemon is not running, so there is nothing to collect.', true);
    const wait = Math.max(0, Math.min(MAX_WAIT, args.wait_seconds === undefined ? DEFAULT_WAIT : Number(args.wait_seconds)));
    let out;
    try {
      out = await collect(args.id ? Number(args.id) : null, wait, callId);
    } catch (e) {
      return text('Collect failed: ' + e.message, true);
    }
    if (!out.ok && /no request/.test(out.error || '')) {
      return text('There is no request ' + (args.id || '') + ' to collect. Nothing has been asked for, or it was asked for by a different session.', true);
    }
    if (!out.ok) return text('Collect failed: ' + (out.error || 'unknown'), true);
    return renderResult(out, wait);
  }

  if (name === 'request_drawing') {
    const s = await ensureDaemon();
    if (args.image_path) {
      const p = path.resolve(args.image_path);
      if (!fs.existsSync(p)) return text('No image at ' + p + '. Check the path and try again.', true);
    }
    if (!s.canvases) {
      // Nobody is watching. Try this machine's browser, but say so either way.
      openBrowser(s.urls.local);
    }
    const wait = Math.max(0, Math.min(MAX_WAIT, args.wait_seconds === undefined ? DEFAULT_WAIT : Number(args.wait_seconds)));
    let asked;
    try {
      asked = await post('/request', {
        prompt: args.prompt,
        image_path: args.image_path ? path.resolve(args.image_path) : null,
        out_dir: args.out_dir || null,
        expires_seconds: args.expires_seconds || null
      }, AbortSignal.timeout(10000));
    } catch (e) {
      return text('Request failed: ' + e.message, true);
    }
    if (!asked.ok) return text('Request rejected: ' + (asked.error || 'unknown'), true);

    let out;
    try {
      out = await collect(asked.id, wait, callId);
    } catch (e) {
      // Interrupted or dropped. The request is still live on the canvas, which is the
      // whole point of asking and collecting separately.
      return text('Stopped waiting on request ' + asked.id + ' (' + e.message + '). It is still open on the canvas; call collect_drawing(' + asked.id + ') to pick it up.');
    }
    if (out.outcome === 'pending' && !s.canvases) {
      const now = await state();
      return text([
        'Asked (request ' + out.id + '), but no canvas page is connected, so nobody has seen it.',
        'Ask the user to open one of these and leave the tab open:',
        ''
      ].concat(urlLines(now || s), ['', 'Then call collect_drawing(' + out.id + ').']).join('\n'));
    }
    return renderResult(out, wait);
  }

  return text('Unknown tool: ' + name, true);
}

const text = (t, isError) => ({ content: [{ type: 'text', text: t }], isError: !!isError });

// ---- JSON-RPC over stdio --------------------------------------------------
function write(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: NAME, version: VERSION }
    });
  }
  // An interrupt on the Claude side. Let go of the socket we are holding; the request
  // stays open on the canvas so the user's drawing is not thrown away.
  if (method === 'notifications/cancelled') {
    const ac = inflight.get(params && params.requestId);
    if (ac) { inflight.delete(params.requestId); ac.abort(new Error('cancelled by the client')); }
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const result = await callTool(params && params.name, params && params.arguments, id);
      return reply(id, result);
    } catch (e) {
      return reply(id, text('claude-draw error: ' + e.message, true));
    }
  }
  if (method === 'resources/list') return reply(id, { resources: [] });
  if (method === 'prompts/list') return reply(id, { prompts: [] });
  if (id !== undefined) fail(id, -32601, 'Method not found: ' + method);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { log('bad json: ' + line.slice(0, 120)); continue; }
    Promise.resolve(handle(msg)).catch((e) => log('handler failed: ' + e.message));
  }
});
process.stdin.on('end', () => process.exit(0));
