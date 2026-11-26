import { useState, type ReactNode } from "react";

import { Dialog } from "./Dialog";

interface Props {
  title: string;
  children: ReactNode;
  /** Label of the button that goes ahead. Omit for a message with only an OK button. */
  confirmLabel?: string;
  danger?: boolean;
  /** Show a "Don't ask again" checkbox; its state is passed to onConfirm. */
  offerDontAsk?: boolean;
  onConfirm?: (dontAskAgain: boolean) => void;
  onClose: () => void;
}

export function ConfirmDialog({ title, children, confirmLabel, danger, offerDontAsk, onConfirm, onClose }: Props) {
  const [dontAsk, setDontAsk] = useState(false);
  return (
    <Dialog title={title} onClose={onClose} className="confirm">
      <div className="confirm-body">{children}</div>
      <footer className="dialog-foot">
        {offerDontAsk && (
          <label className="dont-ask">
            <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
            Don't ask again
          </label>
        )}
        {confirmLabel ? (
          <>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className={danger ? "btn danger" : "btn primary"} onClick={() => onConfirm?.(dontAsk)} autoFocus>
              {confirmLabel}
            </button>
          </>
        ) : (
          <button className="btn primary" onClick={onClose} autoFocus>
            OK
          </button>
        )}
      </footer>
    </Dialog>
  );
}
