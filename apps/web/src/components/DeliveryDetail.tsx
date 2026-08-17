import { useState } from "react";
import type { DeliveryDetailResponse } from "../api/client";
import { shortId, statusDetails } from "../utilities/format";
import { AttemptTimeline } from "./AttemptTimeline";
import { Icon } from "./Icon";
import { ReplayHistory } from "./ReplayHistory";
import { StatusLabel } from "./StatusLabel";
import { Timestamp } from "./Timestamp";

type CopyFeedback = "idle" | "copied" | "failed";

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // The Clipboard API can be blocked even when it exists; use the local fallback.
  }

  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  try {
    input.select();
    return document.execCommand?.("copy") ?? false;
  } catch {
    return false;
  } finally {
    input.remove();
  }
}

function Identifier({ label, value }: { label: string; value: string }) {
  const [feedback, setFeedback] = useState<CopyFeedback>("idle");
  const handleCopy = async () => {
    const copied = await copyText(value);
    setFeedback(copied ? "copied" : "failed");
    window.setTimeout(() => setFeedback("idle"), 1800);
  };
  const accessibleLabel = feedback === "copied"
    ? `${label} copied`
    : feedback === "failed"
      ? `Could not copy ${label.toLocaleLowerCase()}`
      : `Copy ${label.toLocaleLowerCase()}`;

  return (
    <div className="identifier-field">
      <dt>{label}</dt>
      <dd>
        <code>{value}</code>
        <button type="button" className="copy-button icon-button" onClick={() => void handleCopy()} aria-label={accessibleLabel}>
          <Icon name={feedback === "copied" ? "check" : "copy"} />
          <span>{feedback === "copied" ? "Copied" : feedback === "failed" ? "Failed" : "Copy"}</span>
        </button>
        <span className="sr-only" role="status" aria-live="polite">
          {feedback === "copied" ? `${label} copied.` : feedback === "failed" ? `${label} could not be copied.` : ""}
        </span>
      </dd>
    </div>
  );
}

