import type { CSSProperties } from "react";

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6
};

const baseButtonStyle: CSSProperties = {
  height: 36,
  padding: "0 12px",
  borderRadius: 10,
  border: "none",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 600,
  fontFamily: "inherit",
  display: "flex",
  alignItems: "center",
  gap: 6,
  whiteSpace: "nowrap"
};

const startButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  background: "#6965db",
  color: "#fff"
};

const leaveButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  background: "#e03131",
  color: "#fff"
};

const codePillStyle: CSSProperties = {
  ...baseButtonStyle,
  background: "var(--island-bg-color, #fff)",
  color: "var(--text-primary-color, #1e1e1e)",
  border: "1px solid var(--default-border-color, #d0d0d0)",
  fontFamily: "monospace",
  fontWeight: 500
};

const dotStyle = (color: string): CSSProperties => ({
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: color,
  flexShrink: 0
});

type Props = {
  active: boolean;
  code: string | null;
  members: number;
  onStart: () => void;
  onShowRoom: () => void;
  onLeave: () => void;
};

export function JamButton({ active, code, members, onStart, onShowRoom, onLeave }: Props) {
  if (!active) {
    return (
      <button style={startButtonStyle} onClick={onStart} title="Draw together with other people">
        Start group jam
      </button>
    );
  }
  return (
    <div style={rowStyle}>
      <button
        style={codePillStyle}
        onClick={onShowRoom}
        title="Show the room code and who is connected"
      >
        <span style={dotStyle("#2f9e44")} />
        {code}
        {members > 1 ? ` · ${members}` : ""}
      </button>
      <button style={leaveButtonStyle} onClick={onLeave} title="Disconnect from this jam">
        Leave jam
      </button>
    </div>
  );
}
