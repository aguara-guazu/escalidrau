import { writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CanvasBridge } from "./bridge.js";
import type { SceneStore } from "./scene.js";
import type { ChangeTracker } from "./changes.js";
import { buildLayout, partElementIds } from "./layout.js";
import { sceneToMermaid } from "./mermaid.js";

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
To connect elements that already exist on the canvas, draw the arrow with explicit x/y/points coordinates (cross-call id binding is not supported).

Example:
[{"id":"api","type":"rectangle","x":100,"y":100,"width":180,"height":70,"label":{"text":"API"}},
 {"id":"db","type":"rectangle","x":420,"y":100,"width":180,"height":70,"label":{"text":"DB"}},
 {"type":"arrow","x":280,"y":135,"start":{"id":"api"},"end":{"id":"db"}}]

Size shapes to their text (default font ~= 11px per character): usable width is width - 30px for rectangles, 70% of width for ellipses, 50% for diamonds — the longest unbreakable word must fit or it breaks mid-word. Leave ~12px per label character of gap between shapes joined by a labeled arrow.
After a batch of edits, call view_canvas to visually verify the result.`;

export type SessionContext = {
  store: SceneStore;
  bridge: CanvasBridge;
  tracker: ChangeTracker;
  canvasUrl: string;
  readLibrary: () => Promise<unknown[]>;
};

type StoredLibraryItem = {
  id?: string;
  name?: string;
  elements: Array<Record<string, unknown>>;
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

If installed library icons match the diagram's domain (check get_library), prefer placing them with add_library_item over drawing generic shapes.

The human edits concurrently: tool responses open with a digest of their changes — read it and never overwrite their work blindly.`;

const SCENE_URI = "scene://current";

export function createSessionServer({ store, bridge, tracker, canvasUrl, readLibrary }: SessionContext) {
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
    async ({ elements }) => mutationResult(await bridge.request("add_elements", { elements }))
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
        "List the shape-library items installed in the app (icon packs like AWS services). Returns each item's index and name. When a diagram's domain matches installed icons, prefer placing them (add_library_item) over drawing plain shapes; use view_library to see what they look like.",
      inputSchema: {}
    },
    async () => {
      const items = normalizeLibrary(await readLibrary());
      return jsonResult({
        count: items.length,
        items: items.map((item, index) => ({
          index,
          name: item.name ?? null,
          elements: item.elements.length
        }))
      });
    }
  );

  server.registerTool(
    "view_library",
    {
      description:
        "Render installed library items as a labeled contact-sheet image so you can see what each icon looks like. Paginate with offset/limit; labels show the index to use with add_library_item.",
      inputSchema: {
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(40).default(24)
      }
    },
    async ({ offset, limit }) => {
      const items = normalizeLibrary(await readLibrary());
      const page = items.slice(offset, offset + limit);
      if (page.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No library items in range (library has ${items.length}).`
            }
          ]
        };
      }
      const payload = page.map((item, position) => ({
        label: `${offset + position}${item.name ? ` ${item.name}` : ""}`,
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
            text: `Library items ${offset}-${offset + page.length - 1} of ${items.length}. Place one with add_library_item { item: <index>, x, y }.`
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
        "Place an installed library icon on the canvas by its index (from get_library / view_library). x/y set the top-left of the placed item. The instance is independent — connect it with arrows or move it like any other part.",
      inputSchema: {
        item: z.number().int().min(0),
        x: z.number(),
        y: z.number()
      }
    },
    async ({ item, x, y }) => {
      const items = normalizeLibrary(await readLibrary());
      const entry = items[item];
      if (!entry) {
        throw new Error(`No library item at index ${item} (library has ${items.length})`);
      }
      const result = await bridge.request(
        "add_library_item",
        { elements: entry.elements, x, y },
        30_000
      );
      return mutationResult({ name: entry.name ?? null, ...(result as object) });
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
        "Export the current canvas as an image. PNG returns the rendered image (also written to \"path\" if given, which must be an absolute file path). SVG returns markup as text, or writes it to \"path\". Use scale > 1 for higher resolution PNGs.",
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

  return server;
}
