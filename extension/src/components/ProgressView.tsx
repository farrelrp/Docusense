import { JobState } from "../api";

interface ProgressViewProps {
  state: JobState;
  message: string;
  errorMessage: string;
}

export default function ProgressView({ state, message, errorMessage }: ProgressViewProps) {
  return (
    <section className={`status status-${state}`} aria-live="polite" aria-atomic="true">
      <p className="status-label">Status</p>
      <p>{message}</p>
      {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
    </section>
  );
}
