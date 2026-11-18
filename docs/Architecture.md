# Architecture

There are three pieces, all in `server/` and none with dependencies (Node built-ins only).

```
Claude Code session ──stdio──> mcp.js ──HTTP (loopback)──> daemon.js <──HTTP + SSE── canvas.html (browser, any device)
```

## mcp.js: one per Claude Code session

- The stdio MCP server, registered in `.mcp.json` as `node ${CLAUDE_PLUGIN_ROOT}/server/mcp.js`.
- It exposes `request_drawing`, `collect_drawing`, `draw_status` and `open_canvas`.
- If no daemon answers on the port, it spawns one detached (`ensureDaemon`) and polls `/state` until it's up.
- It checks in with the daemon every 20 s (`POST /session`), so the canvas can list sessions by project folder. The daemon drops a session after 60 s of silence.
- It opens the browser with `start`, `open` or `xdg-open`, depending on the platform.

## daemon.js: one shared, long-lived process

- A plain `http` server on port 7331 (`CLAUDE_DRAW_PORT`). It binds loopback only unless `CLAUDE_DRAW_LAN=1` or `--lan` is set.
- It stays up between requests, which is what keeps the canvas tab alive instead of stranding it on a dead page.
- Request state (the queue, sessions, pairing) lives in memory. Only submissions are written to disk.
- Asking (`POST /request`) and waiting (`POST /collect`) are separate calls, so Claude never holds a socket open while you draw.

Routes:

| Route | Who | Purpose |
|---|---|---|
| `GET /` | anyone | Serves `canvas.html` |
| `POST /pair` | other devices | Trades the six-digit code for a token |
| `GET /state` | both | Status, URLs, sessions, queue |
| `GET /events` | canvas | SSE stream that pushes new requests |
| `POST /request` | loopback | Claude asks for a drawing |
| `POST /session` | loopback | Session check-in |
| `POST /blank` | canvas | Starts an unprompted drawing |
| `POST /collect` | loopback | Claude picks up an answer |
| `POST /submit` | canvas | Sends a drawing |
| `POST /extend` | canvas | "Still there?" deadline bump |
| `POST /screenshot` | canvas | "Send me a screenshot" |
| `POST /cancel` | canvas | Skip |
| `POST /shutdown` | loopback | Stops the daemon |

Only loopback can create requests or shut the daemon down, so a paired device can answer questions but can't drive a session.

## canvas.html: the drawing page

- One self-contained file of about 1,400 lines.
- Marks sit on a separate layer from the background and are only flattened on send.
- It reconnects itself when the SSE stream dies, which happens when a phone backgrounds the tab.
- Touch input is ignored on purpose (palm rejection), so it takes pen and mouse only.

## Output

Each submission writes these to `out_dir`, which defaults to `<os temp>/claude-draw`:

- `draw-<stamp>.png`: the flattened image
- `draw-<stamp>.json`: the full submission (prompt, caption, canvas size, strokes), schema `claude-draw/submission@1`
- `draw-<stamp>.strokes.json`: just the marks
- `log.jsonl`: one line appended per submission, so the caption survives even if Claude never collects it

## Lifecycle of a request

1. Claude calls `request_drawing`. `mcp.js` makes sure the daemon is running and `POST`s `/request`.
2. The daemon queues the request and pushes it to connected canvases over SSE.
3. Claude waits up to `wait_seconds` (45 by default) and then gets `pending` back.
4. You draw and send. The daemon writes the files and marks the request answered.
5. Claude calls `collect_drawing` and reads the PNG path.
6. A request expires after 30 minutes, and you can extend it from the canvas. A drawing sent after that still arrives, with `late: true`.

See also [Overview](Overview.md) and [Development](Development.md).
