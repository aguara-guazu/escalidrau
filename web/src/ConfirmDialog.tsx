import type { ReactNode } from "react";

type Props = {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger,
  onConfirm,
  onClose
}: Props) {
  if (!open) {
    return null;
  }
  return (
    <div className="esc-ui esc-overlay" onClick={onClose}>
      <div className="esc-card" onClick={(event) => event.stopPropagation()}>
        <h2 className="esc-title">{title}</h2>
        <p className="esc-text">{children}</p>
        <div className="esc-actions">
          <button className="esc-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`esc-btn ${danger ? "esc-btn--danger" : "esc-btn--primary"}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
