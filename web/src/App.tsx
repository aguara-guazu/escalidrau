import { useCallback, useRef, useState } from "react";
import { Excalidraw, MainMenu, WelcomeScreen, useHandleLibrary } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, LibraryItems } from "@excalidraw/excalidraw/types";
import { SyncClient } from "./sync";
import { MermaidDialog } from "./MermaidDialog";
import { ConfirmResetDialog } from "./ConfirmResetDialog";
import { copyIcon, importIcon, trashIcon } from "./icons";
import "./debrand.css";

export default function App() {
  const syncRef = useRef<SyncClient | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawImperativeAPI | null>(null);
  const [mermaidOpen, setMermaidOpen] = useState(false);
  const [mermaidBusy, setMermaidBusy] = useState(false);
  const [mermaidError, setMermaidError] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
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

  return (
    <div style={{ height: "100%", width: "100%" }}>
      <Excalidraw
        excalidrawAPI={handleApi}
        onChange={() => syncRef.current?.onLocalChange()}
        initialData={initialData}
        onLibraryChange={persistLibrary}
        libraryReturnUrl={window.location.origin}
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
      <ConfirmResetDialog
        open={resetOpen}
        onConfirm={() => {
          syncRef.current?.resetCanvas();
          setResetOpen(false);
          apiRef.current?.setToast({ message: "Canvas cleared", duration: 2000 });
        }}
        onClose={() => setResetOpen(false)}
      />
    </div>
  );
}
