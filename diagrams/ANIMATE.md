# Animating A Drill

The Animate button turns the diagram you have already drawn into a moving
drill. There is no separate animation mode and nothing extra to author:
the animator reads your arrows. Draw the drill the way you always would,
press Animate, save a GIF.

---

## The short version

1. Draw the drill. Players, pucks, arrows.
2. Press **Animate** in the editor header.
3. Watch it. Adjust Speed if you want.
4. Press **Save GIF**. It lands in `cth/diagrams/<name>-drill.gif`.
5. Drag that file into Notion. It plays and loops on its own.

Edit the diagram later and press Animate again. Nothing is stored on the
drill, so the animation is always whatever the drawing currently says.

---

## How it decides what moves

Every arrow moves the nearest thing at its **tail**. That is the whole
rule, and it is why drawing normally is enough.

| Arrow you draw | What happens |
| --- | --- |
| Plain arrow | The nearest player skates along it |
| Skate With Puck | The player skates and the puck travels with the stick |
| Skate Backwards | The player skates it, slower, the way backwards skating actually is |
| Dashed arrow (Pass) | The puck flies along it, fast |
| Shoot | The puck flies along it, faster |
| Pen strokes, boxes, circles, text | Ignored. They stay on screen as markings |

Set the arrow type in the arrow tool's popup: hover the arrow button in
the toolbar and pick from the **Type** row.

**Start an arrow ON or NEXT TO the thing it moves.** The tail is what pairs
the arrow to a player or puck. An arrow starting in open ice has nothing to
carry and will be skipped.

---

## How it decides the timing

This is the part that saves you from drawing fifteen rinks.

**Arrows that touch, chain. Arrows that do not, run together.**

If one arrow's tail is near another arrow's head, the second waits for the
first to finish. So a breakout drawn as three arrows:

- D1 skates behind the net with the puck
- a pass from where D1 ends up, out to the winger on the wall
- the winger's route up ice, starting where the pass lands

...plays as a relay: carry, then pass, then go. You drew three arrows. You
did not set a single timing.

Anything not touching anything else starts immediately and runs at the same
time, which is what you want for five players leaving on a whistle.

**Speeds are per type.** A shot is much faster than a skate; backwards is
slower than forwards. Duration comes from the arrow's real length, so a
long route genuinely takes longer than a short one.

### The puck follows the chain

You usually do not need to draw a puck at all. If a pass has no puck to
send, the animator conjures one. And if a puck arrives at a pass's tail -
carried in by a player, or delivered by an earlier pass - that same puck
gets sent on. A carry into a pass into a shot is one puck moving through
three arrows, not three pucks appearing.

---

## Multiple rinks

Add a rink for each **phase** of the drill, not for each step of movement.
Two or three rinks is usually the whole drill.

Between rinks the animator matches things up and glides them: a player is
matched by its **label and colour**, a puck by being a puck. So if `D1`
finishes phase one in the corner and you draw `D1` at the blue line in
phase two, it skates from the corner to the blue line during the handoff.

That is the trick to a long drill: draw the ending positions of phase one
as the starting positions of phase two, and the two phases join into one
continuous animation.

Name your rinks (click the label above each one) and the name shows in the
corner of the animation while that phase plays.

---

## The controls

| Control | What it does |
| --- | --- |
| **Speed** | Playback rate, 0.75x to 1.5x. Also affects the exported file |
| **Size** | Pixel width of the GIF. 960 is the sweet spot for Notion |
| **GIF Rate** | Frames per second. 15 is smooth; 12 makes a smaller file; 20 is silkier and heavier |
| **Show Routes** | Draws your arrows faintly under the movement. On is better for teaching, off is cleaner for a highlight |
| **Save GIF** | Renders every frame, encodes, saves to your folder |
| **Save Video** | Records a WebM in real time. Sharper and smaller than a GIF, but it does not auto-play in every surface |

Space bar plays and pauses. Escape closes. Drag the scrubber to inspect a
moment.

---

## Getting a good result

- **Draw arrows from the object, not near it.** The tail is the pairing.
- **Chain by touching.** Put the next arrow's tail where the last arrow's
  head landed. That is how you get order without timing controls.
- **Use the right arrow type.** It is not decoration, it drives the speed
  and decides whether the puck travels.
- **Two or three rinks, not ten.** Let the handoff do the work.
- **Label your players** (`D1`, `LW`) if you use several rinks. Labels are
  how a player is recognised from one phase to the next.
- **Leave the picture uncluttered.** Everything not moving is drawn under
  the movement the whole time.

## When something looks wrong

| What you see | Why | Fix |
| --- | --- | --- |
| A player does not move | No arrow starts near enough to it | Redraw the arrow starting on the player |
| Everything moves at once | None of the arrows touch | Move each following arrow's tail onto the previous arrow's head |
| A second puck appears | Two passes each conjured their own | Chain them, or draw one puck at the first tail |
| A player teleports between rinks | Its label or colour changed | Give it the same label and colour in both rinks |
| "Nothing To Animate Yet" | No arrows in the diagram | Draw an arrow from a player or a puck |

---

## Where files go

Both exports save into your CTH folder at `cth/diagrams/`, named after the
diagram. If the folder is not connected, they download instead.

For Notion: drag the GIF into the page. A local file has no web address, so
there is no link to paste - the file itself is what you embed.
