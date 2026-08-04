import { useState } from "react";
import type { CSSProperties } from "react";

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.35)",
  zIndex: 20,
  display: "flex",
  alignItems: "center",
  justifyContent: "center"
};

const cardStyle: CSSProperties = {
  background: "var(--island-bg-color, #fff)",
  color: "var(--text-primary-color, #1e1e1e)",
  borderRadius: 12,
  padding: 20,
  width: 540,
  maxWidth: "90vw",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  boxShadow: "0 8px 30px rgba(0, 0, 0, 0.25)"
};

const textareaStyle: CSSProperties = {
  minHeight: 180,
  fontFamily: "monospace",
  fontSize: 13,
  padding: 10,
  borderRadius: 8,
  border: "1px solid var(--default-border-color, #d0d0d0)",
  background: "transparent",
  color: "inherit",
  resize: "vertical"
};

const buttonStyle: CSSProperties = {
  padding: "8px 16px",
  borderRadius: 8,
  border: "1px solid var(--default-border-color, #d0d0d0)",
  background: "transparent",
  color: "inherit",
  cursor: "pointer"
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "#6965db",
  borderColor: "#6965db",
  color: "#fff"
};

type Props = {
  open: boolean;
  busy: boolean;
  error: string | null;
  onImport: (definition: string) => void;
  onClose: () => void;
};

export function MermaidDialog({ open, busy, error, onImport, onClose }: Props) {
  const [definition, setDefinition] = useState("");
  if (!open) {
    return null;
  }
  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={cardStyle} onClick={(event) => event.stopPropagation()}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Import Mermaid</h2>
        <textarea
          autoFocus
          value={definition}
          onChange={(event) => setDefinition(event.target.value)}
          placeholder={"flowchart TD\n  a[Start] --> b[End]"}
          style={textareaStyle}
        />
        {error ? <div style={{ color: "#e03131", fontSize: 13 }}>{error}</div> : null}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button style={buttonStyle} onClick={onClose}>
            Cancel
          </button>
          <button
            style={primaryButtonStyle}
            disabled={busy || definition.trim() === ""}
            onClick={() => onImport(definition)}
          >
            {busy ? "Importing…" : "Insert"}
          </button>
        </div>
      </div>
    </div>
  );
}
