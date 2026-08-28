import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaptureUpdateAction, exportToSvg, serializeLibraryAsJSON } from "@excalidraw/excalidraw";
import type {
  BinaryFiles,
  ExcalidrawImperativeAPI,
  LibraryItem
} from "@excalidraw/excalidraw/types";
import type { StoredLibraryItem } from "./bundledIcons";
import { cloneLibraryElements } from "./sync";
import { chevronIcon } from "./icons";

const EXCALIDRAWLIB_MIME = "application/vnd.excalidrawlib+json";
const PERSONAL_FOLDER = "Personal library";
const OTHER_FOLDER = "Other libraries";
const EXPANDED_KEY = "escalidrau-library-folders";
const MAX_RESULTS = 200;

// Items carry their folder path; the rest land in one of two pseudo-folders.
// The MCP server mirrors this mapping so agent and user see the same tree.
export const folderOf = (item: StoredLibraryItem): string[] =>
  Array.isArray(item.folder) && item.folder.length > 0
    ? item.folder
    : [item.status === "unpublished" ? PERSONAL_FOLDER : OTHER_FOLDER];

type FolderNode = {
  name: string;
  path: string;
  children: FolderNode[];
  items: StoredLibraryItem[];
  count: number;
};

// Folders and items keep first-appearance order: the bundled pack is sorted
// the way people look for things, and later installs append after it.
const buildTree = (items: StoredLibraryItem[]): FolderNode => {
  const root: FolderNode = { name: "", path: "", children: [], items: [], count: 0 };
  const byPath = new Map<string, FolderNode>([["", root]]);
  for (const item of items) {
    let node = root;
    let path = "";
    for (const segment of folderOf(item)) {
      path = path ? `${path}/${segment}` : segment;
      let child = byPath.get(path);
      if (!child) {
        child = { name: segment, path, children: [], items: [], count: 0 };
        byPath.set(path, child);
        node.children.push(child);
      }
      node = child;
    }
    node.items.push(item);
  }
  const total = (node: FolderNode): number => {
    node.count = node.items.length + node.children.reduce((sum, child) => sum + total(child), 0);
    return node.count;
  };
  total(root);
  return root;
};

