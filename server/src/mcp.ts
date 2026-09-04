import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CanvasBridge } from "./bridge.js";
import type { SceneStore } from "./scene.js";
import type { ChangeTracker } from "./changes.js";
import { buildLayout, fragmentElementIds, partElementIds } from "./layout.js";
import { sceneToMermaid } from "./mermaid.js";
import {
  CONNECTOR_PRESETS,
  CONNECTOR_ROUTES,
  FONTS,
  FONT_DESCRIPTIONS,
  PRESET_DESCRIPTIONS,
  ROUTE_DESCRIPTIONS,
  canvasStyle,
  normalizeSettings,
  type Settings
} from "./settings.js";

const elementSkeleton = z.record(z.unknown());
const elementUpdate = z.object({ id: z.string() }).passthrough();

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };

const ADD_ELEMENTS_DESCRIPTION = `Add elements to the shared live canvas (the user sees them appear instantly).
Elements use the canvas "skeleton" format. Supported types: rectangle, ellipse, diamond, arrow, line, text, frame.
You may set your own unique "id" on each element and reference those ids later in update/delete calls.

Common properties: x, y, width, height, strokeColor, backgroundColor, fillStyle ("hachure"|"cross-hatch"|"solid"), strokeStyle ("solid"|"dashed"|"dotted"), fontSize.
Shapes accept "label": {"text": "..."} to render centered text inside them.
Arrows accept "start"/"end" as {"id": "<id of an element in THIS SAME call>"} for automatic binding, or plain geometry via x, y and "points": [[0,0],[dx,dy]].
To connect elements that already exist on the canvas (including placed library icons) use connect_elements instead — it anchors the arrow to both ends and routes it through their centre lines.

Example:
[{"id":"api","type":"rectangle","x":100,"y":100,"width":180,"height":70,"label":{"text":"API"}},
 {"id":"db","type":"rectangle","x":420,"y":100,"width":180,"height":70,"label":{"text":"DB"}},
 {"type":"arrow","x":280,"y":135,"start":{"id":"api"},"end":{"id":"db"}}]

Size shapes to their text (default font ~= 11px per character): usable width is width - 30px for rectangles, 70% of width for ellipses, 50% for diamonds — the longest unbreakable word must fit or it breaks mid-word. Leave ~12px per label character of gap between shapes joined by a labeled arrow.
Shapes, arrows, lines and text take the canvas style (see get_canvas_style: stroke preset and font) unless the skeleton sets roughness, strokeWidth, roundness, fillStyle, arrowheads or fontFamily itself.
After a batch of edits, call view_canvas to visually verify the result.`;

export type SessionContext = {
  store: SceneStore;
  bridge: CanvasBridge;
  tracker: ChangeTracker;
  canvasUrl: string;
  readLibrary: () => Promise<unknown[]>;
  readSettings: () => Promise<Settings>;
  writeSettings: (next: Settings) => Promise<void>;
};

type StoredLibraryItem = {
  id?: string;
  name?: string;
  status?: string;
  description?: string;
  category?: string;
  folder?: string[];
  elements: Array<Record<string, unknown>>;
};

// Items carry their folder path; the rest land in the same two pseudo-folders
// the in-app library panel shows them under.
const folderOf = (item: StoredLibraryItem): string =>
  Array.isArray(item.folder) && item.folder.length > 0
    ? item.folder.join("/")
    : item.status === "unpublished"
      ? "Personal library"
      : "Other libraries";

