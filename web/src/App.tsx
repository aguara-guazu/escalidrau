import { useCallback, useRef } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { SyncClient } from "./sync";

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
      />
    </div>
  );
}
