import { convertToExcalidrawElements, exportToBlob } from "@excalidraw/excalidraw";
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
  LibraryItem,
  LibraryItems
} from "@excalidraw/excalidraw/types";
import catalogUrl from "./assets/aws-icons.json?url";

export type BundledIcon = {
  id: string;
  kind: "service" | "resource" | "group" | "general";
  folder: string[];
  category: string;
  name: string;
  label: string;
  description: string;
  svg?: string;
  color?: string;
  dashed?: boolean;
};

export type BundledPack = {
  pack: string;
  version: string;
  created: number;
  items: BundledIcon[];
};

// Library items persisted with the metadata the MCP tools read back; the
// extra fields survive Excalidraw's restore/clone/merge (they spread items).
export type StoredLibraryItem = LibraryItem & {
  description?: string;
  category?: string;
  folder?: string[];
  pack?: string;
};

export type InstallResult = { added: number; removed: number };

const SERVICE_SIZE = 64;
const GENERAL_SIZE = 48;
const GROUP_ICON_SIZE = 32;
const GROUP_WIDTH = 320;
const GROUP_HEIGHT = 220;
const LABEL_FONT_SIZE = 16;
const LABEL_GAP = 6;
const PACKS_URL = "/library/packs";

export const loadBundledPack = async (): Promise<BundledPack | null> => {
  try {
    const response = await fetch(catalogUrl);
    return response.ok ? ((await response.json()) as BundledPack) : null;
  } catch {
    return null;
  }
};

