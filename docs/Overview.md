# Claude Draw

A Claude Code plugin that gives Claude hand-drawn input. Claude puts a question on a canvas page, you draw or mark up a screenshot on whatever device you like, and Claude reads the PNG that comes back.

- **Repo:** [ThePhilipWilson/claude-draw](https://github.com/ThePhilipWilson/claude-draw)
- **Version:** kept in both `.claude-plugin/plugin.json` and `package.json`
- **Licence:** MIT
- **Runtime:** Node 18+, no dependencies, no `npm install`

## The two modes

- **Blank canvas**: for sketching an idea. Layout and arrows come through reliably, but what the thing actually *is* often doesn't.
- **Annotation**: Claude seeds a screenshot and you mark it. This is the mode that earns its keep, because Claude already has the image and the marks only need to carry position and intent.

## Install

```
/plugin marketplace add ThePhilipWilson/claude-draw
/plugin install claude-draw@claude-draw
```

Restart Claude Code, then check the `claude-draw` MCP server is connected.

## Using it

Claude drives it through four MCP tools: `request_drawing`, `collect_drawing`, `draw_status` and `open_canvas`. You can also type `/draw` yourself. A request doesn't block the conversation: Claude waits about 45 seconds, then carries on and collects the drawing later.

## See also

- [Architecture](Architecture.md): how the pieces fit together
- [Development](Development.md): tests, layout, gotchas
- The repo [README](../README.md) is the user-facing manual (canvas keys, LAN setup, security, configuration)
- [`skills/draw/SKILL.md`](../skills/draw/SKILL.md) tells Claude when and how to use it
