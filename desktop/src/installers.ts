import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import SKILL_MARKDOWN from "../../skills/escalidrau/SKILL.md";

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

export async function addToClaudeCode(mcpUrl: string, skillSource: string): Promise<void> {
  await loginShell(
    `claude mcp add --transport http --scope user escalidrau ${JSON.stringify(mcpUrl)}`
  );
  await installClaudeCodeSkill(skillSource).catch(() => undefined);
}

/**
 * The "escalidrau" agent skill: how to lay out diagrams on the canvas. Each
 * client loads personal skills from a directory named after the skill (Agent
 * Skills standard), so the install is a symlink from that directory to a copy
 * the app keeps in its data directory and refreshes from the bundle on every
 * launch (stageSkill). Updating the app therefore updates the skill for every
 * session that reads it afterwards, on every platform: the data directory is
 * stable where the bundle is not (a Linux AppImage mounts at a random path)
 * and survives the app being moved. Windows gets a junction, which needs no
 * privileges; if a link cannot be created at all, SKILL.md is copied.
 */
const SKILL_NAME = "escalidrau";

/** Writes the bundled SKILL.md into `stageDir` when it differs; returns that directory. */
export async function stageSkill(stageDir: string): Promise<string> {
  await mkdir(stageDir, { recursive: true });
  const file = join(stageDir, "SKILL.md");
  const current = await readFile(file, "utf8").catch(() => null);
  if (current !== SKILL_MARKDOWN) {
    await writeFile(file, SKILL_MARKDOWN, "utf8");
  }
  return stageDir;
}
const claudeSkillDir = (home: string) => join(home, ".claude", "skills", SKILL_NAME);
// Codex documents ~/.agents/skills; earlier builds read ~/.codex/skills, which
// is kept in sync when it already exists.
const codexSkillDirs = (home: string) => [
  join(home, ".agents", "skills", SKILL_NAME),
  ...(existsSync(join(home, ".codex", "skills")) ? [join(home, ".codex", "skills", SKILL_NAME)] : [])
];


// Only a directory holding nothing but our SKILL.md is replaced by a symlink.
const isPlainCopy = (dir: string) => {
  try {
    const entries = readdirSync(dir);
    return entries.length === 1 && entries[0] === "SKILL.md";
  } catch {
    return false;
  }
};

const copySkillTo = async (target: string) => {
  await mkdir(target, { recursive: true });
  const file = join(target, "SKILL.md");
  const existing = await readFile(file, "utf8").catch(() => null);
  if (existing !== SKILL_MARKDOWN) {
    await writeFile(file, SKILL_MARKDOWN, "utf8");
  }
};

/** Installs (or refreshes) the skill at `target`: a link to `source`, or a copy if linking fails. */
const installSkillAt = async (source: string, target: string) => {
  await mkdir(dirname(target), { recursive: true });
  const current = await lstat(target).catch(() => null);
  if (current?.isSymbolicLink()) {
    if ((await readlink(target)) === source && existsSync(join(source, "SKILL.md"))) {
      return;
    }
    await unlink(target);
  } else if (current) {
    if (!isPlainCopy(target)) {
      return;
    }
    await rm(target, { recursive: true, force: true });
  }
  try {
    await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
  } catch {
    await copySkillTo(target);
  }
};

// "added" only when SKILL.md resolves (a symlink to a removed app counts as missing).
const skillStatus = async (dirs: string[], clientDir: string): Promise<ClientStatus> => {
  if (!existsSync(clientDir)) {
    return "not-installed";
  }
  return dirs.some((dir) => existsSync(join(dir, "SKILL.md"))) ? "added" : "missing";
};

export const claudeCodeSkillStatus = (home = homedir()) =>
  skillStatus([claudeSkillDir(home)], join(home, ".claude"));

export const installClaudeCodeSkill = (source: string, home = homedir()) =>
  installSkillAt(source, claudeSkillDir(home));

export const codexSkillStatus = (home = homedir()) =>
  skillStatus(codexSkillDirs(home), join(home, ".codex"));

export const installCodexSkill = async (source: string, home = homedir()) => {
  for (const dir of codexSkillDirs(home)) {
    await installSkillAt(source, dir);
  }
};

/** Re-points or rewrites every installed skill so it matches this build. */
export async function refreshInstalledSkills(source: string, home = homedir()): Promise<void> {
  for (const dir of [claudeSkillDir(home), ...codexSkillDirs(home)]) {
    const current = await lstat(dir).catch(() => null);
    if (current) {
      await installSkillAt(source, dir).catch(() => undefined);
    }
  }
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

export async function addToCodex(bridge: BridgeConfig, skillSource: string, home = homedir()): Promise<void> {
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
  await installCodexSkill(skillSource, home).catch(() => undefined);
}