export function DeliveryDetail({
  response,
  onSelectRelated,
  onReplay,
  onBack,
}: {
  response: DeliveryDetailResponse;
  onSelectRelated: (deliveryId: string) => void;
  onReplay: () => void;
  onBack: () => void;
}) {
  const { delivery, attempts, relatedDeliveries } = response;
  const [payloadFeedback, setPayloadFeedback] = useState<CopyFeedback>("idle");
  const formattedPayload = JSON.stringify(delivery.event.payload, null, 2);
  const handlePayloadCopy = async () => {
    const copied = await copyText(formattedPayload);
    setPayloadFeedback(copied ? "copied" : "failed");
    window.setTimeout(() => setPayloadFeedback("idle"), 1800);
  };

  return (
    <article className="delivery-detail" aria-labelledby="delivery-detail-heading">
      <button type="button" className="mobile-back" onClick={onBack}>
        <Icon name="arrow-left" /> Back to deliveries
      </button>

      <header className="detail-header">
        <div className="detail-header-top">
          <div>
            <p className="section-kicker">{delivery.replayedFromDeliveryId ? "Replay delivery" : "Original delivery"}</p>
            <h2 id="delivery-detail-heading">Delivery <span className="mono">{shortId(delivery.id)}</span></h2>
            <div className="detail-status-line">
              <StatusLabel status={delivery.status} />
              <span>{statusDetails[delivery.status].explanation}</span>
            </div>
          </div>
          {delivery.status === "dead_letter" ? (
            <button type="button" className="primary-button replay-action" onClick={onReplay}>
              <Icon name="replay" /> Replay delivery
            </button>
          ) : null}
        </div>

        <div className="detail-route" aria-label={`${delivery.event.eventType} routes to ${delivery.endpoint.name}`}>
          <span className="route-object route-event">
            <small>Event</small>
            <strong title={delivery.event.eventType}>{delivery.event.eventType}</strong>
          </span>
          <span className="route-path" aria-hidden="true"><i /><i /><i /></span>
          <span className="route-object route-endpoint">
            <small>Destination</small>
            <strong title={delivery.endpoint.name}>{delivery.endpoint.name}</strong>
            <span title={delivery.endpoint.url}>{delivery.endpoint.url}</span>
          </span>
        </div>

        <div className="detail-summary-strip" aria-label="Selected delivery summary">
          <span><small>Attempts</small><strong className="mono">{delivery.attemptCount}</strong></span>
          <span><small>Created</small><strong><Timestamp value={delivery.createdAt} /></strong></span>
          <span><small>{delivery.nextAttemptAt ? "Next retry" : "Delivered"}</small><strong><Timestamp value={delivery.nextAttemptAt ?? delivery.deliveredAt} /></strong></span>
          <span><small>Lineage</small><strong>{delivery.replayedFromDeliveryId ? `Replay of ${shortId(delivery.replayedFromDeliveryId)}` : "Original"}</strong></span>
        </div>
      </header>

      <div className="detail-content-grid">
        <section className="detail-section identity-section" aria-labelledby="identity-heading">
          <div className="section-heading-row">
            <div>
              <p className="section-kicker">Canonical routing</p>
              <h3 id="identity-heading">Identity & destination</h3>
            </div>
          </div>
          <dl className="identifier-list">
            <Identifier label="Delivery ID" value={delivery.id} />
            <Identifier label="Event ID" value={delivery.event.id} />
          </dl>
          <dl className="detail-grid">
            <div><dt>Event type</dt><dd>{delivery.event.eventType}</dd></div>
            <div><dt>Endpoint</dt><dd>{delivery.endpoint.name}</dd></div>
            <div className="wide-field"><dt>Endpoint URL</dt><dd><a href={delivery.endpoint.url} target="_blank" rel="noreferrer">{delivery.endpoint.url}</a></dd></div>
            <div><dt>Created</dt><dd><Timestamp value={delivery.createdAt} relative={false} /></dd></div>
            <div><dt>Delivered</dt><dd><Timestamp value={delivery.deliveredAt} relative={false} /></dd></div>
            <div><dt>Next retry</dt><dd><Timestamp value={delivery.nextAttemptAt} relative={false} /></dd></div>
            <div><dt>Attempt count</dt><dd className="mono">{delivery.attemptCount}</dd></div>
            <div className="wide-field"><dt>Relationship</dt><dd>{delivery.replayedFromDeliveryId ? <>Replay of <button className="inline-id-button mono" type="button" onClick={() => onSelectRelated(delivery.replayedFromDeliveryId!)}>{shortId(delivery.replayedFromDeliveryId)}</button></> : "Original delivery"}</dd></div>
          </dl>
        </section>

        <AttemptTimeline attempts={attempts} deliveryStatus={delivery.status} nextAttemptAt={delivery.nextAttemptAt} />
        <ReplayHistory deliveries={relatedDeliveries} selectedId={delivery.id} onSelect={onSelectRelated} />

        <section className="detail-section payload-section" aria-labelledby="payload-heading">
          <div className="section-heading-row">
            <div>
              <p className="section-kicker">Developer inspector</p>
              <h3 id="payload-heading">Event payload</h3>
            </div>
            <button
              type="button"
              className="copy-button payload-copy"
              onClick={() => void handlePayloadCopy()}
              aria-label={payloadFeedback === "copied"
                ? "Event payload copied"
                : payloadFeedback === "failed"
                  ? "Could not copy event payload"
                  : "Copy event payload"}
            >
              <Icon name={payloadFeedback === "copied" ? "check" : "copy"} />
              {payloadFeedback === "copied" ? "Copied" : payloadFeedback === "failed" ? "Copy failed" : "Copy payload"}
            </button>
            <span className="sr-only" role="status" aria-live="polite">
              {payloadFeedback === "copied" ? "Event payload copied." : payloadFeedback === "failed" ? "Event payload could not be copied." : ""}
            </span>
          </div>
          <div className="payload-editor">
            <div className="payload-toolbar" aria-hidden="true">
              <span className="editor-dots"><i /><i /><i /></span>
              <span>payload.json</span>
              <span>JSON · read only</span>
            </div>
            <pre><code>{formattedPayload}</code></pre>
          </div>
        </section>
      </div>
    </article>
  );
}
