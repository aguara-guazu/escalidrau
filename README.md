# Escalidrau

Pizarra de escritorio para macOS donde vos y tu agente de IA local dibujan juntos, en tiempo real, sobre el mismo canvas. La app embebe un servidor MCP: cualquier cliente compatible (Claude Code, Claude Desktop, Codex, etc.) puede leer el canvas, dibujar, reacomodar diagramas y exportar imágenes mientras vos editás a mano.

## Instalación

macOS Apple Silicon (M1 o superior). En una terminal:

```bash
curl -fL https://github.com/aguara-guazu/escalidrau/releases/latest/download/Escalidrau-arm64.dmg -o /tmp/Escalidrau.dmg && open /tmp/Escalidrau.dmg
```

Arrastrá **Escalidrau** a Aplicaciones y abrila. Este comando siempre baja la última versión.

> Si en cambio descargás el DMG con el navegador o lo recibís por chat, macOS va a decir que la app "está dañada" (la app no está notarizada y la descarga queda en cuarentena). Solución:
> ```bash
> xattr -dr com.apple.quarantine "/Applications/Escalidrau.app"
> ```

## Conectar tu agente

1. Abrí Escalidrau. El servidor MCP queda disponible en `http://localhost:3580/mcp` mientras la app esté abierta.
2. En la barra de menú, entrá a **MCP**:
   - **Agregar a Claude Code** — lo registra con la CLI de Claude Code (scope usuario).
   - **Agregar a Claude Desktop** — escribe el conector en su configuración; reiniciá Claude Desktop después.
   - **Agregar a Codex** — lo suma a `~/.codex/config.toml`.
   - **Instalar hook de Claude Code** — con esto, cada mensaje que le escribas a Claude Code le informa automáticamente tus ediciones recientes del canvas.
   - **Copiar URL del servidor MCP** — para conectar a mano cualquier otro cliente que soporte MCP por HTTP.

El menú muestra el estado de cada integración y se actualiza solo. No hace falta tener Node instalado: las integraciones usan el runtime embebido de la app.

## Uso

Con el agente conectado y la app abierta:

- **Pedile que dibuje**: "dibujame la arquitectura de mi API en el canvas". Lo que dibuja aparece al instante en tu ventana.
- **Editá a mano lo que quieras**: mover, borrar, cambiar textos. El agente se entera de tus cambios (por el hook en cada mensaje, o al instante si está usando la herramienta de escucha `wait_for_user_changes`).
- **Pedile que reacomode**: "separá los diagramas que se pisan", "alineá todo horizontal". Las herramientas de layout mueven cada diagrama completo (cajas, flechas y textos juntos).
- **Exportá**: "exportame el canvas como PNG en ~/Desktop/diagrama.png", o usá el menú de la app.

Herramientas MCP expuestas: `get_scene`, `get_layout`, `add_elements`, `update_elements`, `move_elements`, `delete_elements`, `export_image`, `wait_for_user_changes`.

## Desarrollo

```bash
npm install
npm run dev    # web (vite, :3579) + servidor (:3580)
npm run app    # app Electron en modo dev
npm run dist   # genera el DMG en desktop/release/
```

## Limitaciones conocidas

- La escena vive en memoria: si cerrás la app se pierde lo no exportado (guardá con el menú → "Guardar en archivo").
- Solo Apple Silicon por ahora.
- Una sola instancia por máquina (puerto 3580).

## Licencia

MIT — ver [LICENSE](LICENSE), que incluye la atribución de las dependencias redistribuidas.
