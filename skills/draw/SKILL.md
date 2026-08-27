---
name: draw
description: Ask the user to draw or annotate something and get it back as an image. Use when the user runs /draw, says they want to sketch or diagram, or when words alone are failing to pin down a visual change and it would be faster for them to point at it.
---

# draw

Hand-drawn input for Claude. A canvas page stays open on whatever device the user likes; you
push a request to it and block until they answer.

One-way: they draw, you read it. You cannot draw back into the canvas.

## Use the MCP tools, not a shell command

This plugin ships an MCP server. Do not run the daemon by hand.

| Tool | Use |
|---|---|
| `request_drawing` | Ask for a sketch or an annotation. Blocks until they answer |
| `draw_status` | Is the daemon up, is a canvas connected, what are the URLs |
| `open_canvas` | Open the canvas in this machine's browser |

`request_drawing(prompt, image_path?, timeout_seconds?, out_dir?)`

- `prompt` is required and is shown to the user as "Claude asks: ...".
- `image_path` seeds an image to annotate. Omit for a blank canvas.
- Returns the PNG path, the caption, and whether the background was blank or an image.
  **Read the returned path** to see the drawing.

The daemon starts on the first call and stays running, so the canvas never lands on a dead
page between requests. The user can leave the tab open all day.

## When to offer it yourself

Do not wait to be asked. Offer the moment a conversation shows these signs:

- They are describing a **visual or spatial change in prose** and it is going slowly. "No, the
  other one", "move it a bit left", "the gap under the header, not the one above it."
- You have **corrected course more than once** on the same visual element.
- They send a screenshot and describe a change to part of it. Seed **that screenshot**.
- You are about to ask a clarifying question that is really "where?" or "which one?".

Offer in one line and wait for a yes, then call `request_drawing`. Something like: "Faster if
you just show me: want me to put that screenshot on the canvas so you can mark it?"

This is the highest-value use of the tool. Long prose descriptions of visual changes are the
slow path for both of you.

**Write `prompt` as a specific instruction, not a general invitation.** "Circle the element
that should move and draw an arrow where it goes" beats "mark up whatever you like". The
prompt is your question; the drawing is their answer.

## If nobody is watching

`request_drawing` tries to open a browser on this machine when no canvas is connected, which
is right when the user is sat here and wrong when they are not. If it times out with no canvas
connected, call `draw_status` and give the user the URL to open. Once open, that tab keeps
working for every later request, so this is a one-time cost per device.

`draw_status` also reports whether other devices are allowed to reach the canvas at all. It is
off by default. If the user wants to draw on a tablet or phone, tell them to set
`CLAUDE_DRAW_LAN=1` in their Claude Code environment and restart, then read the LAN URL back
to them.

## Reading the drawing

Blank sketches and annotations fail in different ways:

- **Blank sketches: spatial relationships come through, subject matter often does not.**
  Layout, ordering, containment and arrows are reliable. What the thing *is* frequently is
  not. A tennis court got read as a swimming pool.
- **Handwriting is legible on a plain background** and labelled boxes remove nearly all
  ambiguity, so a labelled wireframe is worth far more than an unlabelled picture.
- **Handwriting over a busy image is often unreadable.** Known limitation. If a written word
  sits on top of a screenshot and you cannot read it, say so plainly and ask what it said
  rather than guessing.
- **Annotations otherwise barely suffer**, because you already have the underlying image. The
  marks only carry position and intent, which is the reliable half.
- **Say what you see before acting on it.** Describe the marks back in one line so a misread
  gets caught immediately instead of three steps later.
- The stroke data file records each mark's tool, colour and coordinates. Reading it is a good
  way to be precise about what was marked and where, and to tell deliberate handwriting from
  scribble.

Colour convention the user may lean on, worth reading as meaningful when it fits:
red for wrong or remove, green for wanted or add, blue for a note, amber for uncertain.

## The canvas

Pen, arrow, box, eraser. Six colours. Undo, clear. Keys: `P` `A` `B` `E` for tools, `1`-`6`
for colour, `[` `]` for size, `Ctrl+Z` undo, `Ctrl+V` paste an image, `Ctrl+Enter` send.
Images can also be dropped on the window. "Skip" tells you they are not answering this one.

## Notes

- Blank canvas is 1280x960. A seeded, pasted or dropped image keeps its own aspect ratio,
  scaled so its longest edge is at most 1600px: enough to keep screenshot text readable,
  capped because image tokens scale with pixel count.
- Marks live on a separate layer from the background, so the eraser lifts annotation without
  damaging the image underneath. They flatten into one PNG only on send.
- Touch input is ignored on purpose, so a resting palm cannot draw. Pen and mouse only.
- Pressure works on real pen hardware. Cheap tablets often report as a mouse with pressure
  pinned at 0.5; the canvas falls back to a fixed line width and that is fine.
- The daemon binds loopback only unless `CLAUDE_DRAW_LAN` is set. When it is, only drawing is
  exposed: `request_drawing` and shutdown stay loopback-only, so a device on the network can
  answer questions but cannot drive the session.
- Requests queue. Asking twice before the first is answered is safe.
