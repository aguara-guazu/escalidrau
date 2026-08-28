import { useEffect, useRef, useState } from "react";
import { convertToExcalidrawElements, exportToBlob } from "@excalidraw/excalidraw";
import {
  DEFAULT_CANVAS_STYLE,
  FONT_FAMILIES,
  PRESET_PROPS,
  type CanvasStyle,
  type ConnectorPreset,
  type ConnectorRoute,
  type Font
} from "./sync";

const PRESETS: Array<{ id: ConnectorPreset; title: string; hint: string }> = [
  { id: "sketch", title: "Sketch", hint: "Hand-drawn strokes, hatched fills. Whiteboarding." },
  { id: "clean", title: "Clean", hint: "Straight strokes, rounded corners, solid fills. Tidy but relaxed." },
  { id: "formal", title: "Formal", hint: "Thin straight strokes, sharp corners, solid fills, filled heads. Documents." }
];

const ROUTES: Array<{ id: ConnectorRoute; title: string; hint: string }> = [
  { id: "straight", title: "Straight", hint: "Edge to edge in one segment." },
  { id: "elbow", title: "Right angles", hint: "One bend for items that are not aligned." },
  { id: "curve", title: "Curved", hint: "Smooth S-curve between the items." }
];

const FONT_CHOICES: Array<{ id: Font; title: string; hint: string }> = [
  { id: "hand", title: "Hand-drawn", hint: "Excalifont, the default." },
  { id: "classic", title: "Classic", hint: "Virgil, the original whiteboard font." },
  { id: "normal", title: "Normal", hint: "Nunito, a friendly sans-serif." },
  { id: "formal", title: "Formal", hint: "Helvetica / Arial. Documents and proposals." },
  { id: "display", title: "Display", hint: "Lilita One, bold. Titles and callouts." },
  { id: "code", title: "Code", hint: "Comic Shanns, monospaced." }
];

// Sample paths (relative points) drawn at the current preset for the previews.
const ROUTE_SAMPLES: Record<ConnectorRoute, number[][]> = {
  straight: [
    [0, 0],
    [120, 0]
  ],
  elbow: [
    [0, 0],
    [60, 0],
    [60, 40],
    [120, 40]
  ],
  curve: [
    [0, 0],
    [60, 0],
    [60, 40],
    [120, 40]
  ]
};

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

