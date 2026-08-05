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
  width: 400,
  maxWidth: "90vw",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  boxShadow: "0 8px 30px rgba(0, 0, 0, 0.25)"
};

const buttonStyle: CSSProperties = {
  padding: "8px 16px",
  borderRadius: 8,
  border: "1px solid var(--default-border-color, #d0d0d0)",
  background: "transparent",
  color: "inherit",
  cursor: "pointer"
};

const dangerButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "#e03131",
  borderColor: "#e03131",
  color: "#fff"
};

type Props = {
  open: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

export function ConfirmResetDialog({ open, onConfirm, onClose }: Props) {
  if (!open) {
    return null;
  }
  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={cardStyle} onClick={(event) => event.stopPropagation()}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Reset the canvas</h2>
        <p style={{ margin: 0, fontSize: 14 }}>
          This clears the whole canvas for you and the agent. It cannot be undone.
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button style={buttonStyle} onClick={onClose}>
            Cancel
          </button>
          <button style={dangerButtonStyle} onClick={onConfirm}>
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}
