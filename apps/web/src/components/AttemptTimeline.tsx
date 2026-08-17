import type { DeliveryAttempt, DeliveryStatus } from "../api/client";
import { formatLatency } from "../utilities/format";
import { Timestamp } from "./Timestamp";

type AttemptOutcome = {
  kind: "success" | "http-failure" | "transport-failure" | "unknown";
  label: string;
  explanation?: string;
};

function attemptGapLabel(
  attempt: DeliveryAttempt,
  nextAttempt: DeliveryAttempt,
): string | null {
  if (!attempt.completedAt) return null;
  const completedAt = new Date(attempt.completedAt).getTime();
  const nextStartedAt = new Date(nextAttempt.startedAt).getTime();
  const elapsedMs = nextStartedAt - completedAt;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;

  const totalSeconds = Math.max(1, Math.round(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function attemptOutcome(attempt: DeliveryAttempt): AttemptOutcome {
  if (attempt.completedAt === null) {
    return {
      kind: "unknown",
      label: "Outcome unknown",
      explanation: "Processing started, but HookRelay never durably recorded the result.",
    };
  }
  if (attempt.responseStatus !== null) {
    if (attempt.responseStatus >= 200 && attempt.responseStatus < 300) {
      return { kind: "success", label: "Delivered" };
    }
    return { kind: "http-failure", label: `HTTP ${attempt.responseStatus}` };
  }
  if (attempt.errorMessage) {
    return { kind: "transport-failure", label: attempt.errorMessage };
  }
  return { kind: "unknown", label: "No response recorded" };
}

export function AttemptTimeline({
  attempts,
  deliveryStatus,
  nextAttemptAt,
}: {
  attempts: DeliveryAttempt[];
  deliveryStatus: DeliveryStatus;
  nextAttemptAt: string | null;
}) {
  if (attempts.length === 0) {
    return (
      <section className="detail-section attempt-section" aria-labelledby="attempts-heading">
        <div className="section-heading-row">
          <div>
            <p className="section-kicker">Relay path</p>
            <h3 id="attempts-heading">Attempt timeline</h3>
          </div>
          <span className="section-count">0 attempts</span>
        </div>
        <div className="timeline-empty">
          <span className="relay-node waiting" aria-hidden="true" />
          <div>
            <strong>Waiting for the first attempt</strong>
            <p>{deliveryStatus === "queued" ? "This durable delivery is queued for worker processing." : "No durable attempt has been recorded for this delivery."}</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="detail-section attempt-section" aria-labelledby="attempts-heading">
      <div className="section-heading-row">
        <div>
          <p className="section-kicker">Relay path</p>
          <h3 id="attempts-heading">Attempt timeline</h3>
        </div>
        <span className="section-count">{attempts.length} {attempts.length === 1 ? "attempt" : "attempts"}</span>
      </div>
      <ol className="attempt-timeline">
        {attempts.map((attempt, index) => {
          const outcome = attemptOutcome(attempt);
          const nextAttempt = attempts[index + 1];
          const gapLabel = nextAttempt ? attemptGapLabel(attempt, nextAttempt) : null;
          const wasRetried = Boolean(
            nextAttempt && (outcome.kind === "http-failure" || outcome.kind === "transport-failure"),
          );
          const isTerminal = Boolean(
            !nextAttempt &&
            deliveryStatus === "dead_letter" &&
            (outcome.kind === "http-failure" || outcome.kind === "transport-failure"),
          );
          const isAwaitingRetry = Boolean(
            !nextAttempt &&
            deliveryStatus === "retry_scheduled" &&
            (outcome.kind === "http-failure" || outcome.kind === "transport-failure"),
          );
          const progressionClass = wasRetried
            ? " is-retried"
            : isTerminal
              ? " is-terminal"
              : isAwaitingRetry
                ? " is-awaiting-retry"
                : "";
          return (
            <li key={attempt.id} className={`attempt-item outcome-${outcome.kind}${progressionClass}`}>
              <span className="relay-node" aria-hidden="true" />
              <article>
                <div className="attempt-heading">
                  <span className="attempt-number">Attempt {String(attempt.attemptNumber).padStart(2, "0")}</span>
                  <strong className="attempt-outcome">{outcome.label}</strong>
                </div>
                {outcome.explanation ? <p className="unknown-explanation">{outcome.explanation}</p> : null}
                {attempt.errorMessage && outcome.kind === "http-failure" ? (
                  <p className="attempt-error">{attempt.errorMessage}</p>
                ) : null}
                <dl className="attempt-meta">
                  <div><dt>Started</dt><dd><Timestamp value={attempt.startedAt} relative={false} /></dd></div>
                  <div><dt>Completed</dt><dd><Timestamp value={attempt.completedAt} relative={false} /></dd></div>
                  <div><dt>Latency</dt><dd className="mono">{formatLatency(attempt.latencyMs)}</dd></div>
                  <div><dt>HTTP status</dt><dd className="mono">{attempt.responseStatus ?? "—"}</dd></div>
                </dl>
              </article>
              {nextAttempt ? (
                <div className="attempt-transition">
                  <span aria-hidden="true" />
                  <p>
                    {gapLabel
                      ? `Next attempt began ${gapLabel} later`
                      : "Next recorded attempt"}
                  </p>
                </div>
              ) : null}
            </li>
          );
        })}
        {deliveryStatus === "retry_scheduled" && nextAttemptAt ? (
          <li className="attempt-item scheduled-marker">
            <span className="relay-node" aria-hidden="true" />
            <article>
              <div className="attempt-heading"><strong>Retry scheduled</strong></div>
              <p>Next worker attempt: <Timestamp value={nextAttemptAt} relative={false} /></p>
            </article>
          </li>
        ) : null}
      </ol>
    </section>
  );
}