// Previews go through the canvas exporter, which loads the fonts it needs, so
// text samples show the real face rather than a fallback.
function Preview({ skeletons }: { skeletons: Record<string, unknown>[] }) {
  const [src, setSrc] = useState<string | null>(null);
  const key = JSON.stringify(skeletons);
  useEffect(() => {
    let cancelled = false;
    const render = () =>
      exportToBlob({
        // Measured with whatever fonts are loaded at this moment.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        elements: convertToExcalidrawElements(skeletons as any),
        appState: { exportBackground: false },
        files: null,
        mimeType: "image/png",
        exportPadding: 8,
        getDimensions: (width: number, height: number) => ({ width: width * 2, height: height * 2, scale: 2 })
      });
    // Two passes: the first export loads the faces the sample needs, the
    // second measures the text with them so nothing is clipped.
    void render()
      .then(() => render())
      .then(blobToDataUrl)
      .then((url: string) => {
        if (!cancelled) {
          setSrc(url);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return <div className="esc-style__preview">{src ? <img src={src} alt="" /> : null}</div>;
}

const connectorSample = (preset: ConnectorPreset, route: ConnectorRoute) => {
  const props = PRESET_PROPS[preset];
  const points = ROUTE_SAMPLES[route];
  const bends = points.length - 2;
  return [
    {
      type: "arrow",
      x: 0,
      y: 0,
      points,
      roughness: props.roughness,
      strokeWidth: props.strokeWidth,
      roundness: route === "curve" || (bends > 0 && props.round) ? { type: 2 } : null,
      endArrowhead: props.arrowhead
    }
  ];
};

// A shape next to an arrow, so corners, fill and stroke read at a glance.
const strokeSample = (preset: ConnectorPreset) => {
  const props = PRESET_PROPS[preset];
  return [
    {
      type: "rectangle",
      x: 0,
      y: 0,
      width: 56,
      height: 40,
      roughness: props.roughness,
      strokeWidth: props.strokeWidth,
      roundness: props.round ? { type: 3 } : null,
      fillStyle: props.fillStyle,
      backgroundColor: "#a5d8ff"
    },
    {
      type: "arrow",
      x: 64,
      y: 20,
      points: [
        [0, 0],
        [36, 0],
        [36, 20],
        [72, 20]
      ],
      roughness: props.roughness,
      strokeWidth: props.strokeWidth,
      roundness: props.round ? { type: 2 } : null,
      endArrowhead: props.arrowhead
    }
  ];
};

const fontSample = (font: Font) => [
  { type: "text", x: 0, y: 0, text: "Orders API", fontSize: 20, fontFamily: FONT_FAMILIES[font] }
];

type ChoiceProps<T extends string> = {
  options: Array<{ id: T; title: string; hint: string }>;
  value: T;
  onChange: (id: T) => void;
  preview: (id: T) => Record<string, unknown>[];
  columns?: number;
};

function Choices<T extends string>({ options, value, onChange, preview, columns = 3 }: ChoiceProps<T>) {
  return (
    <div className="esc-style__choices" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`esc-style__choice${value === option.id ? " esc-style__choice--selected" : ""}`}
          onClick={() => onChange(option.id)}
          aria-pressed={value === option.id}
        >
          <Preview skeletons={preview(option.id)} />
          <span className="esc-style__title">{option.title}</span>
          <span className="esc-style__hint">{option.hint}</span>
        </button>
      ))}
    </div>
  );
}

type Props = {
  open: boolean;
  onClose: () => void;
  /** Applies the style to the toolbar defaults and, if asked, to existing elements; returns how many were restyled. */
  onApply: (style: CanvasStyle, applyToExisting: boolean) => number;
  onSaved: (style: CanvasStyle, restyled: number) => void;
};

/**
 * Canvas-wide style: stroke preset and default route for connectors and the
 * font for text, shared with the agent (persisted server-side so the MCP
 * tools read the same values), with an option to restyle what is drawn.
 */
export function StyleDialog({ open, onClose, onApply, onSaved }: Props) {
  const [style, setStyle] = useState<CanvasStyle>(DEFAULT_CANVAS_STYLE);
  const [applyExisting, setApplyExisting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initial = useRef<CanvasStyle>(DEFAULT_CANVAS_STYLE);

  useEffect(() => {
    if (!open) {
      return;
    }
    setError(null);
    void fetch("/settings")
      .then((response) => (response.ok ? response.json() : null))
      .then((settings) => {
        if (settings?.connectors && settings?.text) {
          const loaded: CanvasStyle = {
            preset: settings.connectors.preset,
            route: settings.connectors.route,
            font: settings.text.font
          };
          initial.current = loaded;
          setStyle(loaded);
        }
      })
      .catch(() => undefined);
  }, [open]);

  if (!open) {
    return null;
  }

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectors: { preset: style.preset, route: style.route },
          text: { font: style.font }
        })
      });
      if (!response.ok) {
        throw new Error(`Could not save the style (${response.status})`);
      }
      const restyled = onApply(style, applyExisting);
      onSaved(style, restyled);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="esc-ui esc-overlay" onClick={onClose}>
      <div className="esc-card esc-card--wide esc-card--tall" onClick={(event) => event.stopPropagation()}>
        <h2 className="esc-title">Canvas style</h2>
        <p className="esc-text">
          How shapes, arrows, lines and text come out — what your agent draws and the defaults for
          what you draw and type. Library icons keep their own look. Any single element can still be
          restyled from its properties panel; one style per canvas keeps a diagram consistent.
        </p>
        <div className="esc-label">
          Stroke
          <Choices
            options={PRESETS}
            value={style.preset}
            onChange={(preset) => setStyle((current) => ({ ...current, preset }))}
            preview={strokeSample}
          />
        </div>
        <div className="esc-label">
          Default route
          <Choices
            options={ROUTES}
            value={style.route}
            onChange={(route) => setStyle((current) => ({ ...current, route }))}
            preview={(route) => connectorSample(style.preset, route)}
          />
        </div>
        <div className="esc-label">
          Font
          <Choices options={FONT_CHOICES} value={style.font} onChange={(font) => setStyle((current) => ({ ...current, font }))} preview={fontSample} />
        </div>
        <label className="esc-check">
          <input
            type="checkbox"
            checked={applyExisting}
            onChange={(event) => setApplyExisting(event.target.checked)}
          />
          Also restyle the shapes, arrows, lines and text already on the canvas
        </label>
        {error ? <p className="esc-error">{error}</p> : null}
        <div className="esc-actions">
          <button className="esc-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="esc-btn esc-btn--primary" onClick={() => void save()} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
