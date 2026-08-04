import { join } from "node:path";
import { Menu, app, clipboard, dialog } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import {
  addClaudeCodeHook,
  addToClaudeCode,
  addToClaudeDesktop,
  addToCodex,
  claudeCodeHookStatus,
  claudeCodeStatus,
  claudeDesktopStatus,
  codexStatus,
  type BridgeConfig,
  type ClientStatus
} from "./installers.js";

type ClientDefinition = {
  name: string;
  status: (mcpUrl: string) => Promise<ClientStatus>;
  add: (mcpUrl: string) => Promise<void>;
  addLabel?: string;
  postInstallNote?: string;
};

const bundledScript = (name: string) =>
  app.isPackaged
    ? join(process.resourcesPath, name)
    : join(app.getAppPath(), "dist", name);

// Stdio-only clients spawn the app's own binary in Node mode running the
// bundled relay, so the integration works without Node installed.
const bridgeConfig = (mcpUrl: string): BridgeConfig => ({
  command: process.execPath,
  args: [bundledScript("bridge.cjs"), mcpUrl],
  env: { ELECTRON_RUN_AS_NODE: "1" }
});

const hookConfig = (): BridgeConfig => ({
  command: process.execPath,
  args: [bundledScript("canvas-hook.cjs")],
  env: { ELECTRON_RUN_AS_NODE: "1" }
});

const CLIENTS: ClientDefinition[] = [
  {
    name: "Claude Code",
    status: claudeCodeStatus,
    add: addToClaudeCode
  },
  {
    name: "Claude Desktop",
    status: claudeDesktopStatus,
    add: (mcpUrl) => addToClaudeDesktop(bridgeConfig(mcpUrl)),
    postInstallNote: "Reiniciá Claude Desktop para que tome el conector."
  },
  {
    name: "Codex",
    status: codexStatus,
    add: (mcpUrl) => addToCodex(bridgeConfig(mcpUrl)),
    postInstallNote: "Las sesiones nuevas de Codex ya lo van a ver."
  },
  {
    name: "Hook de Claude Code",
    status: () => claudeCodeHookStatus(),
    add: () => addClaudeCodeHook(hookConfig()),
    addLabel: "Instalar hook de Claude Code (avisos de edición en cada prompt)…",
    postInstallNote:
      "En cada mensaje que escribas en Claude Code, el modelo va a recibir tus ediciones recientes del canvas."
  }
];

let rebuilding = false;

export async function rebuildMenu(mcpUrl: string) {
  if (rebuilding) {
    return;
  }
  rebuilding = true;
  try {
    const statuses = await Promise.all(
      CLIENTS.map(async (client) => {
        try {
          return await client.status(mcpUrl);
        } catch {
          return "missing" as ClientStatus;
        }
      })
    );

    const clientItem = (client: ClientDefinition, status: ClientStatus): MenuItemConstructorOptions => {
      if (status === "added") {
        return { label: `${client.name}: agregado ✓`, enabled: false };
      }
      if (status === "not-installed") {
        return { label: `${client.name}: no detectado en esta Mac`, enabled: false };
      }
      return {
        label: client.addLabel ?? `Agregar a ${client.name}…`,
        click: () => {
          void (async () => {
            try {
              await client.add(mcpUrl);
              await rebuildMenu(mcpUrl);
              await dialog.showMessageBox({
                type: "info",
                message: `Servidor MCP agregado a ${client.name}.`,
                detail: client.postInstallNote
              });
            } catch (error) {
              dialog.showErrorBox(
                `No se pudo agregar a ${client.name}`,
                error instanceof Error ? error.message : String(error)
              );
              await rebuildMenu(mcpUrl);
            }
          })();
        }
      };
    };

    const template: MenuItemConstructorOptions[] = [
      { role: "appMenu" },
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
      {
        label: "MCP",
        submenu: [
          { label: `Servidor: ${mcpUrl}`, enabled: false },
          {
            label: "Copiar URL del servidor MCP",
            click: () => clipboard.writeText(mcpUrl)
          },
          { type: "separator" },
          ...CLIENTS.map((client, index) => clientItem(client, statuses[index])),
          { type: "separator" },
          {
            label: "Volver a chequear",
            click: () => void rebuildMenu(mcpUrl)
          }
        ]
      }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  } finally {
    rebuilding = false;
  }
}
