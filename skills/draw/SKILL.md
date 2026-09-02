---
name: draw
description: Ask the user to draw or annotate something and get it back as an image. Use when the user runs /draw, says they want to sketch or diagram, or when words alone are failing to pin down a visual change and it would be faster for them to point at it.
---

# draw

Hand-drawn input for Claude. A canvas page stays open on whatever device the user likes; you
push a request to it and pick the answer up when it lands.

One-way: they draw, you read it. You cannot draw back into the canvas.

## Use the MCP tools, not a shell command

This plugin ships an MCP server. Do not run the daemon by hand.

| Tool | Use |
|---|---|
| `request_drawing` | Ask for a sketch or an annotation |
| `collect_drawing` | Pick up the answer |
| `draw_status` | Is the daemon up, is a canvas connected, is anything waiting, what are the URLs |
| `open_canvas` | Open the canvas in this machine's browser |

## Asking does not block the conversation

`request_drawing(prompt, image_path?, wait_seconds?, expires_seconds?, out_dir?)`

- `prompt` is required and is shown to the user as "Claude asks: ...".
- `image_path` seeds an image to annotate. Omit for a blank canvas.
- It waits `wait_seconds` (45 by default) and then returns `pending` with a request id.

`pending` is the normal case for anything more than a quick scribble, and it is not a
failure. The request stays live on the canvas, the user keeps drawing, and **you carry on
with the conversation**. Do not sit in a loop calling `collect_drawing` while they work, and
do not re-ask.

`collect_drawing(id?, wait_seconds?)` picks the answer up. Call it when:

- the user says they have sent it, or mentions the drawing at all;
- you are about to do the thing you asked them to mark up;
- `draw_status` lists the id under "waiting to be collected".

Answers are kept, so a drawing that arrives while you are doing something else is never lost.
Collecting twice returns the same result rather than an error.

**Read the returned PNG path** to see the drawing.

## Running out of time

A request stays live for 30 minutes by default. Two minutes before that, the canvas asks the
user whether they are still there and they can push the deadline out with one tap.

If it does lapse, `collect_drawing` returns `timeout`, but nothing is thrown away. The
request is still on their canvas and whatever they have drawn can still be sent; it just
arrives with `late: true` and waits for your next `collect_drawing`. So `timeout` means "not
yet", not "never". Do not re-ask unless the user says they missed it.

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
is right when the user is sat here and wrong when they are not. It says so in its reply when
nothing is connected: pass the URLs on. Once a tab is open it keeps working for every later
request, so this is a one-time cost per device.

`draw_status` reports both URLs and whether other devices are allowed to reach the canvas at
all. LAN access is off by default; if the user wants to draw on a tablet or phone, tell them
to set `CLAUDE_DRAW_LAN=1` in their Claude Code environment and restart.

**Other devices pair with a six-digit code.** `draw_status` prints it. Read it out when
someone is connecting a phone or tablet: they type it into the canvas page once and the
device is remembered from then on. The code proves they joined this session and not some
other machine's, so a device that cannot see the code cannot see the prompt.

## What comes back

A submitted drawing writes three things next to each other:

| File | Contents |
|---|---|
| `draw-<stamp>.png` | The flattened image: background plus marks |
| `draw-<stamp>.json` | Everything about the submission, including the caption |
| `draw-<stamp>.strokes.json` | Just the array of marks |

The sidecar `.json` is the one to read when you want more than the picture. It carries the
prompt that was answered, the caption, the background kind, the canvas size and every stroke.
Its shape:

```json
{
  "schema": "claude-draw/submission@1",
  "id": 3,
  "at": "2026-09-02T14:22:07.113Z",
  "prompt": "Circle the element that should move",
  "caption": "red box is the bit that should move",
  "background": "seeded",
  "canvas": { "width": 1280, "height": 960 },
  "png": "/tmp/claude-draw/draw-20260902-142207-3.png",
  "stroke_count": 4,
  "strokes": [
    { "tool": "box", "colour": "#e11d48", "color": "#e11d48", "size": 4,
      "from": { "x": 210, "y": 90 }, "to": { "x": 480, "y": 220 } },
    { "tool": "pen", "colour": "#2563eb", "color": "#2563eb", "size": 4,
      "points": [ { "x": 12.4, "y": 88.1, "p": 0.5 } ] },
    { "tool": "fill", "mode": "shape", "colour": "#16a34a", "color": "#16a34a",
      "at": { "x": 300, "y": 150 } }
  ]
}
```

