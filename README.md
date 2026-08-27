# claude-draw

Hand-drawn input for Claude Code. Claude asks a visual question, a canvas appears on whatever
device you like, you draw the answer, Claude reads it.

Two modes: a blank canvas for sketching an idea, and annotation, where Claude seeds a
screenshot and asks you to mark it. The second is the one that earns its keep, for the times
describing a visual change in words is slower than pointing at it.

## Requirements

Node 18 or newer on PATH. Nothing else. No npm install, no dependencies.

## Install

The repo is its own single-plugin marketplace, so a fresh machine needs two commands:

```
/plugin marketplace add ThePhilipWilson/claude-draw
/plugin install claude-draw@claude-draw
```

**Or drop it in a skills directory** instead, which loads every session with no install step:

```sh
mkdir -p ~/.claude/skills
cp -r /path/to/claude-draw ~/.claude/skills/
```

Either way, restart Claude Code. Confirm with `claude plugin list`, and check the
`claude-draw` MCP server is connected.

Nothing in the plugin is path-specific or OS-specific: the browser launcher picks `start`,
`open` or `xdg-open` per platform, and all paths resolve relative to the plugin root.

## Using it

Claude drives it through MCP. You do not run anything by hand.

- `request_drawing` asks you for a sketch or an annotation and waits.
- `draw_status` reports whether a canvas is connected and gives you the URLs.
- `open_canvas` opens the canvas on the machine Claude is running on.

Type `/draw` to ask for a canvas yourself.

## Drawing from another device

Off by default: the daemon binds loopback only, so the canvas is reachable from this machine
and nowhere else. Turn it on and a tablet, phone or Chromebook on the same Wi-Fi can be the
drawing surface while Claude runs on your desktop.

1. Set `CLAUDE_DRAW_LAN=1` in the environment Claude Code runs in, e.g. in `settings.json`:

   ```json
   { "env": { "CLAUDE_DRAW_LAN": "1" } }
   ```

   A daemon that is already running keeps its old binding. Restart Claude Code, or ask Claude
   for `draw_status`, which says when the running daemon and the setting disagree.
2. Ask Claude for `draw_status` to get the LAN URL, something like `http://192.168.1.20:7331/`.
3. Open it on the device and leave the tab open.
4. Every later request appears on that page automatically. No refresh, no reopening.

Bookmark it once per device.

**Firewall.** Inbound TCP on port 7331 has to be allowed for private networks.

- Windows: `New-NetFirewallRule -DisplayName "Claude draw" -Direction Inbound -Action Allow
  -Protocol TCP -LocalPort 7331-7340 -Profile Private -RemoteAddress LocalSubnet -Program "<path to node.exe>"`
  from an elevated prompt.
- macOS: the first run prompts to allow incoming connections for node. Accept it.
- Linux: allow the port in whatever firewall you run, if any.

## Security

The daemon binds loopback only unless you opt in, so out of the box nothing on your network
can reach it.

With `CLAUDE_DRAW_LAN=1` the two directions stay separate deliberately. Anything on the local
network can load the canvas and submit a drawing. Only loopback can create a request or shut
the daemon down, so a device on your network can answer Claude's questions but cannot drive
your session. Worth knowing before you turn it on: there is no authentication, so anyone on
that network can see the prompt and the image you were asked to annotate.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `CLAUDE_DRAW_PORT` | `7331` | Port the daemon listens on |
| `CLAUDE_DRAW_LAN` | unset (off) | Set to `1` (or `true`/`yes`/`on`) to also bind the local network, so other devices can open the canvas |

## Layout

```
claude-draw/
  .claude-plugin/plugin.json        manifest
  .claude-plugin/marketplace.json   single-plugin marketplace, for /plugin marketplace add
  .mcp.json                         MCP server registration
  package.json                 pins "type": "commonjs" (see below)
  skills/draw/SKILL.md         when to use it, how to read a drawing
  server/daemon.js             long-lived HTTP + SSE daemon
  server/canvas.html           the canvas page, single file
  server/mcp.js                stdio MCP server, starts the daemon on demand
  test/e2e.js                  full round-trip test, no fixtures needed
```

`package.json` exists to pin `"type": "commonjs"`. Node resolves module type from the
*nearest* `package.json` up the tree, so dropping this plugin inside a project that declares
`"type": "module"` would otherwise make every `require` throw. Do not remove it.

## Tests

```sh
npm test
```

Starts a daemon on a spare port, drives a real SSE connection, pushes requests, submits and
skips drawings, and exercises the MCP stdio protocol. No network, no fixtures, no
dependencies. Exits non-zero on failure.

The daemon starts on the first `request_drawing` call and stays up, which is what keeps the
canvas page alive between requests instead of stranding it on a dead page.
