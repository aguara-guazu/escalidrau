import { useCallback, useEffect, useRef, useState } from "react";
import {
  DefaultSidebar,
  Excalidraw,
  MainMenu,
  Sidebar,
  WelcomeScreen,
  loadFromBlob,
  useHandleLibrary
} from "@excalidraw/excalidraw";
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
  LibraryItems
} from "@excalidraw/excalidraw/types";
import { SyncClient } from "./sync";
import { CollabClient, type RoomInfo } from "./collab";
import { RoomDialog } from "./RoomDialog";
import { JamButton } from "./JamButton";
import { WhatsNewDialog } from "./WhatsNewDialog";
import { MermaidDialog } from "./MermaidDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { StyleDialog } from "./StyleDialog";
import { WelcomeHint } from "./WelcomeHint";
import { LibraryFolders } from "./LibraryFolders";
import { copyIcon, folderIcon, importIcon, libraryIcon, routeIcon, trashIcon } from "./icons";
import {
  bundledFiles,
  installBundledPack,
  loadBundledPack,
  setLibraryFilesSource,
  type BundledPack,
  type StoredLibraryItem
} from "./bundledIcons";
import "./ui.css";
import "./debrand.css";

const MERMAID_KEYWORDS = /^\s*(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram)\b/;
// Tab of the default sidebar that shows the library as folders.
const FOLDERS_TAB = "folders";

type DroppedFile = {
  name: string;
  kind: "scene" | "mermaid";
  content: string;
  replace: boolean;
};

const detectDroppedKind = (name: string, content: string): DroppedFile["kind"] | null => {
  if (name.endsWith(".excalidraw")) {
    return "scene";
  }
  if (name.endsWith(".mmd") || name.endsWith(".mermaid")) {
    return "mermaid";
  }
  if (MERMAID_KEYWORDS.test(content)) {
    return "mermaid";
  }
  try {
    const parsed = JSON.parse(content) as { type?: string };
    if (parsed.type === "excalidraw") {
      return "scene";
    }
  } catch {
    // not JSON — fall through
  }
  return null;
};

