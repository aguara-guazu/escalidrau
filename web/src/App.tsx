import { useCallback, useEffect, useRef, useState } from "react";
import {
  Excalidraw,
  LiveCollaborationTrigger,
  MainMenu,
  WelcomeScreen,
  loadFromBlob,
  useHandleLibrary
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, LibraryItems } from "@excalidraw/excalidraw/types";
import { SyncClient } from "./sync";
import { CollabClient, type RoomInfo } from "./collab";
import { RoomDialog } from "./RoomDialog";
import { MermaidDialog } from "./MermaidDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { copyIcon, importIcon, trashIcon } from "./icons";
import "./debrand.css";

const MERMAID_KEYWORDS = /^\s*(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram)\b/;

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
  const [dropped, setDropped] = useState<DroppedFile | null>(null);
  const collabRef = useRef<CollabClient | null>(null);
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [roomOpen, setRoomOpen] = useState(false);
  const [roomError, setRoomError] = useState<string | null>(null);
  // Installed shape libraries live server-side (they must survive restarts).
  const [initialData] = useState(() => ({
    libraryItems: fetch("/library")
      .then((response) => (response.ok ? response.json() : []))
      .catch(() => []) as Promise<LibraryItems>
  }));

  // Handles the #addLibrary return from the public libraries site.
  useHandleLibrary({ excalidrawAPI });

  const handleApi = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
    setExcalidrawAPI(api);
    if (!syncRef.current) {
      syncRef.current = new SyncClient(api);
    }
    if (!collabRef.current) {
      const collab = new CollabClient(api);
      collab.onRoomChange = (info) => setRoomInfo(info);
      collab.onRoomFull = () => {
        setRoomError("That room is full (10 people max).");
        setRoomOpen(true);
      };
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

  const persistLibrary = useCallback((items: LibraryItems) => {
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

  return (
    <div style={{ height: "100%", width: "100%" }}>
      <Excalidraw
        excalidrawAPI={handleApi}
        onChange={() => syncRef.current?.onLocalChange()}
        initialData={initialData}
        onLibraryChange={persistLibrary}
        libraryReturnUrl={window.location.origin}
        isCollaborating={roomInfo !== null}
        onPointerUpdate={(payload) => collabRef.current?.handlePointer(payload)}
        renderTopRightUI={() => (
          <LiveCollaborationTrigger
            isCollaborating={roomInfo !== null}
            onSelect={() => {
              setRoomError(null);
              setRoomOpen(true);
            }}
          />
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
