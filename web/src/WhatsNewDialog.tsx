import type { CSSProperties } from "react";

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.4)",
  zIndex: 25,
  display: "flex",
  alignItems: "center",
  justifyContent: "center"
};

const cardStyle: CSSProperties = {
  width: 520,
  maxWidth: "92vw",
  maxHeight: "80vh",
  borderRadius: 16,
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  background: "var(--island-bg-color, #fff)",
  color: "var(--text-primary-color, #1e1e1e)",
  boxShadow: "0 18px 50px rgba(0, 0, 0, 0.32)"
};

const headerStyle: CSSProperties = {
  background: "linear-gradient(140deg, #7b6ff0, #5b50c8)",
  color: "#fff",
  padding: "22px 24px",
  display: "flex",
  flexDirection: "column",
  gap: 4
};

const bodyStyle: CSSProperties = {
  padding: "18px 24px",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  fontSize: 14,
  lineHeight: 1.55
};

const footerStyle: CSSProperties = {
  padding: "14px 24px",
  display: "flex",
  justifyContent: "flex-end",
  borderTop: "1px solid var(--default-border-color, #e6e6e6)"
};

const buttonStyle: CSSProperties = {
  padding: "9px 20px",
  borderRadius: 10,
  border: "none",
  background: "#6965db",
  color: "#fff",
  fontSize: 14,
  fontWeight: 600,
  fontFamily: "inherit",
  cursor: "pointer"
};

const bulletRowStyle: CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "flex-start"
};

const dotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "#6965db",
  marginTop: 7,
  flexShrink: 0
};

// Release notes are plain text with occasional "- " bullets; render those as a
// list and leave everything else as paragraphs.
const renderNotes = (notes: string) => {
  const lines = notes
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    // Install instructions belong in the README, not in this modal.
    .filter((line) => !/^install:|releases\/latest\/download|^curl /i.test(line));
  if (lines.length === 0) {
    return <p style={{ margin: 0 }}>This version brings fixes and improvements.</p>;
  }
  return lines.map((line, index) =>
    line.startsWith("- ") || line.startsWith("* ") ? (
      <div key={index} style={bulletRowStyle}>
        <span style={dotStyle} />
        <span>{line.slice(2)}</span>
      </div>
    ) : (
      <p key={index} style={{ margin: 0 }}>
        {line}
      </p>
    )
  );
};

type Props = {
  version: string;
  notes: string;
  onClose: () => void;
};

export function WhatsNewDialog({ version, notes, onClose }: Props) {
  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={cardStyle} onClick={(event) => event.stopPropagation()}>
        <div style={headerStyle}>
          <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 1, opacity: 0.85 }}>
            Updated
          </div>
          <h2 style={{ margin: 0, fontSize: 22 }}>What's new in {version}</h2>
        </div>
        <div style={bodyStyle}>{renderNotes(notes)}</div>
        <div style={footerStyle}>
          <button style={buttonStyle} onClick={onClose}>
            Let's draw
          </button>
        </div>
      </div>
    </div>
  );
}
