export const CONNECTOR_PRESETS = ["sketch", "clean", "formal"] as const;
export const CONNECTOR_ROUTES = ["straight", "elbow", "curve"] as const;
export const FONTS = ["hand", "classic", "normal", "formal", "display", "code"] as const;

export type ConnectorPreset = (typeof CONNECTOR_PRESETS)[number];
export type ConnectorRoute = (typeof CONNECTOR_ROUTES)[number];
export type Font = (typeof FONTS)[number];

export type Settings = {
  connectors: { preset: ConnectorPreset; route: ConnectorRoute };
  text: { font: Font };
};

/** Flat view of the settings that the canvas client applies to what it draws. */
export type CanvasStyle = { preset: ConnectorPreset; route: ConnectorRoute; font: Font };

export const canvasStyle = (settings: Settings): CanvasStyle => ({
  preset: settings.connectors.preset,
  route: settings.connectors.route,
  font: settings.text.font
});

// Model-facing descriptions; the rendering parameters live in the web client
// (web/src/sync.ts) next to the code that applies them.
export const PRESET_DESCRIPTIONS: Record<ConnectorPreset, string> = {
  sketch: "Hand-drawn look (the editor's default): slightly wobbly strokes, medium weight, rounded corners and bends, hatched fills, open arrowheads. For whiteboarding and brainstorming.",
  clean: "Straight, even strokes of medium weight with rounded corners and bends, solid fills and open arrowheads. Tidy without looking like a CAD drawing.",
  formal: "Thin, perfectly straight strokes with sharp corners and bends, solid fills and filled triangular arrowheads. For documentation, proposals and presentations."
};

export const ROUTE_DESCRIPTIONS: Record<ConnectorRoute, string> = {
  straight: "One segment from edge to edge; horizontal or vertical when the items share a row or column.",
  elbow: "One right-angle bend: leaves the side facing the target, arrives from above or below it.",
  curve: "Smooth S-curve that leaves and arrives perpendicular to the edges; good for skipping rows or for feedback loops."
};

export const FONT_DESCRIPTIONS: Record<Font, string> = {
  hand: "Excalifont, the editor's hand-drawn default. Pairs with the sketch and clean strokes.",
  classic: "Virgil, the original hand-drawn whiteboard font. Slightly rounder than Excalifont.",
  normal: "Nunito, a friendly sans-serif. Neutral and easy to read at small sizes.",
  formal: "Helvetica/Arial (Liberation Sans in exports). The sober choice for documentation and proposals; pairs with the formal strokes.",
  display: "Lilita One, a bold display face. Titles and big callouts only.",
  code: "Comic Shanns, monospaced. Identifiers, paths, commands."
};

export const DEFAULT_SETTINGS: Settings = {
  connectors: { preset: "sketch", route: "straight" },
  text: { font: "hand" }
};

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

/** Coerces any stored or submitted value into a complete, valid settings object. */
export const normalizeSettings = (raw: unknown): Settings => {
  const input = (raw ?? {}) as { connectors?: Record<string, unknown>; text?: Record<string, unknown> };
  const connectors = input.connectors ?? {};
  const text = input.text ?? {};
  return {
    connectors: {
      preset: pick(connectors.preset, CONNECTOR_PRESETS, DEFAULT_SETTINGS.connectors.preset),
      route: pick(connectors.route, CONNECTOR_ROUTES, DEFAULT_SETTINGS.connectors.route)
    },
    text: { font: pick(text.font, FONTS, DEFAULT_SETTINGS.text.font) }
  };
};
