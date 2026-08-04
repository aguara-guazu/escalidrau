import { useCallback, useRef } from "react";
import { Excalidraw, MainMenu, WelcomeScreen } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { SyncClient } from "./sync";
import "./debrand.css";

export default function App() {
  const syncRef = useRef<SyncClient | null>(null);

  const handleApi = useCallback((api: ExcalidrawImperativeAPI) => {
    if (!syncRef.current) {
      syncRef.current = new SyncClient(api);
    }
  }, []);

  return (
    <div style={{ height: "100%", width: "100%" }}>
      <Excalidraw
        excalidrawAPI={handleApi}
        onChange={() => syncRef.current?.onLocalChange()}
      >
        <MainMenu>
          <MainMenu.DefaultItems.LoadScene />
          <MainMenu.DefaultItems.SaveToActiveFile />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
        <WelcomeScreen>
          <WelcomeScreen.Center>
            <WelcomeScreen.Center.Heading>
              Escalidrau — canvas compartido con tu agente
            </WelcomeScreen.Center.Heading>
            <WelcomeScreen.Center.Menu>
              <WelcomeScreen.Center.MenuItemLoadScene />
            </WelcomeScreen.Center.Menu>
          </WelcomeScreen.Center>
          <WelcomeScreen.Hints.ToolbarHint />
        </WelcomeScreen>
      </Excalidraw>
    </div>
  );
}
