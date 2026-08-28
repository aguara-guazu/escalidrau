---
name: escalidrau
description: Draw, fix and rearrange diagrams on the Escalidrau shared whiteboard through its MCP tools (server "escalidrau") — cloud/AWS architectures, system and network diagrams, flows. Use whenever the user asks to draw, sketch, diagram or lay something out on the canvas/whiteboard, to add icons to it, or to tidy up what is already there.
---

# Drawing on Escalidrau

Escalidrau is a live whiteboard shared with a person: every tool call renders on their screen at once, and they edit concurrently (tool responses open with a digest of their changes — build on their work, never overwrite it). A diagram that reads well has three properties: **items sit on a grid**, **labels never touch**, and **connectors leave and enter items through their centre lines**. The tools below make each of those mechanical; the rest of this skill is the method.

## Tools at a glance

| Tool | Use it for |
| --- | --- |
| `get_scene` | What is on the canvas (ids, geometry, text). Call it first. |
| `get_layout` | Bounding boxes of the existing diagrams ("parts"), to place new work beside them. |
| `get_library {}` / `{ folder }` / `{ query }` | Browse the icon library: folder tree → items with index and description. |
| `view_library { folder \| query, offset, limit }` | Contact sheet of icons, labelled with their index. |
| `add_library_item { item, x, y, label? }` | Place an icon. `x,y` is the top-left of the **icon** (labels hang below it). Returns every placed element with `id, type, x, y, width, height`. |
| `add_elements` | Plain shapes, text captions, frames; arrows between elements created **in the same call** (`start`/`end` ids). |
| `connect_elements { connections: [{ from, to, label?, route? }] }` | Arrows between elements that already exist. Anchored to both ends, leave/enter through the centre lines, avoid labels. |
| `move_elements` | Move a whole part (icon + label + attached arrows) or a single element. |
| `update_elements` | Restyle or resize (group boxes: `width`/`height`). |
| `view_canvas` | Look at the result. Mandatory after every batch. |
| `wait_for_user_changes` | Block until the person edits; how you keep collaborating. |

## Workflow

1. **Look**: `get_scene` (and `get_layout` if the canvas is not empty). Decide where the new diagram goes so it does not overlap existing parts — usually below or to the right, 120 px away.
2. **Plan on a grid before the first call.** List the items, which ones connect, and which groups contain what. Assign each item a grid cell (column, row) so that connected items share a row or a column. Sketch it as a table in your head; only then compute coordinates with the spacing below.
3. **Find icons**: `get_library { query }` for the specific services/resources, `get_library { folder }` to browse a category. Note the `index` of each. Prefer the official icons over hand-drawn shapes for anything that has one.
4. **Place group boxes first** (they render underneath), sized from their content (see *Groups*). Then icons, one `add_library_item` per item — keep the returned `id` of the icon (`type: "image"`, or `"rectangle"` for a group box).
5. **Connect** with one `connect_elements` call listing every arrow. Use `label` sparingly (protocols, "reads", "async"); labelled arrows need ~12 px per character of room.
6. **Caption** with `add_elements` text where needed (titles, notes) — outside the flow, never on an arrow.
7. **Verify**: `view_canvas`. Check the list under *Before you report*. Fix with `move_elements` (part scope keeps labels and arrows attached), `delete_elements` + re-add, or `update_elements`. Look again.
8. Report briefly, then `wait_for_user_changes`.

## Spacing that keeps labels apart

Item geometry (labels are 16 px text, about 10 px per character, wrapped to 2 lines above ~20 characters):

| Item kind | Icon | Item height with label | Item width |
| --- | --- | --- | --- |
| Service icon (`Services/…`) | 64 × 64 | 96 (1-line label) / 116 (2-line) | up to ~200 |
| Resource / general icon (`Resources/…`, `General`) | 48 × 48 | 80 / 100 | up to ~200 |
| Group box (`Groups`) | 320 × 220 by default, resize it | — | — |

Grid pitch (distance between icon centres):

- **Horizontal: 220 px** for service icons, **200 px** for resource/general icons. Wider labels than that must be shortened with `label`.
- **Vertical: 170 px.** That leaves ~50 px of clear space between one row's labels and the next row's icons for connectors.
- Never place two items closer than this; when in doubt, add another 40 px rather than remove any.
- Connected items belong on the same row (equal icon centre `y`) or the same column (equal centre `x`), so their connector is a straight horizontal or vertical line. Where a diagonal is unavoidable, use `route: "elbow"`.

Coordinates: an icon of size `s` centred at grid point `(cx, cy)` is placed with `add_library_item { x: cx - s/2, y: cy - s/2 }`. Example row at `cy = 300` with a 220 px pitch: service icons at `x = 168, 388, 608, 828` (`y = 268`).

## Groups (AWS Cloud, Region, Availability Zone, VPC, subnets, Auto Scaling group…)

A group item is a rectangle with a small icon on its top-left corner and a label beside it; the icon and label stay put when the rectangle is resized. Content sits inside with these margins: **top 60 px** (room for the corner icon and label), **sides 30 px**, **bottom 30 px**. Nest boxes 30 px inside their parent.

