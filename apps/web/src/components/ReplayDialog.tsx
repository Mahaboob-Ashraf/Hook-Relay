import { useEffect, useRef } from "react";
import { shortId } from "../utilities/format";

export type PendingReplay = {
  sourceDeliveryId: string;
  idempotencyKey: string;
  replayDeliveryId?: string;
  failure: "durable" | "ambiguous";
};

export function ReplayDialog({
  sourceDeliveryId,
  submitting,
  pending,
  errorMessage,
  onConfirm,
  onRetry,
  onClose,
  onDismissPending,
}: {
  sourceDeliveryId: string;
  submitting: boolean;
  pending: PendingReplay | null;
  errorMessage: string | null;
  onConfirm: () => void;
  onRetry: () => void;
  onClose: () => void;
  onDismissPending: () => void;
}) {
  const primaryRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  const submittingRef = useRef(submitting);
  closeRef.current = onClose;
  submittingRef.current = submitting;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const dialog = dialogRef.current;
    const supportsModal = typeof dialog?.showModal === "function";
    if (dialog && !dialog.open) {
      if (supportsModal) dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    const handleCancel = (event: Event) => {
      event.preventDefault();
      if (!submittingRef.current) closeRef.current();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submittingRef.current) closeRef.current();
      if (supportsModal || event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
        ) ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    dialog?.addEventListener("cancel", handleCancel);
    if (!supportsModal) window.addEventListener("keydown", handleKey);
    return () => {
      dialog?.removeEventListener("cancel", handleCancel);
      if (!supportsModal) window.removeEventListener("keydown", handleKey);
      if (dialog?.open && typeof dialog.close === "function") dialog.close();
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    primaryRef.current?.focus();
  }, [pending]);

  return (
      <dialog ref={dialogRef} className="replay-dialog" aria-modal="true" aria-labelledby="replay-dialog-title" aria-describedby="replay-dialog-description">
        <div className="dialog-path" aria-hidden="true"><span /><span /></div>
        {pending ? (
          <>
            <p className="section-kicker">Replay needs attention</p>
            <h2 id="replay-dialog-title">Retry queue scheduling</h2>
            <div id="replay-dialog-description">
              {pending.failure === "durable" ? (
                <p><strong>The replay was saved in PostgreSQL, but queue scheduling failed.</strong></p>
              ) : (
                <p><strong>The replay request outcome is uncertain because the API could not be reached.</strong></p>
              )}
              <p>Retrying uses the same operation key, so HookRelay will reuse the durable replay instead of creating another one.</p>
              {pending.replayDeliveryId ? <p className="dialog-reference">Saved replay <span className="mono">{shortId(pending.replayDeliveryId)}</span></p> : null}
              {errorMessage ? <p className="inline-alert" role="alert">{errorMessage}</p> : null}
            </div>
            <div className="dialog-actions">
              <button type="button" className="text-button" onClick={onDismissPending} disabled={submitting}>Dismiss operation</button>
              <button ref={primaryRef} type="button" className="primary-button" onClick={onRetry} disabled={submitting}>
                {submitting ? "Retrying…" : "Retry queue scheduling"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="section-kicker">Create a new delivery</p>
            <h2 id="replay-dialog-title">Replay this dead letter?</h2>
            <div id="replay-dialog-description">
              <p>The failed delivery and its attempt history will remain unchanged.</p>
              <p>HookRelay will create a new queued delivery for the same event and endpoint with a fresh five-attempt budget.</p>
              <p className="dialog-reference">Source <span className="mono">{shortId(sourceDeliveryId)}</span></p>
              {errorMessage ? <p className="inline-alert" role="alert">{errorMessage}</p> : null}
            </div>
            <div className="dialog-actions">
              <button type="button" className="secondary-button" onClick={onClose} disabled={submitting}>Cancel</button>
              <button ref={primaryRef} type="button" className="primary-button" onClick={onConfirm} disabled={submitting}>
                {submitting ? "Creating replay…" : "Create replay delivery"}
              </button>
            </div>
          </>
        )}
      </dialog>
  );
}
