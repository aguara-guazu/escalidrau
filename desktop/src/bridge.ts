import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * Minimal stdio <-> streamable HTTP relay so MCP clients that only spawn
 * stdio servers (Claude Desktop, Codex) can reach the app's local endpoint.
 * Runs on the Electron binary via ELECTRON_RUN_AS_NODE, so end users need no
 * Node installation. Messages pass through verbatim; the HTTP client
 * transport manages the mcp-session-id header.
 */
const url = process.argv[2];
if (!url) {
  console.error("usage: bridge.cjs <mcp-url>");
  process.exit(2);
}

const stdio = new StdioServerTransport();
const http = new StreamableHTTPClientTransport(new URL(url));

stdio.onmessage = (message: JSONRPCMessage) => {
  http.send(message).catch((error: Error) => {
    console.error(`[bridge] cannot reach ${url}: ${error.message}`);
    const id = (message as { id?: number | string }).id;
    if (id !== undefined) {
      void stdio.send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32001,
          message:
            "Escalidrau is not reachable. Open the desktop app (it serves the MCP endpoint) and retry."
        }
      });
    }
  });
};
http.onmessage = (message: JSONRPCMessage) => {
  stdio.send(message).catch((error: Error) => {
    console.error(`[bridge] failed to write to stdout: ${error.message}`);
  });
};
stdio.onclose = () => {
  void http.close().finally(() => process.exit(0));
};
http.onclose = () => {
  void stdio.close().finally(() => process.exit(0));
};
stdio.onerror = (error: Error) => console.error(`[bridge] stdio error: ${error.message}`);
http.onerror = (error: Error) => console.error(`[bridge] http error: ${error.message}`);

void (async () => {
  await http.start();
  await stdio.start();
})();
