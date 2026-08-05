import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

const REPO = "aguara-guazu/escalidrau";
const ASSET_NAME = "Escalidrau-arm64.dmg";
const CHECK_TIMEOUT_MS = 6000;
const MIN_DMG_BYTES = 20 * 1024 * 1024;

export type ReleaseInfo = {
  version: string;
  notes: string;
  downloadUrl: string | null;
};

const parseVersion = (value: string): number[] =>
  value
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);

/** Positive when a is newer than b. */
export const compareVersions = (a: string, b: string): number => {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }
  return 0;
};

export async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
    });
    if (!response.ok) {
      return null;
    }
    const release = (await response.json()) as {
      tag_name?: string;
      body?: string;
      assets?: Array<{ name?: string; browser_download_url?: string }>;
    };
    if (!release.tag_name) {
      return null;
    }
    const asset = (release.assets ?? []).find((entry) => entry.name === ASSET_NAME);
    return {
      version: release.tag_name.replace(/^v/, ""),
      notes: release.body?.trim() ?? "",
      downloadUrl: asset?.browser_download_url ?? null
    };
  } catch {
    return null;
  }
}

export async function fetchReleaseNotes(version: string): Promise<string | null> {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/v${version}`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
    });
    if (!response.ok) {
      return null;
    }
    const release = (await response.json()) as { body?: string };
    return release.body?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Downloads over HTTPS from Node, which — unlike a browser download — does not
 * tag the file with com.apple.quarantine. That is what lets an unsigned,
 * un-notarized build update itself without tripping Gatekeeper.
 */
export async function downloadUpdate(
  url: string,
  onProgress: (fraction: number) => void,
  signal: AbortSignal
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "escalidrau-update-"));
  const target = join(directory, ASSET_NAME);
  const response = await fetch(url, { redirect: "follow", signal });
  if (!response.ok || !response.body) {
    throw new Error(`download failed with status ${response.status}`);
  }
  const total = Number(response.headers.get("content-length") ?? 0);
  let received = 0;
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (total > 0) {
      onProgress(Math.min(1, received / total));
    }
  });
  await pipeline(source, createWriteStream(target));
  const written = await stat(target);
  if (written.size < MIN_DMG_BYTES) {
    await rm(directory, { recursive: true, force: true });
    throw new Error("downloaded file is too small to be a build");
  }
  return target;
}

/**
 * Mounts the DMG, stages the new bundle next to the current one and swaps it in
 * one move, so a failed copy can never leave a half-written app behind.
 */
export async function installUpdate(
  dmgPath: string,
  bundlePath: string,
  expectedBundleId: string
): Promise<void> {
  const mountPoint = await mkdtemp(join(tmpdir(), "escalidrau-mount-"));
  try {
    await run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, dmgPath]);
    const { stdout } = await run("/bin/ls", [mountPoint]);
    const appName = stdout
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.endsWith(".app"));
    if (!appName) {
      throw new Error("no application bundle inside the disk image");
    }
    const source = join(mountPoint, appName);
    const plist = await readFile(join(source, "Contents", "Info.plist"), "utf8");
    if (!plist.includes(expectedBundleId)) {
      throw new Error("the disk image does not contain this application");
    }
    const staged = `${bundlePath}.incoming`;
    const backup = `${bundlePath}.previous`;
    await rm(staged, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
    await run("ditto", [source, staged]);
    await run("xattr", ["-dr", "com.apple.quarantine", staged]).catch(() => undefined);
    // Move the old bundle aside instead of deleting it, so a failed swap can be
    // rolled back rather than leaving no application at all.
    await run("/bin/mv", [bundlePath, backup]);
    try {
      await run("/bin/mv", [staged, bundlePath]);
    } catch (error) {
      await run("/bin/mv", [backup, bundlePath]).catch(() => undefined);
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
  } finally {
    await run("hdiutil", ["detach", mountPoint, "-force"]).catch(() => undefined);
    await rm(mountPoint, { recursive: true, force: true }).catch(() => undefined);
    await rm(join(dmgPath, ".."), { recursive: true, force: true }).catch(() => undefined);
  }
}
