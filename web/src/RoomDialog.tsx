import { useState } from "react";
import { CURSOR_COLORS, createRoomCode, type RoomInfo } from "./collab";

type Props = {
  open: boolean;
  info: RoomInfo | null;
  error: string | null;
  colorChoice: number | null;
  onColorChoice: (index: number | null) => void;
  onCreate: (code: string, nick: string) => void;
  onJoin: (code: string, nick: string) => void;
  onLeave: () => void;
  onClose: () => void;
};

function ColorPicker({
  value,
  onChange
}: {
  value: number | null;
  onChange: (index: number | null) => void;
}) {
  return (
    <div className="esc-label">
      Your cursor colour
      <div className="esc-swatches">
        <button
          className={`esc-swatch esc-swatch--auto${value === null ? " esc-swatch--selected" : ""}`}
          onClick={() => onChange(null)}
          title="Pick one automatically"
        >
          Auto
        </button>
        {CURSOR_COLORS.map((color, index) => (
          <button
            key={color.background}
            className={`esc-swatch${value === index ? " esc-swatch--selected" : ""}`}
            style={{ background: color.background, borderColor: color.stroke }}
            onClick={() => onChange(index)}
            title="Use this colour"
          />
        ))}
      </div>
    </div>
  );
}

export function RoomDialog({
  open,
  info,
  error,
  colorChoice,
  onColorChoice,
  onCreate,
  onJoin,
  onLeave,
  onClose
}: Props) {
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
    <div className="esc-ui esc-overlay" onClick={onClose}>
      <div className="esc-card" onClick={(event) => event.stopPropagation()}>
        {info ? (
          <>
            <h2 className="esc-title">Jam {info.isOwner ? "(you are the host)" : ""}</h2>
            <div className="esc-code">{info.code}</div>
            <button
              className="esc-btn esc-btn--primary"
              onClick={() => {
                void navigator.clipboard.writeText(info.code).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? "Copied!" : "Copy code"}
            </button>
            <div className="esc-muted">
              Share the code; up to 10 people. Nothing is stored anywhere — whoever wants to keep
              the result must save it locally. If the host leaves, the jam keeps going with whoever
              is still connected.
            </div>
            <ColorPicker value={colorChoice} onChange={onColorChoice} />
            <div className="esc-list">
              {info.members.map((member) => (
                <div key={member.id} className="esc-member">
                  <span
                    className="esc-dot"
                    style={{
                      background: member.color.background,
                      border: `2px solid ${member.color.stroke}`
                    }}
                  />
                  {member.nick}
                  {member.isSelf ? " (you)" : ""}
                  {member.isHost ? " · host" : ""}
                </div>
              ))}
            </div>
            <div className="esc-actions">
              <button className="esc-btn" onClick={onClose}>
                Close
              </button>
              <button className="esc-btn esc-btn--danger" onClick={onLeave}>
                Leave jam
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="esc-title">Group jam (P2P)</h2>
            <label className="esc-label">
              Your name
              <input
                className="esc-input"
                value={nick}
                maxLength={24}
                placeholder="Ada"
                onChange={(event) => setNick(event.target.value)}
              />
            </label>
            <ColorPicker value={colorChoice} onChange={onColorChoice} />
            <button
              className="esc-btn esc-btn--primary"
              disabled={nick.trim() === ""}
              onClick={() => {
                rememberNick(nick);
                onCreate(createRoomCode(), nick);
              }}
            >
              Start the jam
            </button>
            <div className="esc-divider">— or join one —</div>
            <div className="esc-row">
              <input
                className="esc-input esc-input--code"
                style={{ flex: 1 }}
                value={code}
                maxLength={9}
                placeholder="XXXX-XXXX"
                onChange={(event) => setCode(event.target.value.toUpperCase())}
              />
              <button
                className="esc-btn"
                disabled={nick.trim() === "" || code.trim().length < 8}
                onClick={() => {
                  rememberNick(nick);
                  onJoin(code, nick);
                }}
              >
                Join
              </button>
            </div>
            {error ? <div className="esc-error">{error}</div> : null}
            <div className="esc-hint">
              Peer-to-peer over WebRTC: your canvas travels directly between participants, with no
              central server. Everyone needs internet access.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