Notes on reading it:

- **Colour is under both `colour` and `color`.** Same value, spelled both ways, so you never
  have to guess which one this file uses.
- `tool` is one of `pen`, `line`, `arrow`, `box`, `ellipse`, `heart`, `fill`, `eraser`.
- `pen` and `eraser` strokes have `points` (with `p` for pen pressure); `line`, `arrow`, `box`
  `ellipse` and `heart` have `from` and `to`; `fill` has `at` and a `mode` of `shape` or `image`.
- `heart` is drawn in the box between `from` and `to`, the same way `ellipse` is.
- Coordinates are in canvas pixels, origin top-left, matching the PNG exactly.
- A caption is also appended to `log.jsonl` in the same directory as each drawing lands, so it
  survives even if the reply never reaches you.

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
- The stroke data is a good way to be precise about what was marked and where, and to tell
  deliberate handwriting from scribble.

Colour convention the user may lean on, worth reading as meaningful when it fits:
red for wrong or remove, green for wanted or add, blue for a note, amber for uncertain. They
can also pick any colour they like, so do not assume a mark is one of the six defaults.

## The canvas

Pen, line, arrow, box, ellipse, fill, eraser. Six preset colours plus a colour picker. Undo,
clear. Dark, light and pink themes. In pink the swatches are love hearts and picking Ellipse
again flips it to a heart shape; the strokes come back as `tool: "heart"` whatever the theme.

Keys: `P` `L` `A` `B` `O` `F` `E` for tools, `1`-`6` for a preset colour, `7` for the picked
one, `[` `]` for size, `T` for theme, `Ctrl+Z` undo, `Ctrl+V` paste an image, `Enter` or
`Ctrl+Enter` to send. The caption box takes several lines: `Shift+Enter` or a trailing
backslash gives a new line.

Picking fill again flips it between stopping at their own marks only (`mode: "shape"` in the
stroke data) and stopping at edges in the underlying image too (`mode: "image"`). Images can
also be dropped on the window. Send shows them a preview to confirm first, so a submitted
drawing is always deliberate. "Skip" tells you they are not answering this one.

**They can ask you for a screenshot.** The canvas has a "Send me a screenshot" button, and
collecting then returns a `want_screenshot` outcome instead of an image. That is not a
refusal: capture or find the image they mean, then call `request_drawing` again with
`image_path` set to it. Anything they typed in the caption box comes back as the note saying
what they want a picture of. Do it immediately; they are sat on the canvas waiting.

## Notes

- Blank canvas is 1280x960. A seeded, pasted or dropped image keeps its own aspect ratio,
  scaled so its longest edge is at most 1600px: enough to keep screenshot text readable,
  capped because image tokens scale with pixel count.
- Marks live on a separate layer from the background, so the eraser lifts annotation without
  damaging the image underneath. They flatten into one PNG only on send.
- Touch input is ignored on purpose, so a resting palm cannot draw. Pen and mouse only.
- Pressure works on real pen hardware. Cheap tablets often report as a mouse with pressure
  pinned at 0.5; the canvas falls back to a fixed line width and that is fine.
- The daemon binds loopback only unless `CLAUDE_DRAW_LAN` is set. When it is, other devices
  pair with the code, and only loopback can create a request or shut the daemon down: a paired
  device can answer questions but cannot drive the session.
- The canvas reconnects itself if the network drops or a phone backgrounds the tab, and it
  keeps whatever was drawn across the reconnect.
- Requests queue. Asking twice before the first is answered is safe, but prefer one question
  at a time: only the front of the queue is on screen.
