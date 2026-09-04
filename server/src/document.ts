import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";

/**
 * Which file the board belongs to, and whether it still matches that file.
 *
 * The tracker only remembers the path: whether there are unsaved changes is
 * answered by comparing the live scene against the file on disk, so a save
 * made from the app's own menu counts just as much as one made through the
 * tools. Only the elements are compared, and only the properties that a save
 * would write — an edit that was undone leaves no pending change.
 */
export class DocumentTracker {
  private currentPath: string | null = null;
  private synced: string | null = null;

  get path(): string | null {
    return this.currentPath;
  }

  get name(): string | null {
    return this.currentPath === null ? null : basename(this.currentPath);
  }

  /** Signature of the scene as it was when it last met the file. */
  get syncedSignature(): string | null {
    return this.synced;
  }

  /** Called when the board is written to, or read from, a file. */
  sync(path: string, signature: string) {
    this.currentPath = path;
    this.synced = signature;
  }

  /** Called when the board is emptied and no longer belongs to a file. */
  clear() {
    this.currentPath = null;
    this.synced = null;
  }
}

// Bumped on every edit and on undo, so they say nothing about whether the
// content differs from what was saved.
const VOLATILE_KEYS = new Set(["version", "versionNonce", "updated"]);

type Element = Record<string, unknown> & { id?: string; isDeleted?: boolean };

// null, [] and a missing key all mean the same thing to the editor, which
// normalizes between them when it loads a file.
const isEmpty = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0);

const round = (value: unknown): unknown => {
  if (typeof value === "number") {
    return Math.round(value * 100) / 100;
  }
  if (Array.isArray(value)) {
    return value.map(round);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, round(nested)]));
  }
  return value;
};

/** What an element draws, without the bookkeeping that rides along with it. */
const drawing = (element: Element): string => {
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(element)) {
    if (!VOLATILE_KEYS.has(key) && !isEmpty(value)) {
      projected[key] = value;
    }
  }
  // Arrows and lines keep their geometry in `points`, which the editor
  // re-anchors on its own — the first point back to the origin, sub-pixel
  // corrections when a bound shape moves — without the drawing changing. So
  // compare the points relative to the first one, with the offset folded into
  // the position, and drop the size that is derived from them.
  const points = projected.points;
  if (Array.isArray(points) && Array.isArray(points[0])) {
    const [ox, oy] = points[0] as number[];
    projected.points = (points as number[][]).map(([x, y]) => [x - ox, y - oy]);
    projected.x = ((projected.x as number) ?? 0) + ox;
    projected.y = ((projected.y as number) ?? 0) + oy;
    delete projected.width;
    delete projected.height;
  }
  const entries = Object.entries(round(projected) as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return JSON.stringify(entries);
};

/**
 * Fingerprint of the drawing in a serialized scene: alive elements only,
 * order-independent, blind to everything a save would not change.
 */
export const sceneSignature = (elements: unknown): string => {
  const alive = (Array.isArray(elements) ? (elements as Element[]) : [])
    .filter((element) => element.isDeleted !== true)
    .map((element) => drawing(element))
    .sort();
  return createHash("sha1").update(JSON.stringify(alive)).digest("hex");
};

/** The elements of a serialized .excalidraw document, or null if it is not one. */
export const sceneElements = (json: string): unknown[] | null => {
  try {
    const parsed = JSON.parse(json) as { type?: string; elements?: unknown };
    if (parsed.type !== "excalidraw" || !Array.isArray(parsed.elements)) {
      return null;
    }
    return parsed.elements;
  } catch {
    return null;
  }
};

/** Expands a leading ~ and insists on an absolute path. */
export const expandUserPath = (raw: string): string => {
  const expanded = raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw;
  if (!isAbsolute(expanded)) {
    throw new Error(`"path" must be an absolute file path (got "${raw}")`);
  }
  return expanded;
};

/**
 * Appends `extension` when the path does not already end in it (a path that
 * ends in a different extension keeps it, so "board.v2" does not turn into
 * "board.v2.excalidraw").
 */
export const withExtension = (path: string, extension: `.${string}`): string =>
  extname(path).toLowerCase() === extension ? path : `${path}${extension}`;
