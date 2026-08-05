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
      <div className="esc-ui">
        <button
          className="esc-btn esc-btn--top esc-btn--primary"
          onClick={onStart}
          title="Draw together with other people"
        >
          Start group jam
        </button>
      </div>
    );
  }
  return (
    <div className="esc-ui esc-row">
      <button
        className="esc-btn esc-btn--pill"
        onClick={onShowRoom}
        title="Show the room code and who is connected"
      >
        <span className="esc-dot esc-dot--live" />
        {code}
        {members > 1 ? ` · ${members}` : ""}
      </button>
      <button
        className="esc-btn esc-btn--top esc-btn--danger"
        onClick={onLeave}
        title="Disconnect from this jam"
      >
        Leave jam
      </button>
    </div>
  );
}
