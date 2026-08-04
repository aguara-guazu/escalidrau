import type { SceneElement } from "./scene.js";

type Bbox = { x: number; y: number; width: number; height: number };

type Part = {
  part: string;
  bbox: Bbox;
  center: { x: number; y: number };
  elementCount: number;
  types: Record<string, number>;
  texts: string[];
  elementIds: string[];
};

export type Layout = {
  canvas: Bbox | null;
  parts: Part[];
  overlaps: Array<{ parts: [string, string] }>;
};

const MAX_IDS_PER_PART = 30;
const MAX_TEXTS_PER_PART = 5;

const truncate = (value: string, max = 40) =>
  value.length > max ? `${value.slice(0, max)}…` : value;

const bboxOf = (elements: SceneElement[]): Bbox => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const element of elements) {
    const x = element.x as number;
    const y = element.y as number;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + (element.width as number));
    maxY = Math.max(maxY, y + (element.height as number));
  }
  return {
    x: Math.round(minX),
    y: Math.round(minY),
    width: Math.round(maxX - minX),
    height: Math.round(maxY - minY)
  };
};

const intersects = (a: Bbox, b: Bbox) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Spatial analysis of the scene: elements are clustered into connected
 * "parts" (a diagram of shapes joined by bound arrows, groups, labels and
 * frames is one part) with bounding boxes and pairwise overlaps. This is
 * what lets an agent reason about arrangement without pixel access.
 */
export function buildLayout(elements: SceneElement[]): Layout {
  const alive = elements.filter((element) => !element.isDeleted);
  if (alive.length === 0) {
    return { canvas: null, parts: [], overlaps: [] };
  }

  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    let current = id;
    while (parent.get(current) !== root) {
      const next = parent.get(current)!;
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  const union = (a?: unknown, b?: unknown) => {
    if (typeof a !== "string" || typeof b !== "string") {
      return;
    }
    if (!parent.has(a) || !parent.has(b)) {
      return;
    }
    parent.set(find(a), find(b));
  };

  for (const element of alive) {
    parent.set(element.id, element.id);
  }
  const groups = new Map<string, string>();
  for (const element of alive) {
    union(element.id, element.containerId);
    union(element.id, element.frameId);
    const startBinding = element.startBinding as { elementId?: string } | null | undefined;
    const endBinding = element.endBinding as { elementId?: string } | null | undefined;
    union(element.id, startBinding?.elementId);
    union(element.id, endBinding?.elementId);
    for (const groupId of (element.groupIds as string[] | undefined) ?? []) {
      const representative = groups.get(groupId);
      if (representative) {
        union(element.id, representative);
      } else {
        groups.set(groupId, element.id);
      }
    }
  }

  const components = new Map<string, SceneElement[]>();
  for (const element of alive) {
    const root = find(element.id);
    const bucket = components.get(root);
    if (bucket) {
      bucket.push(element);
    } else {
      components.set(root, [element]);
    }
  }

  const parts: Part[] = [...components.values()]
    .map((members) => {
      const types: Record<string, number> = {};
      const texts: string[] = [];
      for (const member of members) {
        types[member.type] = (types[member.type] ?? 0) + 1;
        if (typeof member.text === "string" && member.text.trim() !== "" && texts.length < MAX_TEXTS_PER_PART) {
          texts.push(truncate(member.text.trim()));
        }
      }
      const bbox = bboxOf(members);
      return {
        part: "",
        bbox,
        center: {
          x: Math.round(bbox.x + bbox.width / 2),
          y: Math.round(bbox.y + bbox.height / 2)
        },
        elementCount: members.length,
        types,
        texts,
        elementIds: members.slice(0, MAX_IDS_PER_PART).map((member) => member.id)
      };
    })
    .sort((a, b) => b.bbox.width * b.bbox.height - a.bbox.width * a.bbox.height)
    .map((part, index) => ({ ...part, part: `part-${index + 1}` }));

  const overlaps: Layout["overlaps"] = [];
  for (let i = 0; i < parts.length; i += 1) {
    for (let j = i + 1; j < parts.length; j += 1) {
      if (intersects(parts[i].bbox, parts[j].bbox)) {
        overlaps.push({ parts: [parts[i].part, parts[j].part] });
      }
    }
  }

  return { canvas: bboxOf(alive), parts, overlaps };
}