// Every whitespace-separated term must appear in the item's name, description
// or folder path (case-insensitive).
const matchesQuery = (item: StoredLibraryItem, query: string): boolean => {
  const haystack = `${item.name ?? ""} ${item.description ?? ""} ${folderOf(item)}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== "")
    .every((term) => haystack.includes(term));
};

const inFolder = (item: StoredLibraryItem, folder: string): boolean => {
  const path = folderOf(item).toLowerCase();
  const wanted = folder.toLowerCase().replace(/^\/+|\/+$/g, "");
  return path === wanted || path.startsWith(`${wanted}/`);
};

const filterLibrary = (items: StoredLibraryItem[], query?: string, folder?: string) => {
  let indexed = items.map((item, index) => ({ item, index }));
  const wantedFolder = folder?.trim();
  if (wantedFolder) {
    indexed = indexed.filter(({ item }) => inFolder(item, wantedFolder));
  }
  const trimmed = query?.trim();
  return trimmed ? indexed.filter(({ item }) => matchesQuery(item, trimmed)) : indexed;
};

const folderSummary = (items: StoredLibraryItem[]) => {
  const counts = new Map<string, number>();
  for (const item of items) {
    const path = folderOf(item);
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, count]) => ({ path, items: count }));
};

const normalizeLibrary = (raw: unknown[]): StoredLibraryItem[] =>
  raw
    .map((entry) => {
      if (Array.isArray(entry)) {
        return { elements: entry as Array<Record<string, unknown>> };
      }
      const item = entry as StoredLibraryItem;
      return item && Array.isArray(item.elements) ? item : null;
    })
    .filter((item): item is StoredLibraryItem => item !== null);

/**
 * Builds one McpServer per HTTP session. The session keeps a cursor into the
 * change log so every tool response opens with a digest of edits the human
 * made since the model's previous call — this is what keeps the model aware
 * of the user's side of the collaboration.
 */
const SERVER_INSTRUCTIONS = `Escalidrau is a live whiteboard shared in real time with a human collaborator.

MANDATORY WORKFLOW: after every batch of canvas edits (add_elements, update_elements, move_elements, import_mermaid), call view_canvas, look at the image and fix rendering problems BEFORE reporting the work as done. Look for: text overflowing its shape or breaking mid-word, labels overlapping other elements, arrows crossing shapes or too short for their labels, and overlapping diagram parts.

SIZING RULES (default font ~= 11px of width per character):
- A shape must fit its longest unbreakable word. Usable width: rectangles = width - 30px; ellipses = 70% of width; diamonds = 50% of width.
- Resizing an existing shape does NOT re-wrap its label; delete and re-add the shape with the right size instead.
- Between shapes connected by a labeled arrow, leave a gap of at least 12px per label character.

CANVAS STYLE: shapes, arrows, lines and text follow a canvas-wide style (get_canvas_style / set_canvas_style): stroke preset "sketch" (hand-drawn, the default), "clean" (straight strokes, rounded bends) or "formal" (thin straight strokes, sharp bends, filled triangle heads); default route ("straight", "elbow", "curve"); and font ("hand" Excalifont, "classic" Virgil, "normal" Nunito, "formal" Helvetica, "display" Lilita One, "code" Comic Shanns). Before the first diagram on an empty canvas ask the person in one line which look they want (stroke, arrows, font) unless they already said; then set it once. When they ask for a formal, sober, clean or presentation-ready look set preset and font accordingly (with applyToExisting when the canvas has content); keep one style per canvas and do not mix.

LAYOUT RULES for icon diagrams: plan a grid first and put connected items on the same row or column; icon centres at least 220px apart horizontally (200px for 48px resource icons) and 170px vertically so labels never touch; place group boxes before their contents and size them from the contents (60px top margin, 30px sides and bottom); connect existing items only with connect_elements (bound, centre-line arrows). The "escalidrau" skill installed with the MCP server (app menu MCP) spells out the whole method.

The library is organized in folders. The official AWS Architecture Icons are installed by default under "AWS Architecture Icons": Services/<category> (EC2, Lambda, S3, DynamoDB, ...), Resources/<category> (S3 bucket, Lambda function, VPC NAT gateway, IAM role, ...), Groups (AWS Cloud, Region, Availability Zone, VPC, public/private subnet, Auto Scaling group, ...) and General (User, Client, Internet, Server, ...). For AWS diagrams use them instead of drawing generic shapes: get_library {} lists the folders, get_library { folder } or { query } finds items, add_library_item places one. A group box is a rectangle meant to contain other elements — resize it with update_elements (width/height) after placing it. Other installed icon packs work the same way.

The human edits concurrently: tool responses open with a digest of their changes — read it and never overwrite their work blindly.`;

const SCENE_URI = "scene://current";

export function createSessionServer({
  store,
  bridge,
  tracker,
  canvasUrl,
  readLibrary,
  readSettings,
  writeSettings
}: SessionContext) {
  const server = new McpServer(
    { name: "escalidrau", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS }
  );
  let cursor = tracker.current;

  // Standards-aligned change signal: the scene is a subscribable MCP resource
  // and user edits emit notifications/resources/updated. Whether the client
  // surfaces that to the model is client behavior (the spec leaves it
  // application-driven); wait_for_user_changes remains the portable path.
  server.registerResource(
    "scene",
    SCENE_URI,
    {
      description: "Current canvas scene as compact JSON. Subscribe to be notified when the user edits it.",
      mimeType: "application/json"
    },
    async () => ({
      contents: [
        {
          uri: SCENE_URI,
          mimeType: "application/json",
          text: JSON.stringify({ canvasUrl, elements: store.compact() })
        }
      ]
    })
  );
  server.server.registerCapabilities({ resources: { subscribe: true } });
  let sceneSubscribed = false;
  let lastNotifiedAt = 0;
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    if (request.params.uri === SCENE_URI) {
      sceneSubscribed = true;
    }
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    if (request.params.uri === SCENE_URI) {
      sceneSubscribed = false;
    }
    return {};
  });
  const stopTrackerListener = tracker.onUserChange(() => {
    if (!sceneSubscribed || Date.now() - lastNotifiedAt < 1000) {
      return;
    }
    lastNotifiedAt = Date.now();
    void server.server.sendResourceUpdated({ uri: SCENE_URI }).catch(() => {
      // No open stream to deliver on — the client will read on demand.
    });
  });
  server.server.onclose = () => {
    stopTrackerListener();
  };

  const digest = (): TextContent[] => {
    const { seq, summaries } = tracker.since(cursor);
    cursor = seq;
    if (summaries.length === 0) {
      return [];
    }
    return [
      {
        type: "text",
        text: `[canvas] The user or a collaborator edited the canvas since your last tool call: ${summaries.join("; ")}.`
      }
    ];
  };

  const jsonResult = (value: unknown) => ({
    content: [...digest(), { type: "text" as const, text: JSON.stringify(value) }]
  });

  const VERIFY_REMINDER: TextContent = {
    type: "text",
    text: "Reminder: when this batch of edits is complete, call view_canvas and fix anything that renders badly (overflowing or mid-word-broken text, overlapping labels, arrows crossing shapes) before finishing."
  };
  const mutationResult = (value: unknown) => ({
    content: [
      ...digest(),
      { type: "text" as const, text: JSON.stringify(value) },
      VERIFY_REMINDER
    ]
  });

  server.registerTool(
    "get_scene",
    {
      description: `Read the current canvas as a compact JSON list of elements (id, type, geometry, colors, text, bindings). The canvas is live at ${canvasUrl} (also available as a desktop app); the scene is empty until it is open. Call this before modifying anything the user may have drawn or moved.`,
      inputSchema: {}
    },
    async () => jsonResult({ canvasUrl, elements: store.compact() })
  );

  server.registerTool(
    "add_elements",
    {
      description: ADD_ELEMENTS_DESCRIPTION,
      inputSchema: { elements: z.array(elementSkeleton).min(1) }
    },
    async ({ elements }) =>
      mutationResult(
        await bridge.request("add_elements", { elements, style: canvasStyle(await readSettings()) })
      )
  );

  server.registerTool(
    "update_elements",
    {
      description:
        "Update existing canvas elements in place. Each entry needs the element \"id\" plus the properties to change (strokeColor, backgroundColor, angle, width, height, ...). Changing \"text\" does not re-measure the element; prefer delete + add for text size changes. To move elements spatially prefer move_elements — it carries labels, groups and connected arrows along; changing x/y here moves the lone element only.",
      inputSchema: { updates: z.array(elementUpdate).min(1) }
    },
    async ({ updates }) => mutationResult(await bridge.request("update_elements", { updates }))
  );

  server.registerTool(
    "get_layout",
    {
      description:
        "Spatial analysis of the canvas: clusters elements into connected \"parts\" (shapes joined by bound arrows, labels, groups and frames form one part — typically one diagram each) and reports per-part bounding boxes, centers, contained texts and which parts overlap. Use it to understand the current arrangement before rearranging diagrams with move_elements (e.g. to lay parts out horizontally, vertically or on a grid, or to separate overlapping diagrams).",
      inputSchema: {}
    },
    async () => jsonResult(buildLayout(store.all()))
  );

  server.registerTool(
    "export_mermaid",
    {
      description:
        "Export the current canvas as Mermaid flowchart syntax: shapes with their labels become nodes, bound arrows become edges, frames become subgraphs. Useful for pasting diagrams into markdown docs. Purely geometric content (freedraw, lines, images, unbound arrows) cannot be represented and is listed in a trailing %% comment.",
      inputSchema: {}
    },
    async () => {
      const { mermaid } = sceneToMermaid(store.all());
      return {
        content: [
          ...digest(),
          {
            type: "text" as const,
            text: mermaid === "" ? "The canvas has no elements representable in Mermaid." : mermaid
          }
        ]
      };
    }
  );

  server.registerTool(
    "import_mermaid",
    {
      description:
        "Render a Mermaid definition (flowchart, sequence, class) onto the shared canvas as editable elements. Content is placed below the existing scene. Use this when the user hands you Mermaid syntax; for new diagrams prefer add_elements.",
      inputSchema: { mermaid: z.string().min(1) }
    },
    async ({ mermaid }) => mutationResult(await bridge.request("import_mermaid", { mermaid }, 30_000))
  );

  server.registerTool(
    "get_library",
    {
      description:
        "Browse the shape library installed in the app, which is organized in folders (the official AWS Architecture Icons ship with it: hundreds of service and resource icons, group boxes such as VPC, subnet, Region and Availability Zone, and general resources such as User, Client and Internet). Without arguments it lists every folder path with its item count. \"folder\" (a path or path prefix, e.g. \"AWS Architecture Icons/Services/Compute\") lists the items in it; \"query\" (terms matched against name, description and folder, e.g. \"lambda\", \"s3 bucket\", \"private subnet\") searches everywhere; both combine. Items come with index, name, description and folder; place one with add_library_item by index, or look at them with view_library.",
      inputSchema: { query: z.string().optional(), folder: z.string().optional() }
    },
    async ({ query, folder }) => {
      const items = normalizeLibrary(await readLibrary());
      if (!query?.trim() && !folder?.trim()) {
        return jsonResult({
          count: items.length,
          folders: folderSummary(items),
          hint: "Call again with folder (path prefix) to list a folder, or query to search by name/description."
        });
      }
      const matches = filterLibrary(items, query, folder);
      return jsonResult({
        count: items.length,
        matched: matches.length,
        items: matches.map(({ item, index }) => ({
          index,
          name: item.name ?? null,
          description: item.description,
          folder: folderOf(item)
        }))
      });
    }
  );

  server.registerTool(
    "view_library",
    {
      description:
        "Render installed library items as a labeled contact-sheet image so you can see what each icon looks like. \"folder\" and \"query\" filter like get_library; paginate the (filtered) list with offset/limit. Labels show the index to use with add_library_item.",
      inputSchema: {
        query: z.string().optional(),
        folder: z.string().optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(40).default(24)
      }
    },
    async ({ query, folder, offset, limit }) => {
      const items = normalizeLibrary(await readLibrary());
      const filtered = filterLibrary(items, query, folder);
      const page = filtered.slice(offset, offset + limit);
      if (page.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No library items in range (${filtered.length} item(s) match, library has ${items.length}).`
            }
          ]
        };
      }
      const payload = page.map(({ item, index }) => ({
        label: `${index}${item.name ? ` ${item.name}` : ""}`,
        elements: item.elements
      }));
      const result = (await bridge.request("render_library", { items: payload }, 30_000)) as {
        data: string;
      };
      return {
        content: [
          ...digest(),
          {
            type: "text" as const,
            text: `Library items ${page[0].index}-${page[page.length - 1].index}${query?.trim() || folder?.trim() ? ` (${filtered.length} match(es)${folder?.trim() ? ` in "${folder.trim()}"` : ""}${query?.trim() ? ` for "${query.trim()}"` : ""})` : ""} of ${items.length}. Place one with add_library_item { item: <index>, x, y }.`
          },
          { type: "image" as const, data: result.data, mimeType: "image/png" }
        ]
      };
    }
  );

  server.registerTool(
    "add_library_item",
    {
      description:
        "Place an installed library icon on the canvas by its index (from get_library / view_library). x/y set the top-left of the item's main shape — the icon (64px for services, 48px for resources) or the box of a group item — so items placed on a grid line up whatever their label width; the label hangs below the icon. Optional \"label\" replaces the item's text (e.g. \"Orders API\" on a Lambda icon; keep it under ~20 characters). The result lists every placed element with id, type, x, y, width and height: use the image (or rectangle) id with connect_elements and the rectangle id of a group box with update_elements to resize it.",
      inputSchema: {
        item: z.number().int().min(0),
        x: z.number(),
        y: z.number(),
        label: z.string().optional()
      }
    },
    async ({ item, x, y, label }) => {
      const items = normalizeLibrary(await readLibrary());
      const entry = items[item];
      if (!entry) {
        throw new Error(`No library item at index ${item} (library has ${items.length})`);
      }
      const result = await bridge.request(
        "add_library_item",
        {
          elements: entry.elements,
          x,
          y,
          style: canvasStyle(await readSettings()),
          ...(label !== undefined ? { label } : {})
        },
        30_000
      );
      return mutationResult({ name: entry.name ?? null, ...(result as object) });
    }
  );

  server.registerTool(
    "connect_elements",
    {
      description:
        "Draw arrows between elements that already exist on the canvas (placed library icons, group boxes, shapes). Each connection names the source and target element ids — for a library item use its image id (or the rectangle id of a group box), never the label's. The arrow is bound to both ends (it follows them when moved) and leaves/enters through their centre lines: horizontal connections touch the icons' side edges, vertical ones start below the source's label and stop above the target's icon, so text is never crossed. Stroke look and default route come from the canvas connector style (get_connector_style); \"style\" (a preset name) and \"route\" override them per connection: \"straight\" is a single segment — perfectly horizontal/vertical when the items share a row or column; \"elbow\" adds one right-angle bend for items that are not aligned; \"curve\" draws a smooth S-curve. Optional label (keep it short; leave ~12px per character between the items), strokeStyle, strokeColor and arrowheads.",
      inputSchema: {
        connections: z
          .array(
            z.object({
              from: z.string(),
              to: z.string(),
              label: z.string().optional(),
              route: z.enum(CONNECTOR_ROUTES).optional(),
              style: z.enum(CONNECTOR_PRESETS).optional(),
              strokeColor: z.string().optional(),
              strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
              startArrowhead: z.enum(["arrow", "triangle", "bar", "dot", "none"]).optional(),
              endArrowhead: z.enum(["arrow", "triangle", "bar", "dot", "none"]).optional()
            })
          )
          .min(1)
      }
    },
    async ({ connections }) =>
      mutationResult(
        await bridge.request("connect_elements", {
          connections,
          style: canvasStyle(await readSettings())
        })
      )
  );

  const describeStyle = (settings: Settings) => ({
    ...canvasStyle(settings),
    presets: CONNECTOR_PRESETS.map((id) => ({ id, description: PRESET_DESCRIPTIONS[id] })),
    routes: CONNECTOR_ROUTES.map((id) => ({ id, description: ROUTE_DESCRIPTIONS[id] })),
    fonts: FONTS.map((id) => ({ id, description: FONT_DESCRIPTIONS[id] }))
  });

  server.registerTool(
    "get_canvas_style",
    {
      description:
        "Read the canvas-wide style applied to everything drawn through the tools: the stroke preset for shapes, arrows and lines (sketch, clean or formal), the default connector route (straight, elbow or curve) and the font for labels and text (hand, classic, normal, formal, display, code), each option described. The person can change it from the toolbar's style button too, so read it rather than assuming.",
      inputSchema: {}
    },
    async () => jsonResult(describeStyle(await readSettings()))
  );

  server.registerTool(
    "set_canvas_style",
    {
      description:
        "Change the canvas-wide style: \"preset\" for shapes, arrows and lines (sketch = hand-drawn default with hatched fills, clean = straight strokes with rounded corners and solid fills, formal = thin straight strokes with sharp corners, solid fills and filled triangle heads), the default connector \"route\" (straight, elbow, curve) and the \"font\" for labels and text (hand = Excalifont, classic = Virgil, normal = Nunito, formal = Helvetica, display = Lilita One, code = Comic Shanns). The style also becomes the toolbar default for what the person draws or types next. With applyToExisting: true every shape, arrow, line and text already on the canvas is restyled to match (library icons keep their look), so the diagram stays consistent. Ask the person once per empty canvas which look they want, and use this when they ask for a more formal/sober, cleaner or sketchier look or a particular font. One style per canvas — do not mix.",
      inputSchema: {
        preset: z.enum(CONNECTOR_PRESETS).optional(),
        route: z.enum(CONNECTOR_ROUTES).optional(),
        font: z.enum(FONTS).optional(),
        applyToExisting: z.boolean().optional()
      }
    },
    async ({ preset, route, font, applyToExisting }) => {
      const current = await readSettings();
      const next = normalizeSettings({
        connectors: {
          preset: preset ?? current.connectors.preset,
          route: route ?? current.connectors.route
        },
        text: { font: font ?? current.text.font }
      });
      await writeSettings(next);
      // The canvas also takes the style as its toolbar default; the request is
      // best-effort when no canvas is connected (the setting is persisted anyway).
      let restyled = 0;
      try {
        const result = (await bridge.request("set_canvas_style", {
          style: canvasStyle(next),
          applyToExisting: Boolean(applyToExisting)
        })) as { restyled: number };
        restyled = result.restyled;
      } catch (error) {
        if (applyToExisting) {
          throw error;
        }
      }
      const payload = { ...describeStyle(next), restyled };
      return restyled > 0 ? mutationResult(payload) : jsonResult(payload);
    }
  );

  server.registerTool(
    "move_elements",
    {
      description:
        "Move elements freely on the canvas, keeping their structure intact. With scope \"part\" (default) moving any element id relocates its whole connected part — the shapes, labels, groups and bound arrows that form that diagram. With scope \"element\" only the element (plus its label/group) moves, and arrows bound to it stretch to follow. Each move takes either a relative shift (dx/dy) or an absolute target (x/y = new top-left of the moved unit's bounding box). Avoid listing two ids that belong to the same part in one call. After rearranging, call view_canvas to visually verify the result.",
      inputSchema: {
        moves: z
          .array(
            z.object({
              id: z.string(),
              dx: z.number().optional(),
              dy: z.number().optional(),
              x: z.number().optional(),
              y: z.number().optional()
            })
          )
          .min(1),
        scope: z.enum(["part", "element"]).default("part")
      }
    },
    async ({ moves, scope }) => mutationResult(await bridge.request("move_elements", { moves, scope }))
  );

  server.registerTool(
    "delete_elements",
    {
      description: "Delete canvas elements by id (soft delete, undo-friendly).",
      inputSchema: { ids: z.array(z.string()).min(1) }
    },
    async ({ ids }) => jsonResult(await bridge.request("delete_elements", { ids }))
  );

  server.registerTool(
    "wait_for_user_changes",
    {
      description:
        "Block until the user edits the canvas, then return a digest of what they changed. Returns immediately if there are unseen changes. This is how you collaborate live: after finishing your edits call this tool, react to what it returns, and call it again. If it times out with no changes the user is probably still thinking — call it again to keep listening. timeoutSeconds defaults to 60 (max 240).",
      inputSchema: {
        timeoutSeconds: z.number().min(1).max(240).optional()
      }
    },
    async ({ timeoutSeconds }, extra) => {
      const limitMs = (timeoutSeconds ?? 60) * 1000;
      const pending = digest();
      if (pending.length > 0) {
        return { content: pending };
      }
      const changes = await new Promise<TextContent[]>((resolve) => {
        let done = false;
        let settleTimer: NodeJS.Timeout | undefined;
        let progressTimer: NodeJS.Timeout | undefined;
        let unsubscribe: (() => void) | undefined;
        const finish = () => {
          if (done) {
            return;
          }
          done = true;
          unsubscribe?.();
          clearTimeout(settleTimer);
          clearTimeout(timeoutTimer);
          clearInterval(progressTimer);
          resolve(digest());
        };
        // Settle window so a whole drag lands in a single digest.
        unsubscribe = tracker.onUserChange(() => {
          clearTimeout(settleTimer);
          settleTimer = setTimeout(finish, 800);
        });
        const timeoutTimer = setTimeout(finish, limitMs);
        // Progress pings keep client-side tool timeouts from killing the wait.
        const progressToken = (extra as { _meta?: { progressToken?: string | number } })._meta
          ?.progressToken;
        if (progressToken !== undefined) {
          let elapsedSeconds = 0;
          progressTimer = setInterval(() => {
            elapsedSeconds += 10;
            void extra.sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: elapsedSeconds,
                message: "waiting for user edits"
              }
            });
          }, 10_000);
        }
        extra.signal.addEventListener("abort", finish);
      });
      if (changes.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No user changes within ${Math.round(limitMs / 1000)}s. Call again to keep waiting.`
            }
          ]
        };
      }
      return { content: changes };
    }
  );

  server.registerTool(
    "view_canvas",
    {
      description:
        "Render the canvas (or one connected part of it) as a PNG image you can look at. Call it after a batch of adds/moves/restyles to visually verify the result — overflowing text, overlaps and misrouted arrows show up here, not in get_scene. Pass the id of any element to zoom into that element's whole connected part; omit it to view everything. Output is sized for model vision (longest side ~1600px). Verify once per batch, not after every element.",
      inputSchema: { id: z.string().optional() }
    },
    async ({ id }) => {
      let ids: string[] | undefined;
      if (id) {
        const members = partElementIds(store.all(), id);
        if (!members) {
          throw new Error(`No element "${id}" on the canvas`);
        }
        ids = members;
      }
      const result = (await bridge.request("view_canvas", { ids }, 30_000)) as { data: string };
      return {
        content: [
          ...digest(),
          { type: "image" as const, data: result.data, mimeType: "image/png" }
        ]
      };
    }
  );

  server.registerTool(
    "export_image",
    {
      description:
        "Export the whole canvas as SVG markup (returned as text, or written to \"path\"). For PNG prefer export_png: it also exports a single diagram or a set of elements, and controls resolution and background.",
      inputSchema: {
        format: z.enum(["png", "svg"]).default("png"),
        scale: z.number().min(0.2).max(4).optional(),
        path: z.string().optional()
      }
    },
    async ({ format, scale, path }) => {
      const result = (await bridge.request("export_image", { format, scale }, 30_000)) as {
        format: "png" | "svg";
        data: string;
      };
      const content: Array<TextContent | ImageContent> = [...digest()];
      if (result.format === "svg") {
        if (path) {
          await writeFile(path, result.data, "utf8");
          content.push({ type: "text", text: `SVG saved to ${path}` });
        } else {
          content.push({ type: "text", text: result.data });
        }
        return { content };
      }
      if (path) {
        await writeFile(path, Buffer.from(result.data, "base64"));
        content.push({ type: "text", text: `PNG saved to ${path}` });
      }
      content.push({ type: "image", data: result.data, mimeType: "image/png" });
      return { content };
    }
  );

  const PNG_DESCRIPTION = `Save a PNG of the canvas, of chosen diagrams on it, or of specific elements — for pasting into a document, a ticket or a slide.
Scope, so that neighbouring diagrams are never dragged in:
- neither "parts" nor "elements": the whole board.
- "parts": one element id per diagram you want; each expands to its whole connected diagram (shapes, labels, bound arrows, groups, frames — the way view_canvas frames it). Several ids land in one image containing only those diagrams. Ids come from get_layout (each part lists elementIds) or from what you placed.
- "elements": exactly those elements and nothing else, plus their labels, group members and frame contents. For a fragment of a diagram.
"path" is where the file goes: an absolute path (a leading ~ is expanded, a missing .png extension is added, missing directories are created). Without it the image comes back inline instead, which costs a lot of tokens — pass a path unless the person asked to see it.
Defaults are the sharpest sensible export: white background and the largest scale that the canvas can rasterize (up to 4x, less for a very large area — the result says which was used). Pass "scale" for a smaller file, "background" false for transparency, "padding" for a different margin (16 canvas pixels by default).
To get one file per diagram, call this once per part instead of listing them all in "parts".`;

  server.registerTool(
    "export_png",
    {
      description: PNG_DESCRIPTION,
      inputSchema: {
        path: z.string().optional(),
        parts: z.array(z.string()).min(1).optional(),
        elements: z.array(z.string()).min(1).optional(),
        scale: z.number().min(0.25).max(4).optional(),
        background: z.boolean().optional(),
        padding: z.number().int().min(0).max(200).optional()
      }
    },
    async ({ path, parts, elements, scale, background, padding }) => {
      if (parts && elements) {
        throw new Error(
          'Pass either "parts" (whole diagrams) or "elements" (exact elements), not both'
        );
      }
      let targetIds: string[] | undefined;
      let scope = "the whole board";
      if (parts) {
        const wanted = new Set<string>();
        const missing: string[] = [];
        for (const id of parts) {
          const members = partElementIds(store.all(), id);
          if (!members) {
            missing.push(id);
            continue;
          }
          for (const member of members) {
            wanted.add(member);
          }
        }
        if (missing.length > 0) {
          throw new Error(`Not on the canvas: ${missing.join(", ")}`);
        }
        targetIds = [...wanted];
        scope =
          parts.length === 1
            ? `the diagram around "${parts[0]}" (${targetIds.length} elements)`
            : `${parts.length} diagrams (${targetIds.length} elements)`;
      } else if (elements) {
        const fragment = fragmentElementIds(store.all(), elements);
        if (fragment.missing.length > 0) {
          throw new Error(`Not on the canvas: ${fragment.missing.join(", ")}`);
        }
        targetIds = fragment.ids;
        scope = `${fragment.ids.length} element(s)`;
      }
      const result = (await bridge.request(
        "export_png",
        { ids: targetIds, scale, background, padding },
        30_000
      )) as {
        data: string;
        width: number;
        height: number;
        scale: number;
        requestedScale: number;
      };
      const bytes = Buffer.from(result.data, "base64");
      const clamped =
        result.scale < result.requestedScale ? " — the largest this area can rasterize" : "";
      const size = `${result.width}x${result.height} px at ${result.scale}x${clamped}, ${Math.max(1, Math.round(bytes.length / 1024))} KB`;
      if (!path) {
        return {
          content: [
            ...digest(),
            { type: "text" as const, text: `PNG of ${scope} (${size}). Pass "path" to save it to a file.` },
            { type: "image" as const, data: result.data, mimeType: "image/png" }
          ]
        };
      }
      const expanded = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
      if (!isAbsolute(expanded)) {
        throw new Error(`"path" must be an absolute file path (got "${path}")`);
      }
      // A path that names an existing directory would otherwise fail on write.
      const isDirectory = await stat(expanded)
        .then((entry) => entry.isDirectory())
        .catch(() => false);
      if (isDirectory) {
        throw new Error(`"${expanded}" is a directory — give the file name too`);
      }
      const file = extname(expanded).toLowerCase() === ".png" ? expanded : `${expanded}.png`;
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, bytes);
      return {
        content: [
          ...digest(),
          { type: "text" as const, text: `PNG of ${scope} saved to ${file} (${size})` }
        ]
      };
    }
  );

  return server;
}
