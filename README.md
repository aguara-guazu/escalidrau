# Escalidrau

A macOS desktop whiteboard where you and your local AI agent draw together, in real time, on the same canvas. The app embeds an MCP server: any compatible client (Claude Code, Claude Desktop, Codex, ...) can read the canvas, draw, rearrange diagrams and export images while you edit by hand.

## Install

macOS Apple Silicon (M1 or later). In a terminal:

```bash
curl -fL https://github.com/aguara-guazu/escalidrau/releases/latest/download/Escalidrau-arm64.dmg -o /tmp/Escalidrau.dmg && open /tmp/Escalidrau.dmg
```

Drag **Escalidrau** to Applications and open it. This command always fetches the latest release.

> If you download the DMG with a browser or receive it through chat instead, macOS will claim the app "is damaged" (the app is not notarized, and downloads get quarantined). Fix:
> ```bash
> xattr -dr com.apple.quarantine "/Applications/Escalidrau.app"
> ```

## Connect your agent

1. Open Escalidrau. The MCP server is available at `http://localhost:3580/mcp` while the app is running.
2. In the menu bar, open **MCP**:
   - **Add to Claude Code** — registers it with the Claude Code CLI (user scope).
   - **Add to Claude Desktop** — writes the connector into its configuration; restart Claude Desktop afterwards.
   - **Add to Codex** — adds it to `~/.codex/config.toml`.
   - **Install Claude Code hook** — with this, every message you send in Claude Code automatically informs it about your recent canvas edits.
   - **Copy MCP server URL** — to manually connect any other client that speaks MCP over HTTP.

The menu shows the status of each integration and refreshes on its own. Node is not required: the integrations run on the app's embedded runtime.

## Collaborate with other people (P2P)

Click the collaboration button (top right), pick a name and create a room: you get a code to share. Anyone with the code joins from their own Escalidrau — up to 10 people. You see each other's cursors live, labeled and color-coded, and the canvas stays in sync for everybody.

It is peer-to-peer over WebRTC: the drawing travels directly between participants and never touches a server of ours (a public relay is used only so peers can find each other). Consequences worth knowing:

- **Nothing is stored.** The room's content only exists in the participants' apps. Whoever wants to keep it must save it locally (menu → "Save to file"); the app also asks when you close it.
- **The room outlives its host.** Everyone replicates the scene, so if the host leaves, the remaining participants keep going and one of them becomes the new host.
- **Each participant keeps their own agent.** Your MCP agent sees the shared canvas, including what other people draw — so several humans and several agents can work on the same diagram.
- Some restrictive networks block direct connections; if a peer cannot connect, that is why.

## Usage

With an agent connected and the app open:

- **Ask it to draw**: "draw my API architecture on the canvas". Whatever it draws appears instantly in your window. If you installed icon packs from the library catalog (AWS services, for example), the agent can browse them and build diagrams with the real icons.
- **Edit anything by hand**: move, delete, change text. The agent learns about your changes (through the hook on each message, or instantly if it is listening with the `wait_for_user_changes` tool).
- **Ask it to rearrange**: "separate the overlapping diagrams", "lay everything out horizontally". The layout tools move each diagram as a whole (boxes, arrows and labels together).
- **Export**: "export the canvas as PNG to ~/Desktop/diagram.png", or use the app menu. You can also convert the diagram to **Mermaid** (menu → "Copy as Mermaid", or ask the agent) to paste it into markdown, and import Mermaid syntax onto the canvas (menu → "Import Mermaid…").

Exposed MCP tools: `get_scene`, `get_layout`, `get_library`, `view_library`, `add_library_item`, `add_elements`, `update_elements`, `move_elements`, `delete_elements`, `import_mermaid`, `export_mermaid`, `view_canvas`, `export_image`, `wait_for_user_changes`.

## Development

```bash
npm install
npm run dev    # web (vite, :3579) + server (:3580)
npm run app    # Electron app in dev mode
npm run dist   # builds the DMG into desktop/release/
```

## Known limitations

- The scene lives in memory: closing the app loses anything not exported (save with menu → "Save to file").
- Apple Silicon only, for now.
- One instance per machine (port 3580).

## License

MIT — see [LICENSE](LICENSE), which includes attribution for redistributed dependencies.