const svgDataUrl = (svg: string): string => {
  let binary = "";
  for (const byte of new TextEncoder().encode(svg)) {
    binary += String.fromCharCode(byte);
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
};

// The icon id doubles as its fileId, so every installation shares the same
// ids: scenes and jams reference files every peer already has.
export const bundledFiles = (pack: BundledPack): Record<string, BinaryFileData> => {
  const files: Record<string, BinaryFileData> = {};
  for (const item of pack.items) {
    if (item.svg) {
      files[item.id] = {
        id: item.id as BinaryFileData["id"],
        mimeType: "image/svg+xml",
        dataURL: svgDataUrl(item.svg) as BinaryFileData["dataURL"],
        created: pack.created
      };
    }
  }
  return files;
};

// vite.config.ts routes Excalidraw's library thumbnail renderer to this
// global (it passes `files: null` upstream, which leaves image items blank).
let libraryFilesSource: () => Record<string, BinaryFileData> = () => ({});
Object.defineProperty(globalThis, "__escalidrauLibraryFiles", {
  configurable: true,
  get: () => libraryFilesSource()
});
export const setLibraryFilesSource = (source: () => Record<string, BinaryFileData>) => {
  libraryFilesSource = source;
};

type Skeleton = Record<string, unknown>;

// Groups are AWS-style containers: a sharp box in the group color with the
// small icon on its top-left corner and the label beside it. Resizing the
// rectangle keeps icon and label anchored (their positions are absolute).
const itemSkeletons = (item: BundledIcon): Skeleton[] => {
  const groupIds = [`${item.id}-group`];
  if (item.kind === "group") {
    const color = item.color ?? "#232F3E";
    const skeletons: Skeleton[] = [
      {
        type: "rectangle",
        id: `${item.id}-box`,
        x: 0,
        y: 0,
        width: GROUP_WIDTH,
        height: GROUP_HEIGHT,
        strokeColor: color,
        backgroundColor: "transparent",
        strokeWidth: 2,
        strokeStyle: item.dashed ? "dashed" : "solid",
        roughness: 0,
        roundness: null,
        groupIds
      }
    ];
    if (item.svg) {
      skeletons.push({
        type: "image",
        id: `${item.id}-icon`,
        x: 0,
        y: 0,
        width: GROUP_ICON_SIZE,
        height: GROUP_ICON_SIZE,
        fileId: item.id,
        status: "saved",
        groupIds
      });
    }
    skeletons.push({
      type: "text",
      id: `${item.id}-label`,
      x: item.svg ? GROUP_ICON_SIZE + 8 : 12,
      y: item.svg ? 6 : 8,
      text: item.label,
      fontSize: LABEL_FONT_SIZE,
      textAlign: "left",
      strokeColor: color,
      groupIds
    });
    return skeletons;
  }
  const size = item.kind === "service" ? SERVICE_SIZE : GENERAL_SIZE;
  return [
    {
      type: "image",
      id: `${item.id}-icon`,
      x: 0,
      y: 0,
      width: size,
      height: size,
      fileId: item.id,
      status: "saved",
      groupIds
    },
    {
      // Centered text: x is the anchor, the converter offsets by half the width.
      type: "text",
      id: `${item.id}-label`,
      x: size / 2,
      y: size + LABEL_GAP,
      text: item.label,
      fontSize: LABEL_FONT_SIZE,
      textAlign: "center",
      groupIds
    }
  ];
};

export const buildLibraryItems = (pack: BundledPack): StoredLibraryItem[] =>
  pack.items.map((item) => ({
    id: item.id,
    status: "published",
    created: pack.created,
    name: item.name,
    description: item.description,
    category: item.category,
    folder: item.folder,
    pack: pack.pack,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    elements: convertToExcalidrawElements(itemSkeletons(item) as any, { regenerateIds: false })
  }));

// Excalidraw loads fonts lazily, and text measured before Excalifont is in
// document.fonts gets the fallback font's metrics. The export path loads the
// faces for the characters it renders, so a throwaway render of every label
// character makes the measurements below exact.
const warmUpFonts = async (pack: BundledPack) => {
  const characters = [...new Set(pack.items.flatMap((item) => [...item.label]))].join("");
  const probe = convertToExcalidrawElements(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [{ type: "text", text: characters, fontSize: LABEL_FONT_SIZE }] as any
  );
  await exportToBlob({
    elements: probe,
    files: null,
    mimeType: "image/png",
    getDimensions: () => ({ width: 1, height: 1, scale: 1 })
  });
};

const readPacks = async (): Promise<Record<string, string> | null> => {
  try {
    const response = await fetch(PACKS_URL);
    if (!response.ok) {
      return null;
    }
    const parsed = (await response.json()) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return null;
  }
};

/**
 * Installs the bundled pack into the user's library once per pack version,
 * through the same path a pack from the public catalog takes (updateLibrary →
 * onLibraryChange → PUT /library). Items the user removed stay removed until
 * the pack version changes; items dropped by a newer pack are removed then.
 * Returns null when nothing had to be done.
 */
export const installBundledPack = async (
  api: ExcalidrawImperativeAPI,
  pack: BundledPack,
  initialLibrary: LibraryItems
): Promise<InstallResult | null> => {
  const packs = await readPacks();
  if (packs === null || packs[pack.pack] === pack.version) {
    return null;
  }
  await warmUpFonts(pack).catch(() => undefined);
  const fresh = buildLibraryItems(pack);
  const catalogIds = new Set(fresh.map((item) => item.id));
  // Items fetched at startup that Excalidraw will keep once its initial load
  // lands; seeding before that would build on an empty library.
  const expectedIds = initialLibrary
    .filter((item) => typeof item.id === "string" && Array.isArray(item.elements) && item.elements.length > 0)
    .map((item) => item.id);
  const result: InstallResult = { added: 0, removed: 0 };
  await api.updateLibrary({
    libraryItems: (current) => {
      const currentIds = new Set(current.map((item) => item.id));
      if (expectedIds.some((id) => !currentIds.has(id))) {
        throw new Error("The library has not finished loading");
      }
      const kept = current.filter(
        (item) => (item as StoredLibraryItem).pack !== pack.pack || catalogIds.has(item.id)
      );
      const additions = fresh.filter((item) => !currentIds.has(item.id));
      result.removed = current.length - kept.length;
      result.added = additions.length;
      return [...kept, ...additions];
    },
    defaultStatus: "published"
  });
  await fetch(PACKS_URL, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...packs, [pack.pack]: pack.version })
  });
  return result;
};
