import type { SceneElement } from "./scene.js";

type Binding = { elementId: string } | null | undefined;
type BoundElement = { id: string; type: string };

const NODE_TYPES = new Set(["rectangle", "ellipse", "diamond"]);

const sanitizeId = (id: string): string => {
  const cleaned = id.replace(/[^A-Za-z0-9]/g, "_");
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `n_${cleaned}`;
};

const escapeLabel = (text: string): string =>
  text.replace(/"/g, "#quot;").replace(/\s*\n\s*/g, " ").trim();

const nodeSyntax = (type: string, id: string, label: string): string => {
  const safe = escapeLabel(label);
  if (type === "diamond") {
    return `${id}{"${safe}"}`;
  }
  if (type === "ellipse") {
    return `${id}(["${safe}"])`;
  }
  return `${id}["${safe}"]`;
};

/**
 * Projects the scene onto Mermaid flowchart syntax: rectangles, ellipses and
 * diamonds become nodes (with their bound label text), bound arrows become
 * edges (with their label), frames become subgraphs and free-standing text
 * becomes plain nodes. Geometry-only content (freedraw, lines, images,
 * unbound arrows) has no Mermaid equivalent and is reported as skipped.
 */
export function sceneToMermaid(elements: SceneElement[]): {
  mermaid: string;
  skipped: Record<string, number>;
} {
  const alive = elements.filter((element) => !element.isDeleted);
  const byId = new Map(alive.map((element) => [element.id, element]));

  // originalText holds the unwrapped text; text carries the visual line
  // breaks the editor inserted to fit the container.
  const textOf = (element: SceneElement | undefined): string => {
    if (typeof element?.originalText === "string" && element.originalText !== "") {
      return element.originalText;
    }
    return typeof element?.text === "string" ? element.text : "";
  };

  const labelOf = (element: SceneElement): string => {
    const bound = (element.boundElements as BoundElement[] | undefined)?.find(
      (entry) => entry.type === "text"
    );
    return textOf(bound ? byId.get(bound.id) : undefined);
  };

  const skipped: Record<string, number> = {};
  const skip = (type: string) => {
    skipped[type] = (skipped[type] ?? 0) + 1;
  };

  const nodeDeclarations = new Map<string, string>();
  for (const element of alive) {
    if (NODE_TYPES.has(element.type)) {
      const label = labelOf(element) || element.type;
      nodeDeclarations.set(element.id, nodeSyntax(element.type, sanitizeId(element.id), label));
    } else if (element.type === "text" && !element.containerId) {
      nodeDeclarations.set(
        element.id,
        nodeSyntax("rectangle", sanitizeId(element.id), textOf(element))
      );
    } else if (
      element.type !== "arrow" &&
      element.type !== "frame" &&
      !(element.type === "text" && element.containerId)
    ) {
      skip(element.type);
    }
  }

  const edges: string[] = [];
  let horizontal = 0;
  let vertical = 0;
  for (const element of alive) {
    if (element.type !== "arrow") {
      continue;
    }
    const startId = (element.startBinding as Binding)?.elementId;
    const endId = (element.endBinding as Binding)?.elementId;
    if (!startId || !endId || !nodeDeclarations.has(startId) || !nodeDeclarations.has(endId)) {
      skip("arrow (sin conexiones)");
      continue;
    }
    const start = byId.get(startId)!;
    const end = byId.get(endId)!;
    if (
      Math.abs((end.x as number) - (start.x as number)) >=
      Math.abs((end.y as number) - (start.y as number))
    ) {
      horizontal += 1;
    } else {
      vertical += 1;
    }
    const label = labelOf(element);
    edges.push(
      label
        ? `${sanitizeId(startId)} -->|"${escapeLabel(label)}"| ${sanitizeId(endId)}`
        : `${sanitizeId(startId)} --> ${sanitizeId(endId)}`
    );
  }

  const frames = alive.filter((element) => element.type === "frame");
  const frameMembers = new Map<string, string[]>();
  for (const frame of frames) {
    frameMembers.set(
      frame.id,
      alive
        .filter((element) => element.frameId === frame.id && nodeDeclarations.has(element.id))
        .map((element) => element.id)
    );
  }
  const framed = new Set([...frameMembers.values()].flat());

  const lines: string[] = [`flowchart ${horizontal >= vertical ? "LR" : "TD"}`];
  for (const frame of frames) {
    const members = frameMembers.get(frame.id) ?? [];
    if (members.length === 0) {
      continue;
    }
    const frameName = typeof frame.name === "string" && frame.name ? frame.name : "Frame";
    lines.push(`  subgraph ${sanitizeId(frame.id)}["${escapeLabel(frameName)}"]`);
    for (const memberId of members) {
      lines.push(`    ${nodeDeclarations.get(memberId)}`);
    }
    lines.push("  end");
  }
  for (const [id, declaration] of nodeDeclarations) {
    if (!framed.has(id)) {
      lines.push(`  ${declaration}`);
    }
  }
  for (const edge of edges) {
    lines.push(`  ${edge}`);
  }
  const skippedEntries = Object.entries(skipped);
  if (skippedEntries.length > 0) {
    lines.push(
      `  %% sin representación en Mermaid: ${skippedEntries
        .map(([type, count]) => `${type} ×${count}`)
        .join(", ")}`
    );
  }

  return {
    mermaid: nodeDeclarations.size > 0 ? lines.join("\n") : "",
    skipped
  };
}
