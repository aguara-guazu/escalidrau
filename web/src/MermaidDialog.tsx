import { useState } from "react";

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
    <div className="esc-ui esc-overlay" onClick={onClose}>
      <div className="esc-card esc-card--wide" onClick={(event) => event.stopPropagation()}>
        <h2 className="esc-title">Import Mermaid</h2>
        <textarea
          className="esc-textarea"
          autoFocus
          value={definition}
          onChange={(event) => setDefinition(event.target.value)}
          placeholder={"flowchart TD\n  a[Start] --> b[End]"}
        />
        {error ? <div className="esc-error">{error}</div> : null}
        <div className="esc-actions">
          <button className="esc-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="esc-btn esc-btn--primary"
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