Size from the content: `width = span of the children's items + 60`, `height = span + 90`. Place the box first at `(x, y)`, then `update_elements [{ id: <rectangle id>, width, height }]`. Its label can be changed at placement time: `add_library_item { item, x, y, label: "VPC 10.0.0.0/16" }`.

Availability Zones are dashed teal boxes; subnets are solid (green public, teal private); Region is dashed teal; Auto Scaling group is dashed orange — use the library items rather than styling rectangles by hand.

## Connectors

- Always `connect_elements` for arrows between existing items; pass the **icon's** id (the `image` element, or the `rectangle` of a group box), not the label's.
- `route: "straight"` (default) leaves and enters through the icons' centre lines; between items on the same row/column that is a perfectly horizontal/vertical arrow. For items that are not aligned, `route: "elbow"` draws one horizontal and one vertical segment, exiting the side that faces the target and entering the target from above or below its label.
- Vertical connectors automatically start below the source's label and stop before the target's icon, so they never cross text.
- Do not fan five arrows out of one icon; route through a load balancer, queue or gateway item, or split the diagram.
- Arrows created with `add_elements` and explicit `points` are for free-floating annotations only. They are not attached to anything and drift when items move.

## Choosing icons

- **Services** (`AWS Architecture Icons/Services/<category>`, 64 px, coloured squares) stand for the service as a whole: "Amazon S3", "AWS Lambda", "Amazon RDS".
- **Resources** (`…/Resources/<category>`, 48 px line art) stand for a specific object inside a service: "Amazon S3 Bucket", "AWS Lambda Function", "Amazon EC2 Instance", "Amazon VPC NAT Gateway", "AWS IAM Role". Use them inside subnets and for the things a flow actually touches.
- **General** (`…/General`): Users, Client, Mobile client, Internet, Server, Database, Documents — the actors and outside world.
- **Groups**: the boundaries. Every AWS diagram gets an "AWS Cloud" box; put a VPC inside it, subnets inside the VPC.
- Rename an icon for the diagram with `label` ("Orders API" on a Lambda, "orders-prod" on an RDS instance) instead of adding a separate text element. Keep labels under ~20 characters or they wrap to two lines.
- Other installed packs work the same way and show up as their own folders in `get_library {}`.

## Before you report

Look at the `view_canvas` image and check, in this order:

1. No two labels touch or overlap; no label runs into a neighbouring icon or box border.
2. Every arrow starts at the edge of its source and ends at the edge of its target, on the centre line — no floating starts, no arrowheads inside icons.
3. No arrow crosses a label, an icon or another arrow it does not need to cross.
4. Group boxes fully contain their items with the margins above, and nested boxes do not touch each other.
5. The whole diagram is aligned: items in a row share a centre `y`, items in a column share a centre `x`.
6. Text inside shapes drawn with `add_elements` fits (usable width is `width - 30`; ~11 px per character at the default 20 px font).

Fix, then look again. Only report when the image is clean.

## Worked example: web tier in a VPC

Plan: row `cy = 320` with Users → ALB → EC2 → RDS at a 220 px pitch starting at `cx = 100`; ALB in a public subnet, EC2 and RDS in a private subnet, both inside a VPC inside AWS Cloud.

```
get_library { query: "users" }              → note the index of "Users"                    (U)
get_library { query: "application load" }   → "Application Load Balancer (ALB)"           (A)
get_library { query: "ec2 instance" }       → "Amazon EC2 Instance"                       (E)
get_library { query: "amazon rds" }         → "Amazon RDS"                                (R)
get_library { folder: "AWS Architecture Icons/Groups" } → "AWS Cloud", "VPC", "Public subnet", "Private subnet"  (C, V, P1, P2)

add_library_item { item: C,  x: 220, y: 120 }     → rectangle id cloud
add_library_item { item: V,  x: 250, y: 180 }     → rectangle id vpc
add_library_item { item: P1, x: 280, y: 240 }     → rectangle id public
add_library_item { item: P2, x: 500, y: 240 }     → rectangle id private
update_elements [ { id: cloud, width: 800, height: 420 }, { id: vpc, width: 740, height: 330 },
                  { id: public, width: 180, height: 240 }, { id: private, width: 420, height: 240 } ]

add_library_item { item: U, x: 76,  y: 296 }                      → image id users
add_library_item { item: A, x: 296, y: 296 }                      → image id alb
add_library_item { item: E, x: 516, y: 296, label: "web-1" }      → image id ec2
add_library_item { item: R, x: 728, y: 288, label: "orders-db" }  → image id rds

connect_elements { connections: [
  { from: users, to: alb, label: "HTTPS" },
  { from: alb, to: ec2 },
  { from: ec2, to: rds, label: "5432" } ] }
view_canvas
```

Every icon centre sits on `y = 320`, so all three arrows are horizontal; the labels ("Users", "Application Load Balancer", "web-1", "orders-db") sit 220 px apart and cannot touch; the boxes were sized from the row they contain.
