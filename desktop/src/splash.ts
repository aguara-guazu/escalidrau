import { BrowserWindow } from "electron";

const HTML = `<!doctype html>
<meta charset="utf-8">
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    font-family: -apple-system, system-ui, sans-serif;
    background: linear-gradient(160deg, #7b6ff0, #5b50c8);
    color: #fff;
    user-select: none;
    -webkit-app-region: drag;
  }
  h1 { margin: 0; font-size: 19px; letter-spacing: 0.2px; }
  #status { font-size: 13px; opacity: 0.9; min-height: 18px; }
  #track {
    width: 260px;
    height: 6px;
    border-radius: 99px;
    background: rgba(255, 255, 255, 0.25);
    overflow: hidden;
  }
  #bar {
    height: 100%;
    width: 0%;
    border-radius: 99px;
    background: #fff;
    transition: width 0.2s ease;
  }
  #bar.indeterminate {
    width: 35%;
    animation: slide 1.1s ease-in-out infinite alternate;
  }
  @keyframes slide { from { margin-left: -35%; } to { margin-left: 100%; } }
  #skip {
    -webkit-app-region: no-drag;
    appearance: none;
    border: 1px solid rgba(255, 255, 255, 0.5);
    background: transparent;
    color: #fff;
    font: inherit;
    font-size: 12px;
    padding: 5px 12px;
    border-radius: 8px;
    cursor: pointer;
    visibility: hidden;
  }
  #glyph { display: flex; align-items: center; gap: 10px; }
  #glyph span { width: 26px; height: 18px; border: 2.5px solid #fff; border-radius: 4px; }
  #glyph i { width: 26px; height: 18px; border: 2.5px solid #fff; border-radius: 50%; }
  #glyph b { font-size: 18px; }
</style>
<div id="glyph"><span></span><b>&rarr;</b><i></i></div>
<h1>Escalidrau</h1>
<div id="status">Starting…</div>
<div id="track"><div id="bar" class="indeterminate"></div></div>
<button id="skip" onclick="location.hash = 'skip'">Continue without updating</button>
`;

export class Splash {
  private window: BrowserWindow | null = null;
  onSkip: () => void = () => {};

  show() {
    const window = new BrowserWindow({
      width: 380,
      height: 260,
      frame: false,
      resizable: false,
      movable: true,
      show: false,
      backgroundColor: "#6a5fdc",
      webPreferences: { contextIsolation: true }
    });
    this.window = window;
    // The renderer signals "skip" through the hash so no IPC bridge is needed.
    window.webContents.on("did-navigate-in-page", (_event, url) => {
      if (url.endsWith("#skip")) {
        this.onSkip();
      }
    });
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`);
    window.once("ready-to-show", () => window.show());
  }

  status(text: string, fraction?: number) {
    const script =
      fraction === undefined
        ? `document.getElementById("status").textContent = ${JSON.stringify(text)};
           document.getElementById("bar").className = "indeterminate";`
        : `document.getElementById("status").textContent = ${JSON.stringify(text)};
           const bar = document.getElementById("bar");
           bar.className = "";
           bar.style.width = "${Math.round(fraction * 100)}%";`;
    void this.window?.webContents.executeJavaScript(script).catch(() => undefined);
  }

  allowSkip() {
    void this.window?.webContents
      .executeJavaScript(`document.getElementById("skip").style.visibility = "visible";`)
      .catch(() => undefined);
  }

  close() {
    this.window?.destroy();
    this.window = null;
  }
}
