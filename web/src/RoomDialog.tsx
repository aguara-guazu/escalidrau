import { useState } from "react";
import type { CSSProperties } from "react";
import { createRoomCode, type RoomInfo } from "./collab";

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
  width: 440,
  maxWidth: "90vw",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  boxShadow: "0 8px 30px rgba(0, 0, 0, 0.25)"
};

const inputStyle: CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--default-border-color, #d0d0d0)",
  background: "transparent",
  color: "inherit",
  fontSize: 14
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

const codeStyle: CSSProperties = {
  fontFamily: "monospace",
  fontSize: 24,
  letterSpacing: 2,
  textAlign: "center",
  padding: "10px 0",
  borderRadius: 8,
  border: "1px dashed var(--default-border-color, #d0d0d0)",
  userSelect: "all"
};

type Props = {
  open: boolean;
  info: RoomInfo | null;
  error: string | null;
  onCreate: (code: string, nick: string) => void;
  onJoin: (code: string, nick: string) => void;
  onLeave: () => void;
  onClose: () => void;
};

export function RoomDialog({ open, info, error, onCreate, onJoin, onLeave, onClose }: Props) {
  const [nick, setNick] = useState(() => localStorage.getItem("escalidrau-nick") ?? "");
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  if (!open) {
    return null;
  }

  const rememberNick = (value: string) => {
    localStorage.setItem("escalidrau-nick", value.trim());
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={cardStyle} onClick={(event) => event.stopPropagation()}>
        {info ? (
          <>
            <h2 style={{ margin: 0, fontSize: 16 }}>
              Room {info.isOwner ? "(you are the host)" : ""}
            </h2>
            <div style={codeStyle}>{info.code}</div>
            <button
              style={primaryButtonStyle}
              onClick={() => {
                void navigator.clipboard.writeText(info.code).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? "Copied!" : "Copy code"}
            </button>
            <div style={{ fontSize: 13, opacity: 0.75 }}>
              Share the code; up to 10 people. Nothing is stored anywhere — whoever wants to
              keep the result must save it locally.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {info.members.map((member) => (
                <div key={member.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
                  <span
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: "50%",
                      background: member.color.background,
                      border: `2px solid ${member.color.stroke}`
                    }}
                  />
                  {member.nick}
                  {member.isSelf ? " (you)" : ""}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={buttonStyle} onClick={onClose}>
                Close
              </button>
              <button
                style={{ ...buttonStyle, background: "#e03131", borderColor: "#e03131", color: "#fff" }}
                onClick={onLeave}
              >
                Leave room
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 style={{ margin: 0, fontSize: 16 }}>Collaborate live (P2P)</h2>
            <label style={{ fontSize: 13 }}>
              Your name
              <input
                style={{ ...inputStyle, width: "100%", marginTop: 4 }}
                value={nick}
                maxLength={24}
                placeholder="Ada"
                onChange={(event) => setNick(event.target.value)}
              />
            </label>
            <button
              style={primaryButtonStyle}
              disabled={nick.trim() === ""}
              onClick={() => {
                rememberNick(nick);
                onCreate(createRoomCode(), nick);
              }}
            >
              Create a room
            </button>
            <div style={{ textAlign: "center", fontSize: 12, opacity: 0.6 }}>— or join one —</div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                style={{ ...inputStyle, flex: 1, textTransform: "uppercase", fontFamily: "monospace" }}
                value={code}
                maxLength={9}
                placeholder="XXXX-XXXX"
                onChange={(event) => setCode(event.target.value.toUpperCase())}
              />
              <button
                style={buttonStyle}
                disabled={nick.trim() === "" || code.trim().length < 8}
                onClick={() => {
                  rememberNick(nick);
                  onJoin(code, nick);
                }}
              >
                Join
              </button>
            </div>
            {error ? <div style={{ color: "#e03131", fontSize: 13 }}>{error}</div> : null}
            <div style={{ fontSize: 12, opacity: 0.6 }}>
              Peer-to-peer via WebRTC: your canvas travels directly between participants, no
              central server. Both sides need internet access.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
