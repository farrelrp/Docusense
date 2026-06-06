import { WarningResult } from "../api";

interface WarningModalProps {
  warning: WarningResult;
  onCancel: () => void;
  onContinue: () => void;
}

export default function WarningModal({ warning, onCancel, onContinue }: WarningModalProps) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="warning-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="warning-heading"
      >
        <h2 id="warning-heading">Long PDF warning</h2>
        <p>{warning.message}</p>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary-button" onClick={onContinue}>
            Continue Processing
          </button>
        </div>
      </section>
    </div>
  );
}
