import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ClientStatus = "added" | "missing" | "not-installed";

/**
 * How stdio-only clients reach the local HTTP endpoint: they spawn the app's
 * own Electron binary in Node mode running the bundled bridge script, so end
 * users need no Node/npx installed.
 */
export type BridgeConfig = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

const CLI_TIMEOUT_MS = 30_000;
const isWindows = process.platform === "win32";

// Runs through a login shell so the user's PATH (nvm, homebrew, ...) applies;
// GUI apps inherit a minimal PATH otherwise. Windows has no login shell, so
// the command goes through cmd.exe.
const loginShell = (command: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const [file, args] = isWindows
      ? ["cmd.exe", ["/c", command]]
      : ["/bin/sh", ["-lc", command]];
    execFile(file, args as string[], { timeout: CLI_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });

const claudeCodeConfigPath = (home: string) => join(home, ".claude.json");

// Claude Desktop keeps its config in the platform's app-data directory.
const claudeDesktopDir = (home: string) => {
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Claude");
  }
  if (isWindows) {
    return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "Claude");
};
const claudeDesktopConfigPath = (home: string) =>
  join(claudeDesktopDir(home), "claude_desktop_config.json");
const codexConfigPath = (home: string) => join(home, ".codex", "config.toml");

export async function claudeCodeStatus(mcpUrl: string, home = homedir()): Promise<ClientStatus> {
  const configPath = claudeCodeConfigPath(home);
  if (!existsSync(configPath)) {
    return "not-installed";
  }
  try {
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    return JSON.stringify(config.mcpServers ?? {}).includes(mcpUrl) ? "added" : "missing";
  } catch {
    return "missing";
  }
}

export async function addToClaudeCode(mcpUrl: string): Promise<void> {
  await loginShell(
    `claude mcp add --transport http --scope user escalidrau ${JSON.stringify(mcpUrl)}`
  );
}

const claudeSettingsPath = (home: string) => join(home, ".claude", "settings.json");

export async function claudeCodeHookStatus(home = homedir()): Promise<ClientStatus> {
  if (!existsSync(join(home, ".claude"))) {
    return "not-installed";
  }
  const settingsPath = claudeSettingsPath(home);
  if (!existsSync(settingsPath)) {
    return "missing";
  }
  try {
    const content = await readFile(settingsPath, "utf8");
    return content.includes("canvas-hook.cjs") ? "added" : "missing";
  } catch {
    return "missing";
  }
}

/**
 * Registers a UserPromptSubmit hook in Claude Code's user settings: on every
 * user prompt it queries GET /changes and prints unseen canvas edits, which
 * Claude Code injects into the model context — live awareness without an
 * in-flight tool call.
 */
export async function addClaudeCodeHook(bridge: BridgeConfig, home = homedir()): Promise<void> {
  const settingsPath = claudeSettingsPath(home);
  let settings: {
    hooks?: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
  } = {};
  if (existsSync(settingsPath)) {
    settings = JSON.parse(await readFile(settingsPath, "utf8"));
  }
  const envPrefix = Object.entries(bridge.env)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  const command = `${envPrefix} ${JSON.stringify(bridge.command)} ${bridge.args
    .map((arg) => JSON.stringify(arg))
    .join(" ")}`;
  settings.hooks = settings.hooks ?? {};
  const entries = (settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit ?? []);
  entries.push({ hooks: [{ type: "command", command, timeout: 10 }] });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export async function claudeDesktopStatus(mcpUrl: string, home = homedir()): Promise<ClientStatus> {
  const configPath = claudeDesktopConfigPath(home);
  if (!existsSync(dirname(configPath))) {
    return "not-installed";
  }
  if (!existsSync(configPath)) {
    return "missing";
  }
  try {
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    return JSON.stringify(config.mcpServers ?? {}).includes(mcpUrl) ? "added" : "missing";
  } catch {
    return "missing";
  }
}

export async function addToClaudeDesktop(bridge: BridgeConfig, home = homedir()): Promise<void> {
  const configPath = claudeDesktopConfigPath(home);
  let config: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(configPath)) {
    config = JSON.parse(await readFile(configPath, "utf8"));
  }
  await mkdir(dirname(configPath), { recursive: true }).catch(() => undefined);
  config.mcpServers = {
    ...config.mcpServers,
    // Claude Desktop only spawns stdio servers from this file; the embedded
    // bridge relays stdio to the local streamable HTTP endpoint.
    "escalidrau": {
      command: bridge.command,
      args: bridge.args,
      env: bridge.env
    }
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function codexStatus(mcpUrl: string, home = homedir()): Promise<ClientStatus> {
  if (!existsSync(join(home, ".codex"))) {
    return "not-installed";
  }
  const configPath = codexConfigPath(home);
  if (!existsSync(configPath)) {
    return "missing";
  }
  const content = await readFile(configPath, "utf8");
  return content.includes(mcpUrl) ? "added" : "missing";
}

export async function addToCodex(bridge: BridgeConfig, home = homedir()): Promise<void> {
  const configPath = codexConfigPath(home);
  await mkdir(dirname(configPath), { recursive: true }).catch(() => undefined);
  const existing = existsSync(configPath) ? await readFile(configPath, "utf8") : "";
  // JSON string escaping matches TOML basic strings for paths and URLs.
  const envEntries = Object.entries(bridge.env)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join("\n");
  const block = [
    "",
    "[mcp_servers.escalidrau]",
    `command = ${JSON.stringify(bridge.command)}`,
    `args = [${bridge.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
    "",
    "[mcp_servers.escalidrau.env]",
    envEntries,
    ""
  ].join("\n");
  await writeFile(configPath, existing.replace(/\n*$/, "\n") + block, "utf8");
}
