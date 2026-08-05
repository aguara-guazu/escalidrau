import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type State = {
  lastSeenVersion?: string;
};

/** Small JSON blob in the app data directory for cross-launch bookkeeping. */
export class AppState {
  private path: string;
  private data: State = {};

  constructor(dataDir: string) {
    this.path = join(dataDir, "state.json");
  }

  async load() {
    if (!existsSync(this.path)) {
      return;
    }
    try {
      this.data = JSON.parse(await readFile(this.path, "utf8")) as State;
    } catch {
      this.data = {};
    }
  }

  get lastSeenVersion(): string | undefined {
    return this.data.lastSeenVersion;
  }

  async setLastSeenVersion(version: string) {
    this.data.lastSeenVersion = version;
    await writeFile(this.path, JSON.stringify(this.data), "utf8").catch(() => undefined);
  }
}
