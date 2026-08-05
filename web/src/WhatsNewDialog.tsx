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
    return <p className="esc-text">This version brings fixes and improvements.</p>;
  }
  return lines.map((line, index) =>
    line.startsWith("- ") || line.startsWith("* ") ? (
      <div key={index} className="esc-bullet">
        <span className="esc-bullet__dot" />
        <span>{line.slice(2)}</span>
      </div>
    ) : (
      <p key={index} className="esc-text">
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
    <div className="esc-ui esc-overlay esc-overlay--front" onClick={onClose}>
      <div
        className="esc-card esc-card--wide esc-card--flush"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="esc-hero">
          <div className="esc-hero__eyebrow">Updated</div>
          <h2 className="esc-title--hero">What's new in {version}</h2>
        </div>
        <div className="esc-body">{renderNotes(notes)}</div>
        <div className="esc-footer">
          <button className="esc-btn esc-btn--primary" onClick={onClose}>
            Let's draw
          </button>
        </div>
      </div>
    </div>
  );
}
