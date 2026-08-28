import { join } from "node:path";
import { Menu, app, clipboard, dialog } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import {
  addClaudeCodeHook,
  addToClaudeCode,
  addToClaudeDesktop,
  addToCodex,
  claudeCodeHookStatus,
  claudeCodeSkillStatus,
  claudeCodeStatus,
  claudeDesktopStatus,
  codexSkillStatus,
  codexStatus,
  installClaudeCodeSkill,
  installCodexSkill,
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

// Where installed skills link to: the copy the app stages in its data
// directory on every launch (see stageSkill in installers.ts). In development
// it is the repo's directory, so edits reach agents without a restart.
export const skillSource = () =>
  app.isPackaged
    ? join(app.getPath("userData"), "skills", "escalidrau")
    : join(app.getAppPath(), "..", "skills", "escalidrau");

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
    add: (mcpUrl) => addToClaudeCode(mcpUrl, skillSource()),
    postInstallNote: "New Claude Code sessions will pick it up; in a running one, type /mcp to reconnect."
  },
  {
    name: "Claude Desktop",
    status: claudeDesktopStatus,
    add: (mcpUrl) => addToClaudeDesktop(bridgeConfig(mcpUrl)),
    postInstallNote: "Restart Claude Desktop to load the connector."
  },
  {
    name: "Codex",
    status: codexStatus,
    add: (mcpUrl) => addToCodex(bridgeConfig(mcpUrl), skillSource()),
    postInstallNote: "New Codex sessions will pick it up."
  },
  {
    name: "Claude Code hook",
    status: () => claudeCodeHookStatus(),
    add: () => addClaudeCodeHook(hookConfig()),
    addLabel: "Install Claude Code hook (canvas updates on every prompt)…",
    postInstallNote:
      "Each message you send in Claude Code will now include your recent canvas edits."
  },
  {
    name: "Claude Code skill",
    status: () => claudeCodeSkillStatus(),
    add: () => installClaudeCodeSkill(skillSource()),
    addLabel: "Install the Escalidrau skill for Claude Code (how to draw well here)…",
    postInstallNote: "Installed as a link to the app's copy, so it follows every update. Claude Code picks it up in its current session."
  },
  {
    name: "Codex skill",
    status: () => codexSkillStatus(),
    add: () => installCodexSkill(skillSource()),
    addLabel: "Install the Escalidrau skill for Codex (how to draw well here)…",
    postInstallNote: "Installed as a link to the app's copy, so it follows every update. Restart Codex to load it."
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
        return { label: `${client.name}: added ✓`, enabled: false };
      }
      if (status === "not-installed") {
        return { label: `${client.name}: not detected on this Mac`, enabled: false };
      }
      return {
        label: client.addLabel ?? `Add to ${client.name}…`,
        click: () => {
          void (async () => {
            try {
              await client.add(mcpUrl);
              await rebuildMenu(mcpUrl);
              await dialog.showMessageBox({
                type: "info",
                message: `MCP server added to ${client.name}.`,
                detail: client.postInstallNote
              });
            } catch (error) {
              dialog.showErrorBox(
                `Could not add to ${client.name}`,
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
          { label: `Server: ${mcpUrl}`, enabled: false },
          {
            label: "Copy MCP server URL",
            click: () => clipboard.writeText(mcpUrl)
          },
          { type: "separator" },
          ...CLIENTS.map((client, index) => clientItem(client, statuses[index])),
          { type: "separator" },
          {
            label: "Re-check",
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