const matches = (item: StoredLibraryItem, terms: string[]): boolean => {
  const haystack = `${item.name ?? ""} ${item.description ?? ""} ${folderOf(item).join("/")}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
};

const readExpanded = (): Set<string> => {
  try {
    const stored = localStorage.getItem(EXPANDED_KEY);
    const parsed = stored ? (JSON.parse(stored) as unknown) : null;
    return new Set(Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
};

const writeExpanded = (expanded: Set<string>) => {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]));
  } catch {
    // Storage unavailable — the tree simply starts collapsed next time.
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyElement = Record<string, any>;

const bbox = (elements: AnyElement[]) => {
  const minX = Math.min(...elements.map((element) => element.x as number));
  const minY = Math.min(...elements.map((element) => element.y as number));
  const maxX = Math.max(...elements.map((element) => (element.x as number) + (element.width as number)));
  const maxY = Math.max(...elements.map((element) => (element.y as number) + (element.height as number)));
  return { minX, minY, width: maxX - minX, height: maxY - minY };
};

// Drops a fresh copy of the item in the middle of the viewport and selects it
// (as a group when the item is one), the way the built-in library does.
export const insertLibraryItem = (api: ExcalidrawImperativeAPI, item: StoredLibraryItem) => {
  const cloned = cloneLibraryElements(item.elements as unknown as AnyElement[]);
  if (cloned.length === 0) {
    return;
  }
  const state = api.getAppState();
  const box = bbox(cloned);
  const centerX = -state.scrollX + state.width / (2 * state.zoom.value);
  const centerY = -state.scrollY + state.height / (2 * state.zoom.value);
  const dx = centerX - (box.minX + box.width / 2);
  const dy = centerY - (box.minY + box.height / 2);
  const placed: AnyElement[] = cloned.map((element) => ({
    ...element,
    x: (element.x as number) + dx,
    y: (element.y as number) + dy
  }));
  const sharedGroup = (placed[0].groupIds as string[] | undefined)?.find((groupId) =>
    placed.every((element) => (element.groupIds as string[] | undefined)?.includes(groupId))
  );
  api.updateScene({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    elements: [...api.getSceneElementsIncludingDeleted(), ...placed] as any,
    appState: {
      selectedElementIds: Object.fromEntries(placed.map((element) => [element.id as string, true])),
      selectedGroupIds: sharedGroup ? { [sharedGroup]: true } : {}
    },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY
  });
};

const svgCache = new Map<string, SVGSVGElement>();

// An item that is a single image (plus labels) shows the image itself; any
// other composition goes through the SVG exporter, cached per item.
function ItemThumb({ item, files }: { item: StoredLibraryItem; files: BinaryFiles }) {
  const elements = item.elements as unknown as AnyElement[];
  const shapes = elements.filter((element) => element.type !== "text");
  const image = shapes.length === 1 && shapes[0].type === "image" ? files[shapes[0].fileId as string] : undefined;
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (image) {
      return;
    }
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let cancelled = false;
    const cached = svgCache.get(item.id);
    const render = (svg: SVGSVGElement) => {
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.removeAttribute("width");
      clone.removeAttribute("height");
      container.replaceChildren(clone);
    };
    if (cached) {
      render(cached);
      return;
    }
    void exportToSvg({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      elements: elements as any,
      appState: { exportBackground: false },
      files,
      skipInliningFonts: true
    })
      .then((svg: SVGSVGElement) => {
        svgCache.set(item.id, svg);
        if (!cancelled) {
          render(svg);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [item, elements, files, image]);
  if (image) {
    return <img src={image.dataURL} alt="" draggable={false} />;
  }
  return <div ref={containerRef} className="esc-folders__svg" />;
}

type ItemCellProps = {
  item: StoredLibraryItem;
  files: BinaryFiles;
  onInsert: (item: StoredLibraryItem) => void;
};

function ItemCell({ item, files, onInsert }: ItemCellProps) {
  const title = item.description ? `${item.name ?? ""}\n${item.description}` : item.name ?? "";
  return (
    <div
      className="esc-folders__item"
      role="button"
      tabIndex={0}
      title={title}
      draggable
      onClick={() => onInsert(item)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onInsert(item);
        }
      }}
      onDragStart={(event) => {
        const copy = {
          ...item,
          elements: cloneLibraryElements(item.elements as unknown as AnyElement[])
        } as unknown as LibraryItem;
        event.dataTransfer.setData(EXCALIDRAWLIB_MIME, serializeLibraryAsJSON([copy]));
        event.dataTransfer.effectAllowed = "copy";
      }}
    >
      <div className="esc-folders__thumb">
        <ItemThumb item={item} files={files} />
      </div>
      <div className="esc-folders__caption">{item.name ?? "Untitled"}</div>
    </div>
  );
}

type FolderViewProps = {
  node: FolderNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  files: BinaryFiles;
  onInsert: (item: StoredLibraryItem) => void;
};

function FolderView({ node, depth, expanded, onToggle, files, onInsert }: FolderViewProps) {
  const open = expanded.has(node.path);
  return (
    <div className="esc-folders__node">
      <button
        type="button"
        className="esc-folders__row"
        style={{ paddingLeft: 8 + depth * 14 }}
        aria-expanded={open}
        onClick={() => onToggle(node.path)}
      >
        <span className="esc-folders__chevron" data-open={open}>
          {chevronIcon}
        </span>
        <span className="esc-folders__name">{node.name}</span>
        <span className="esc-folders__count">{node.count}</span>
      </button>
      {open ? (
        <>
          {node.children.map((child) => (
            <FolderView
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              files={files}
              onInsert={onInsert}
            />
          ))}
          {node.items.length > 0 ? (
            <div className="esc-folders__grid" style={{ paddingLeft: 12 + depth * 14 }}>
              {node.items.map((item) => (
                <ItemCell key={item.id} item={item} files={files} onInsert={onInsert} />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

type Props = {
  items: StoredLibraryItem[];
  api: ExcalidrawImperativeAPI | null;
};

/**
 * Sidebar tab that shows the whole library as a folder tree (collection →
 * category → items). Click inserts an item at the viewport center; dragging
 * onto the canvas goes through Excalidraw's own library drop handling.
 */
export function LibraryFolders({ items, api }: Props) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => readExpanded());
  const tree = useMemo(() => buildTree(items), [items]);
  const files = api?.getFiles() ?? {};

  // First launch: collections open, their subfolders closed.
  useEffect(() => {
    if (localStorage.getItem(EXPANDED_KEY) !== null || tree.children.length === 0) {
      return;
    }
    setExpanded(new Set(tree.children.map((child) => child.path)));
  }, [tree]);

  const toggle = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      writeExpanded(next);
      return next;
    });
  }, []);

  const insert = useCallback(
    (item: StoredLibraryItem) => {
      if (api) {
        insertLibraryItem(api, item);
      }
    },
    [api]
  );

  const terms = query.toLowerCase().split(/\s+/).filter((term) => term !== "");
  const results = useMemo(() => {
    if (terms.length === 0) {
      return null;
    }
    const found = items.filter((item) => matches(item, terms));
    const groups = new Map<string, StoredLibraryItem[]>();
    for (const item of found.slice(0, MAX_RESULTS)) {
      const path = folderOf(item).join(" / ");
      groups.set(path, [...(groups.get(path) ?? []), item]);
    }
    return { total: found.length, groups };
  }, [items, terms.join(" ")]);

  return (
    <div className="esc-ui esc-folders">
      <input
        className="esc-input esc-folders__search"
        type="search"
        placeholder={`Search ${items.length} library items…`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label="Search the library"
      />
      <div className="esc-folders__scroll">
        {items.length === 0 ? (
          <div className="esc-folders__empty">No library items yet.</div>
        ) : results ? (
          results.total === 0 ? (
            <div className="esc-folders__empty">Nothing matches “{query.trim()}”.</div>
          ) : (
            <>
              {[...results.groups.entries()].map(([path, groupItems]) => (
                <div key={path}>
                  <div className="esc-folders__group">{path}</div>
                  <div className="esc-folders__grid">
                    {groupItems.map((item) => (
                      <ItemCell key={item.id} item={item} files={files} onInsert={insert} />
                    ))}
                  </div>
                </div>
              ))}
              {results.total > MAX_RESULTS ? (
                <div className="esc-folders__empty">
                  Showing {MAX_RESULTS} of {results.total} matches — refine the search.
                </div>
              ) : null}
            </>
          )
        ) : (
          tree.children.map((child) => (
            <FolderView
              key={child.path}
              node={child}
              depth={0}
              expanded={expanded}
              onToggle={toggle}
              files={files}
              onInsert={insert}
            />
          ))
        )}
      </div>
    </div>
  );
}
