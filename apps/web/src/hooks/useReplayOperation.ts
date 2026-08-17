import { useCallback, useState } from "react";
import {
  ApiError,
  replayDelivery,
  type DeliveryDetailResponse,
  type ReplayResponse,
} from "../api/client";
import type { PendingReplay } from "../components/ReplayDialog";

const REPLAY_SESSION_KEY = "hookrelay.pending-replay";

export function readPendingReplay(): PendingReplay | null {
  try {
    const raw = sessionStorage.getItem(REPLAY_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingReplay>;
    if (
      typeof parsed.sourceDeliveryId !== "string" ||
      typeof parsed.idempotencyKey !== "string" ||
      (parsed.failure !== "durable" && parsed.failure !== "ambiguous")
    ) return null;
    return parsed as PendingReplay;
  } catch {
    return null;
  }
}

function persistPendingReplay(value: PendingReplay | null): boolean {
  try {
    if (value) sessionStorage.setItem(REPLAY_SESSION_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(REPLAY_SESSION_KEY);
    return true;
  } catch {
    return false;
  }
}

export function generateReplayKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function replayFromError(error: ApiError): ReplayResponse | null {
  if (!error.body || typeof error.body !== "object") return null;
  const body = error.body as Partial<ReplayResponse>;
  return body.durableAccepted && body.replayDelivery ? (body as ReplayResponse) : null;
}

export function useReplayOperation({
  initialPending,
  detail,
  refreshList,
  selectDelivery,
  announce,
}: {
  initialPending: PendingReplay | null;
  detail: DeliveryDetailResponse | null;
  refreshList: () => Promise<void>;
  selectDelivery: (deliveryId: string) => void;
  announce: (message: string) => void;
}) {
  const [dialogSourceId, setDialogSourceId] = useState<string | null>(
    initialPending?.sourceDeliveryId ?? null,
  );
  const [draftReplayKey, setDraftReplayKey] = useState<string | null>(null);
  const [pendingReplay, setPendingReplay] = useState<PendingReplay | null>(initialPending);
  const [replaySubmitting, setReplaySubmitting] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);

  const beginReplay = () => {
    if (!detail || detail.delivery.status !== "dead_letter") return;
    setReplayError(null);
    setDraftReplayKey(generateReplayKey());
    setDialogSourceId(detail.delivery.id);
  };

  const finishReplay = async (response: ReplayResponse) => {
    persistPendingReplay(null);
    setPendingReplay(null);
    setDraftReplayKey(null);
    setDialogSourceId(null);
    setReplayError(null);
    announce(`Replay delivery ${response.replayDelivery.id} was scheduled.`);
    await refreshList();
    selectDelivery(response.replayDelivery.id);
  };

  const submitReplay = async (sourceDeliveryId: string, idempotencyKey: string) => {
    if (replaySubmitting) return;
    setReplaySubmitting(true);
    setReplayError(null);
    const existingPending = pendingReplay;
    const recoverable: PendingReplay = {
      sourceDeliveryId,
      idempotencyKey,
      failure: "ambiguous",
    };
    if (!persistPendingReplay(existingPending ?? recoverable)) {
      const message = "Browser session storage is unavailable, so HookRelay did not send the replay request. Enable session storage and try again.";
      setReplayError(message);
      announce(message);
      setReplaySubmitting(false);
      return;
    }
    try {
      await finishReplay(await replayDelivery(sourceDeliveryId, idempotencyKey));
    } catch (error) {
      if (error instanceof ApiError) {
        const durable = replayFromError(error);
        if (durable) {
          const pending: PendingReplay = {
            ...recoverable,
            failure: "durable",
            replayDeliveryId: durable.replayDelivery.id,
          };
          persistPendingReplay(pending);
          setPendingReplay(pending);
          announce("The replay was saved in PostgreSQL, but queue scheduling failed.");
        } else {
          if (!existingPending) persistPendingReplay(null);
          setReplayError(error.message);
          announce(`Replay failed: ${error.message}`);
        }
      } else {
        const pending = existingPending ?? recoverable;
        persistPendingReplay(pending);
        setPendingReplay(pending);
        announce("Replay outcome is uncertain. Retry with the same operation key.");
      }
    } finally {
      setReplaySubmitting(false);
    }
  };

  const confirmReplay = () => {
    if (dialogSourceId && draftReplayKey) void submitReplay(dialogSourceId, draftReplayKey);
  };

  const retryReplay = () => {
    if (pendingReplay) {
      void submitReplay(pendingReplay.sourceDeliveryId, pendingReplay.idempotencyKey);
    }
  };

  const dismissPending = () => {
    persistPendingReplay(null);
    setPendingReplay(null);
    setDialogSourceId(null);
    setDraftReplayKey(null);
    announce("Pending replay operation dismissed.");
  };

  const closeDialog = useCallback(() => {
    if (replaySubmitting) return;
    setDialogSourceId(null);
    setDraftReplayKey(null);
    setReplayError(null);
  }, [replaySubmitting]);

  return {
    dialogSourceId,
    pendingReplay,
    replaySubmitting,
    replayError,
    beginReplay,
    confirmReplay,
    retryReplay,
    dismissPending,
    closeDialog,
  };
}
