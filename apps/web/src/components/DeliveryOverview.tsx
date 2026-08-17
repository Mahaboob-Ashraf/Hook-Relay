import type { DeliverySummary } from "../api/client";

export function DeliveryOverview({
  deliveries,
  matchingTotal,
}: {
  deliveries: DeliverySummary[];
  matchingTotal: number;
}) {
  const delivered = deliveries.filter((delivery) => delivery.status === "delivered").length;
  const active = deliveries.filter((delivery) =>
    delivery.status === "queued" ||
    delivery.status === "delivering" ||
    delivery.status === "retry_scheduled",
  ).length;
  const deadLetter = deliveries.filter((delivery) => delivery.status === "dead_letter").length;

  return (
    <section className="operations-overview" aria-labelledby="operations-heading">
      <div className="overview-copy">
        <div className="overview-eyebrow">
          <span className="eyebrow-signal" aria-hidden="true" />
          <p className="section-kicker">Webhook reliability workspace</p>
        </div>
        <h1 id="operations-heading">Delivery operations</h1>
        <p>Trace every delivery from durable ingestion through attempts, recovery, and replay.</p>
      </div>
      <div className="overview-monitor">
        <p><span aria-hidden="true" /> Live delivery view</p>
        <dl className="overview-signals" aria-label="Summary of currently loaded delivery data">
        <div>
          <dt>Loaded</dt>
          <dd>
            {deliveries.length.toLocaleString()}
            <span> of {matchingTotal.toLocaleString()}</span>
          </dd>
        </div>
        <div className="is-delivered">
          <dt>Delivered</dt>
          <dd>{delivered.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Active</dt>
          <dd>{active.toLocaleString()}</dd>
        </div>
        <div className={deadLetter ? "is-alert" : undefined}>
          <dt>Dead letter</dt>
          <dd>{deadLetter.toLocaleString()}</dd>
        </div>
        </dl>
      </div>
    </section>
  );
}