export default function App() {
  const syncRef = useRef<SyncClient | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawImperativeAPI | null>(null);
  const [mermaidOpen, setMermaidOpen] = useState(false);
  const [mermaidBusy, setMermaidBusy] = useState(false);
  const [mermaidError, setMermaidError] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  // Hints for the app's own top-right controls, shown alongside the editor's
  // welcome screen: empty canvas, nothing open on top of it.
  const [showHints, setShowHints] = useState(true);
  const showHintsRef = useRef(true);
  const [dropped, setDropped] = useState<DroppedFile | null>(null);
  const collabRef = useRef<CollabClient | null>(null);
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [roomOpen, setRoomOpen] = useState(false);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [whatsNew, setWhatsNew] = useState<{ version: string; notes: string } | null>(null);
  const [updateNotice, setUpdateNotice] = useState<{ version: string; url: string } | null>(null);
  const [colorChoice, setColorChoice] = useState<number | null>(() => {
    const stored = localStorage.getItem("escalidrau-cursor-color");
    return stored === null || stored === "auto" ? null : Number(stored);
  });
  // Installed shape libraries live server-side (they must survive restarts).
  const [initialData] = useState(() => ({
    libraryItems: fetch("/library")
      .then((response) => (response.ok ? response.json() : []))
      .catch(() => []) as Promise<LibraryItems>
  }));
  // Mirror of the editor's library for the folder view (onLibraryChange feeds it).
  const [libraryItems, setLibraryItems] = useState<StoredLibraryItem[]>([]);
  useEffect(() => {
    void initialData.libraryItems.then((items) => setLibraryItems(items as StoredLibraryItem[]));
  }, [initialData]);
  // The bundled AWS icon pack: its SVGs must be registered as files before the
  // editor renders (library thumbnails read them), so the editor mounts once
  // the pack is loaded. undefined = loading, null = unavailable.
  const [pack, setPack] = useState<BundledPack | null | undefined>(undefined);
  const packRef = useRef<BundledPack | null>(null);
  const packFilesRef = useRef<Record<string, BinaryFileData>>({});
  useEffect(() => {
    void loadBundledPack().then((loaded) => {
      if (loaded) {
        packRef.current = loaded;
        packFilesRef.current = bundledFiles(loaded);
        setLibraryFilesSource(() => packFilesRef.current);
      }
      setPack(loaded);
    });
  }, []);

  // Handles the #addLibrary return from the public libraries site.
  useHandleLibrary({ excalidrawAPI });

  const handleApi = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
    setExcalidrawAPI(api);
    const bundled = packRef.current;
    if (bundled) {
      api.addFiles(Object.values(packFilesRef.current));
      setLibraryFilesSource(() => api.getFiles());
      void initialData.libraryItems
        .then((items) => installBundledPack(api, bundled, items))
        .then((result) => {
          if (result && result.added > 0) {
            api.setToast({
              message: `AWS Architecture Icons added to your library (${result.added} items)`,
              duration: 4000
            });
          }
        })
        .catch((error) => console.error("[library] bundled pack install failed:", error));
    }
    if (!syncRef.current) {
      syncRef.current = new SyncClient(api);
      const sync = syncRef.current;
      void fetch("/settings")
        .then((response) => (response.ok ? response.json() : null))
        .then((settings) => {
          if (settings?.connectors && settings?.text) {
            sync.applyCanvasStyle(
              {
                preset: settings.connectors.preset,
                route: settings.connectors.route,
                font: settings.text.font
              },
              false
            );
          }
        })
        .catch(() => undefined);
    }
    if (!collabRef.current) {
      const collab = new CollabClient(api);
      collab.onRoomChange = (info) => setRoomInfo(info);
      collab.onRoomFull = () => {
        setRoomError("That room is full (10 people max).");
        setRoomOpen(true);
      };
      collab.onMemberEvent = (event) => {
        const message =
          event.kind === "join"
            ? `${event.nick} joined the room`
            : event.kind === "leave"
              ? `${event.nick} left the room`
              : event.isSelf
                ? "The host left — you are the host now"
                : `The host left — ${event.nick} is the host now`;
        api.setToast({ message, duration: 3000 });
      };
      const stored = localStorage.getItem("escalidrau-cursor-color");
      if (stored !== null && stored !== "auto") {
        collab.setColorChoice(Number(stored));
      }
      collabRef.current = collab;
      // Deep link / testing: ?room=CODE&nick=NAME[&owner=1] joins on load.
      const params = new URLSearchParams(window.location.search);
      const roomParam = params.get("room");
      const nickParam = params.get("nick");
      if (roomParam && nickParam) {
        collab.join(roomParam, nickParam, params.get("owner") === "1");
      }
    }
  }, []);

  const chooseColor = useCallback((index: number | null) => {
    setColorChoice(index);
    localStorage.setItem("escalidrau-cursor-color", index === null ? "auto" : String(index));
    collabRef.current?.setColorChoice(index);
  }, []);

  const persistLibrary = useCallback((items: LibraryItems) => {
    setLibraryItems(items as StoredLibraryItem[]);
    void fetch("/library", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(items)
    }).catch(() => {
      apiRef.current?.setToast({ message: "Could not persist the library", duration: 2500 });
    });
  }, []);

  const copyAsMermaid = useCallback(async () => {
    try {
      const response = await fetch("/mermaid");
      const mermaid = await response.text();
      if (mermaid.trim() === "") {
        apiRef.current?.setToast({ message: "Nothing on the canvas to convert", duration: 2500 });
        return;
      }
      await navigator.clipboard.writeText(mermaid);
      apiRef.current?.setToast({ message: "Mermaid copied to clipboard", duration: 2500 });
    } catch {
      apiRef.current?.setToast({ message: "Could not generate Mermaid", duration: 2500 });
    }
  }, []);

  const importMermaid = useCallback(async (definition: string) => {
    setMermaidBusy(true);
    setMermaidError(null);
    try {
      await syncRef.current?.insertMermaid(definition);
      setMermaidOpen(false);
      apiRef.current?.setToast({ message: "Mermaid imported", duration: 2000 });
    } catch (error) {
      setMermaidError(error instanceof Error ? error.message : String(error));
    } finally {
      setMermaidBusy(false);
    }
  }, []);

  const importDropped = useCallback(async (file: DroppedFile) => {
    const api = apiRef.current;
    if (!api) {
      return;
    }
    try {
      if (file.replace) {
        syncRef.current?.resetCanvas();
      }
      if (file.kind === "mermaid") {
        await syncRef.current?.insertMermaid(file.content);
      } else {
        const restored = await loadFromBlob(
          new Blob([file.content], { type: "application/json" }),
          null,
          null
        );
        if (restored.files) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          api.addFiles(Object.values(restored.files) as any);
        }
        api.updateScene({ elements: restored.elements });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        api.scrollToContent(restored.elements as any, { fitToViewport: true });
      }
      api.setToast({ message: `Imported ${file.name}`, duration: 2000 });
    } catch (error) {
      api.setToast({
        message: `Could not import ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
        duration: 4000
      });
    } finally {
      setDropped(null);
    }
  }, []);

  // On platforms the app cannot update by itself, point at the download page.
  useEffect(() => {
    void fetch("/update-notice")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (payload && typeof payload.version === "string") {
          setUpdateNotice({ version: payload.version, url: String(payload.url) });
        }
      })
      .catch(() => undefined);
  }, []);

  // Release notes are served once per version by the desktop shell.
  useEffect(() => {
    void fetch("/whatsnew")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (payload && typeof payload.version === "string") {
          setWhatsNew({ version: payload.version, notes: String(payload.notes ?? "") });
        }
      })
      .catch(() => undefined);
  }, []);

  const dismissWhatsNew = useCallback(() => {
    setWhatsNew(null);
    void fetch("/whatsnew", { method: "POST" }).catch(() => undefined);
  }, []);

  // Capture-phase drop interception: scene and Mermaid files are ours;
  // anything else (images, .excalidrawlib) falls through to the canvas.
  useEffect(() => {
    const onDrop = (event: DragEvent) => {
      const file = event.dataTransfer?.files?.[0];
      if (!file) {
        return;
      }
      const name = file.name.toLowerCase();
      const looksOurs =
        name.endsWith(".excalidraw") ||
        name.endsWith(".mmd") ||
        name.endsWith(".mermaid") ||
        name.endsWith(".txt") ||
        name.endsWith(".md");
      if (!looksOurs) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void file.text().then((content) => {
        const kind = detectDroppedKind(name, content);
        if (!kind) {
          apiRef.current?.setToast({
            message: `${file.name} is neither a scene nor Mermaid — ignored`,
            duration: 3000
          });
          return;
        }
        const hasContent = (apiRef.current?.getSceneElements().length ?? 0) > 0;
        setDropped({ name: file.name, kind, content, replace: hasContent });
      });
    };
    window.addEventListener("drop", onDrop, true);
    return () => window.removeEventListener("drop", onDrop, true);
  }, []);

  if (pack === undefined) {
    return <div style={{ height: "100%", width: "100%" }} />;
  }

  return (
    <div style={{ height: "100%", width: "100%" }}>
      <Excalidraw
        excalidrawAPI={handleApi}
        onChange={(elements, appState) => {
          syncRef.current?.onLocalChange();
          collabRef.current?.onLocalChange();
          // Same rule as the editor's welcome screen (which stays hidden once
          // something was drawn), plus nothing open on top of the canvas.
          const visible =
            appState.showWelcomeScreen &&
            !elements.some((element) => !element.isDeleted) &&
            appState.openSidebar === null &&
            appState.openDialog === null;
          if (visible !== showHintsRef.current) {
            showHintsRef.current = visible;
            setShowHints(visible);
          }
        }}
        initialData={initialData}
        onLibraryChange={persistLibrary}
        libraryReturnUrl={window.location.origin}
        isCollaborating={roomInfo !== null}
        onPointerUpdate={(payload) => collabRef.current?.handlePointer(payload)}
        renderTopRightUI={() => (
          <>
            <div className="esc-ui esc-hint-anchor">
              <button
                className="esc-btn esc-btn--top esc-btn--icon"
                title="Canvas style: strokes, arrows and font"
                aria-label="Canvas style"
                onClick={() => setStyleOpen(true)}
              >
                {routeIcon}
              </button>
              {showHints ? (
                <WelcomeHint variant="beside">Set the look: strokes, arrows & font</WelcomeHint>
              ) : null}
            </div>
            <div className="esc-ui esc-hint-anchor">
              <JamButton
            active={roomInfo !== null}
            code={roomInfo?.code ?? null}
            members={roomInfo?.members.length ?? 0}
            onStart={() => {
              setRoomError(null);
              setRoomOpen(true);
            }}
            onShowRoom={() => {
              setRoomError(null);
              setRoomOpen(true);
            }}
            onLeave={() => {
              collabRef.current?.leave();
              apiRef.current?.setToast({ message: "You left the jam", duration: 2000 });
            }}
              />
              {showHints && roomInfo === null ? (
                <WelcomeHint variant="below">Draw live with other people</WelcomeHint>
              ) : null}
            </div>
          </>
        )}
      >
        <MainMenu>
          <MainMenu.DefaultItems.LoadScene />
          <MainMenu.DefaultItems.SaveToActiveFile />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.Item icon={importIcon} onSelect={() => setMermaidOpen(true)}>
            Import Mermaid…
          </MainMenu.Item>
          <MainMenu.Item icon={copyIcon} onSelect={() => void copyAsMermaid()}>
            Copy as Mermaid
          </MainMenu.Item>
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.Item icon={trashIcon} onSelect={() => setResetOpen(true)}>
            Reset the canvas
          </MainMenu.Item>
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
        <WelcomeScreen>
          <WelcomeScreen.Center>
            <WelcomeScreen.Center.Heading>
              Escalidrau — a canvas you share with your agent
            </WelcomeScreen.Center.Heading>
            <WelcomeScreen.Center.Menu>
              <WelcomeScreen.Center.MenuItemLoadScene />
            </WelcomeScreen.Center.Menu>
          </WelcomeScreen.Center>
          <WelcomeScreen.Hints.ToolbarHint />
        </WelcomeScreen>
        <DefaultSidebar.Trigger tab={FOLDERS_TAB} icon={libraryIcon} title="Library">
          Library
        </DefaultSidebar.Trigger>
        <DefaultSidebar>
          <DefaultSidebar.TabTriggers>
            <Sidebar.TabTrigger tab={FOLDERS_TAB} title="Library folders">
              {folderIcon}
            </Sidebar.TabTrigger>
          </DefaultSidebar.TabTriggers>
          <Sidebar.Tab tab={FOLDERS_TAB}>
            <LibraryFolders items={libraryItems} api={excalidrawAPI} />
          </Sidebar.Tab>
        </DefaultSidebar>
      </Excalidraw>
      <MermaidDialog
        open={mermaidOpen}
        busy={mermaidBusy}
        error={mermaidError}
        onImport={(definition) => void importMermaid(definition)}
        onClose={() => {
          setMermaidOpen(false);
          setMermaidError(null);
        }}
      />
      <StyleDialog
        open={styleOpen}
        onClose={() => setStyleOpen(false)}
        onApply={(style, applyToExisting) =>
          syncRef.current?.applyCanvasStyle(style, applyToExisting) ?? 0
        }
        onSaved={(style, restyled) => {
          setStyleOpen(false);
          apiRef.current?.setToast({
            message: `Canvas style: ${style.preset} strokes, ${style.route} arrows, ${style.font} font${restyled > 0 ? ` — ${restyled} element${restyled === 1 ? "" : "s"} restyled` : ""}`,
            duration: 3000
          });
        }}
      />
      <ConfirmDialog
        open={resetOpen}
        title="Reset the canvas"
        confirmLabel="Reset"
        danger
        onConfirm={() => {
          syncRef.current?.resetCanvas();
          setResetOpen(false);
          apiRef.current?.setToast({ message: "Canvas cleared", duration: 2000 });
        }}
        onClose={() => setResetOpen(false)}
      >
        This clears the whole canvas for you and the agent. It cannot be undone.
      </ConfirmDialog>
      <RoomDialog
        open={roomOpen}
        info={roomInfo}
        error={roomError}
        colorChoice={colorChoice}
        onColorChoice={chooseColor}
        onCreate={(code, nick) => {
          setRoomError(null);
          collabRef.current?.join(code, nick, true);
        }}
        onJoin={(code, nick) => {
          setRoomError(null);
          collabRef.current?.join(code, nick, false);
        }}
        onLeave={() => {
          collabRef.current?.leave();
        }}
        onClose={() => setRoomOpen(false)}
      />
      {updateNotice ? (
        <ConfirmDialog
          open
          title={`Version ${updateNotice.version} is available`}
          confirmLabel="Get it"
          onConfirm={() => {
            window.open(updateNotice.url, "_blank");
            setUpdateNotice(null);
          }}
          onClose={() => setUpdateNotice(null)}
        >
          This build cannot replace itself, so grab the new installer when you have a minute.
        </ConfirmDialog>
      ) : null}
      {whatsNew ? (
        <WhatsNewDialog
          version={whatsNew.version}
          notes={whatsNew.notes}
          onClose={dismissWhatsNew}
        />
      ) : null}
      <ConfirmDialog
        open={dropped !== null}
        title={dropped?.replace ? "Replace the canvas?" : "Import file"}
        confirmLabel={dropped?.replace ? "Replace" : "Import"}
        danger={dropped?.replace}
        onConfirm={() => dropped && void importDropped(dropped)}
        onClose={() => setDropped(null)}
      >
        {dropped?.replace
          ? `The canvas has content. Importing "${dropped?.name}" will discard it for you and the agent.`
          : `Import "${dropped?.name}" (${dropped?.kind === "mermaid" ? "Mermaid diagram" : "scene"}) onto the canvas?`}
      </ConfirmDialog>
    </div>
  );
}
