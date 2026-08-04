import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Claude Code UserPromptSubmit hook. Whatever this prints on stdout is
 * injected into the model's context on every user prompt, so the agent
 * learns about canvas edits without an in-flight tool call. Keeps one change
 * cursor per Claude Code session (session_id arrives on stdin) so edits are
 * reported exactly once. Silent and fast-failing by design: a hook must
 * never delay or break the prompt.
 */
const PORT = process.env.EXCALIDRAW_LIVE_PORT ?? "3580";

const main = async () => {
  let sessionId = "global";
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as { session_id?: string };
    if (input.session_id) {
      sessionId = input.session_id;
    }
  } catch {
    // No stdin payload — keep the shared cursor.
  }
  const cursorPath = join(tmpdir(), `escalidrau-cursor-${sessionId}`);
  const hasBaseline = existsSync(cursorPath);
  const cursor = hasBaseline ? Number(readFileSync(cursorPath, "utf8")) || 0 : 0;

  let payload: { seq: number; summaries: string[] };
  try {
    const response = await fetch(`http://localhost:${PORT}/changes?since=${cursor}`, {
      signal: AbortSignal.timeout(1500)
    });
    payload = (await response.json()) as { seq: number; summaries: string[] };
  } catch {
    return;
  }
  writeFileSync(cursorPath, String(payload.seq), "utf8");
  if (!hasBaseline) {
    return;
  }
  if (payload.summaries.length > 0) {
    console.log(
      `[Escalidrau] The user edited the shared canvas since your last look: ${payload.summaries.join("; ")}. Use get_scene / get_layout for details.`
    );
  }
};

void main();
