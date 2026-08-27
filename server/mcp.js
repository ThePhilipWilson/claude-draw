#!/usr/bin/env node
// claude-draw MCP server (stdio). Dependency-free: implements the JSON-RPC subset
// Claude Code needs rather than pulling in an SDK.
//
// Never write to stdout except protocol messages. Diagnostics go to stderr.

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = parseInt(process.env.CLAUDE_DRAW_PORT || '7331', 10);
const BASE = 'http://127.0.0.1:' + PORT;
const LAN = process.env.CLAUDE_DRAW_LAN !== '0';
const DAEMON = path.join(__dirname, 'daemon.js');
const NAME = 'claude-draw';
const VERSION = '1.0.0';

const log = (m) => process.stderr.write('[claude-draw] ' + m + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch (e) { return false; }
}

function urlLines(s) {
  const out = ['Local: ' + s.urls.local];
  (s.urls.lan || []).forEach((l) => out.push('Other devices: ' + l.url + '  (' + l.iface + ')'));
  return out;
}

// ---- tools ----------------------------------------------------------------
const TOOLS = [
  {
    name: 'request_drawing',
    description:
      'Ask the user to draw or annotate something, and wait for their answer. Opens on any device ' +
      'with the canvas page open (phone, tablet, Chromebook, this machine). Pass image_path to have ' +
      'them mark up a screenshot or image; omit it for a blank sketch. Blocks until they submit, skip, ' +
      'or the timeout passes. Use this whenever a visual or spatial question would be faster pointed at ' +
      'than described: "which element", "where should it go", "what should this look like".',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The specific instruction shown to the user, e.g. "Circle the element that should move and draw an arrow where it goes". Be specific; this is your question and the drawing is their answer.'
        },
        image_path: { type: 'string', description: 'Absolute path to an image to annotate (png/jpg/gif/webp/bmp). Omit for a blank canvas.' },
        timeout_seconds: { type: 'number', description: 'How long to wait. Default 600, max 3600.' },
        out_dir: { type: 'string', description: 'Where to write the resulting PNG. Defaults to the system temp dir.' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'draw_status',
    description: 'Check whether the drawing daemon is running and whether a canvas page is currently connected, and get the URLs to open it on this machine or another device.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'open_canvas',
    description: 'Open the canvas page in the default browser on this machine. Only useful when the user is at this computer; on another device they open the LAN URL instead.',
    inputSchema: { type: 'object', properties: {} }
  }
];

async function callTool(name, args) {
  args = args || {};

  if (name === 'draw_status') {
    const s = await state();
    if (!s) return text('Daemon is not running. It starts automatically on the next request_drawing call.');
    return text([
      'Daemon running (pid ' + s.pid + ', port ' + s.port + ').',
      'Canvas pages connected: ' + s.canvases + (s.canvases ? '' : '  <- nobody is looking at it yet'),
      s.active ? 'A request is currently open on the canvas.' : 'Idle, waiting for a request.',
      ''
    ].concat(urlLines(s)).join('\n'));
  }

  if (name === 'open_canvas') {
    const s = await ensureDaemon();
    const ok = openBrowser(s.urls.local);
    return text((ok ? 'Opened ' : 'Could not launch a browser. Open ') + s.urls.local + ' manually.\n' + urlLines(s).join('\n'));
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
    const timeout = Math.max(30, Math.min(3600, Number(args.timeout_seconds) || 600));
    let r;
    try {
      r = await fetch(BASE + '/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: args.prompt,
          image_path: args.image_path ? path.resolve(args.image_path) : null,
          out_dir: args.out_dir || null,
          timeout_seconds: timeout
        }),
        signal: AbortSignal.timeout((timeout + 30) * 1000)
      });
    } catch (e) {
      return text('Request failed: ' + e.message, true);
    }
    const out = await r.json();
    if (!out.ok) return text('Request rejected: ' + (out.error || 'unknown'), true);

    if (out.outcome === 'drawing') {
      return text([
        'The user submitted a drawing.',
        'Image: ' + out.path,
        'Caption: ' + (out.caption || '(none given)'),
        'Background: ' + out.background + (out.background === 'blank' ? ' (drawn from scratch)' : ' (marks on top of an image)'),
        out.strokes_path ? 'Stroke data: ' + out.strokes_path : '',
        '',
        'Read the image now. Describe what you see before acting on it, and trust the caption over your own reading where they disagree.'
      ].filter(Boolean).join('\n'));
    }
    if (out.outcome === 'cancelled') return text('The user skipped this request. Carry on without a drawing; do not ask again unprompted.');
    if (out.outcome === 'timeout') {
      const now = await state();
      return text('Nobody answered within ' + timeout + 's.' +
        (now && !now.canvases ? ' No canvas page is open: ask the user to open ' + (now.urls.lan[0] ? now.urls.lan[0].url : now.urls.local) + '.' : ' The canvas is open but was left untouched.'));
    }
    return text('Unexpected outcome: ' + JSON.stringify(out));
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
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const result = await callTool(params && params.name, params && params.arguments);
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
