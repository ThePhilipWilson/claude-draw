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

- `request_drawing` puts a question on your canvas.
- `collect_drawing` picks up your answer.
- `draw_status` reports whether a canvas is connected and gives you the URLs and the
  pairing code.
- `open_canvas` opens the canvas on the machine Claude is running on.

Type `/draw` to ask for a canvas yourself.

**Asking does not tie the conversation up.** Claude waits about 45 seconds, and if you are
still drawing it hands the turn back and carries on talking to you. Your request stays on the
canvas the whole time; Claude picks the drawing up whenever you say you have sent it, or the
next time it needs the answer. Nothing is lost if it looks away, and interrupting Claude with
Escape does not take the request off your canvas.

A request stays live for thirty minutes. Two minutes before it lapses the canvas asks whether
you are still there, and one tap buys another fifteen. Even after it lapses, whatever you have
drawn can still be sent: Claude collects it late rather than never.

## The canvas

Pen, line, arrow, box, ellipse, fill and eraser, in six colours. Keys: `P` `L` `A` `B` `O`
`F` `E` for tools, `1`-`6` for colour, `[` `]` for size, `Ctrl+Z` undo, `Ctrl+V` to paste an
image, `Ctrl+Enter` to send. Images can also be dropped on the window.

Fill has two ideas of an edge, and picking the tool again flips between them. **Fill: shape**
stops only at your own marks, so an outline you drew fills solid in one tap whatever is
underneath it. **Fill: image** also stops at edges in the picture, for colouring a region of a
screenshot you have not outlined yourself. Either way the paint lands on the marks layer, so
the eraser lifts it without damaging the image.

Your caption is written to disk next to the PNG the moment you send it, along with the prompt
you were answering and every stroke, and appended to a `log.jsonl` alongside. If the reply
never reaches Claude, the words are still there.

Send shows you the flattened image and caption first, with `Enter` to confirm and `Esc` to go
back. It tells you whether Claude was waiting or will pick it up next turn. "Send me a screenshot" is the other direction: it tells Claude to capture something and
send it back for you to annotate, which beats hunting for a file on a tablet. Whatever is in
the caption box goes with it, so you can say what you want a picture of. "Skip" tells Claude
you are not answering this one.

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
2. Ask Claude for `draw_status` to get the LAN URL, something like `http://192.168.1.20:7331/`,
   and the six-digit pairing code.
3. Open the URL on the device and type the code in. That device is then remembered.
4. Every later request appears on that page automatically. No refresh, no reopening.

Bookmark it once per device. If the tab goes to sleep on a phone, it notices the dead
connection and reconnects itself, keeping whatever you had drawn.

**Firewall.** Inbound TCP on port 7331 has to be allowed for private networks.

- Windows: `New-NetFirewallRule -DisplayName "Claude draw" -Direction Inbound -Action Allow
  -Protocol TCP -LocalPort 7331-7340 -Profile Private -RemoteAddress LocalSubnet -Program "<path to node.exe>"`
  from an elevated prompt.
- macOS: the first run prompts to allow incoming connections for node. Accept it.
- Linux: allow the port in whatever firewall you run, if any.

## Security

The daemon binds loopback only unless you opt in, so out of the box nothing on your network
can reach it.

With `CLAUDE_DRAW_LAN=1` the two directions stay separate deliberately. Only loopback can
create a request or shut the daemon down, so a device on your network can answer Claude's
questions but cannot drive your session.

Devices that are not on this machine pair with a six-digit code before they see anything: the
prompt, the image and the event stream are all behind it. The code is generated per daemon
start and is only readable from loopback, so it reaches another device by you reading it out.
Eight wrong guesses locks pairing for a minute. A paired device keeps its token until the
daemon restarts.

This is enough to stop you joining the wrong machine's session on a shared network, and enough
that a stranger on the same Wi-Fi cannot watch what you are annotating. It is not encrypted:
it is plain HTTP on a local network.

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
  package.json                      pins "type": "commonjs" (see below)
  skills/draw/SKILL.md              when to use it, how to read a drawing
  server/daemon.js                  long-lived HTTP + SSE daemon
  server/canvas.html                the canvas page, single file
  server/mcp.js                     stdio MCP server, starts the daemon on demand
  test/e2e.js                       full round-trip test, no fixtures needed
```

`package.json` exists to pin `"type": "commonjs"`. Node resolves module type from the
*nearest* `package.json` up the tree, so dropping this plugin inside a project that declares
`"type": "module"` would otherwise make every `require` throw. Do not remove it.

## Tests

```sh
npm test
```

Starts a daemon on a spare port, drives a real SSE connection, pushes requests, submits and
skips drawings, pairs over this machine's own LAN address, lets a request lapse and sends it
late anyway, and exercises the MCP stdio protocol including an interrupt. No fixtures, no
dependencies. Exits non-zero on failure. Takes about half a minute; most of that is waiting
for a deliberately short deadline to run out.

The daemon starts on the first `request_drawing` call and stays up, which is what keeps the
canvas page alive between requests instead of stranding it on a dead page.
