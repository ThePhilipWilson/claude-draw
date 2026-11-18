# Development

## Layout

```
.claude-plugin/plugin.json        plugin manifest (version lives here)
.claude-plugin/marketplace.json   single-plugin marketplace
.mcp.json                         MCP server registration
package.json                      pins "type": "commonjs", and holds the test script
skills/draw/SKILL.md              Claude's instructions for using the tool
server/mcp.js                     stdio MCP server
server/daemon.js                  HTTP + SSE daemon
server/canvas.html                the canvas page
test/e2e.js                       end-to-end test
```

## Tests

```
npm test
```

This runs `test/e2e.js`. It starts a daemon on a spare port, drives a real SSE connection, submits and skips drawings, pairs over the LAN address, lets a request lapse and sends it late, and exercises the MCP stdio protocol including an interrupt. It takes about 30 seconds and needs no fixtures.

## Releasing a change

- Bump the version in **both** `.claude-plugin/plugin.json` and `package.json`. Installed copies only pick up changes on a version bump.
- If the change affects how Claude should behave, update `skills/draw/SKILL.md`. If it changes what you see, update `README.md`.

## Gotchas

- **Don't remove `package.json`.** It pins `"type": "commonjs"`. Without it, dropping the plugin inside an ESM project makes every `require` throw.
- **A running daemon keeps its old settings.** Changing `CLAUDE_DRAW_LAN` or the code needs the daemon restarted (restart Claude Code, or `POST /shutdown` from loopback). `draw_status` warns when the setting and the daemon disagree.
- **The daemon outlives the session.** It's spawned detached, so after editing `daemon.js`, the old daemon keeps running the old code until it's restarted. `canvas.html` is re-read on every page load, so a browser refresh is enough for that.
- **The LAN firewall rule** covers TCP 7331-7340 for private networks. See the [README](../README.md).

See also [Overview](Overview.md) and [Architecture](Architecture.md).
