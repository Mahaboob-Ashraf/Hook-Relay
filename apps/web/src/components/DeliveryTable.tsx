import type { DeliveryStatus, DeliverySummary } from "../api/client";
import { shortId } from "../utilities/format";
import { Icon } from "./Icon";
import { StatusLabel } from "./StatusLabel";
import { Timestamp } from "./Timestamp";

const statusOptions: Array<{ value: "" | DeliveryStatus; label: string }> = [
  { value: "", label: "All statuses" },
  { value: "queued", label: "Queued" },
  { value: "delivering", label: "Delivering" },
  { value: "retry_scheduled", label: "Retry scheduled" },
  { value: "delivered", label: "Delivered" },
  { value: "dead_letter", label: "Dead letter" },
];

export function DeliveryTable({
  deliveries,
  selectedId,
  status,
  search,
  total,
  loadingMore,
  onStatusChange,
  onSearchChange,
  onSelect,
  onLoadMore,
  onRefresh,
}: {
  deliveries: DeliverySummary[];
  selectedId: string | null;
  status: DeliveryStatus | "";
  search: string;
  total: number;
  loadingMore: boolean;
  onStatusChange: (status: DeliveryStatus | "") => void;
  onSearchChange: (search: string) => void;
  onSelect: (deliveryId: string) => void;
  onLoadMore: () => void;
  onRefresh: () => void;
}) {
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visible = normalizedSearch
    ? deliveries.filter((delivery) =>
        [delivery.id, delivery.event.id, delivery.event.eventType, delivery.endpoint.name, delivery.endpoint.url]
          .some((value) => value.toLocaleLowerCase().includes(normalizedSearch)),
      )
    : deliveries;

  return (
    <section className="delivery-list-panel" aria-labelledby="deliveries-heading">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Delivery stream</p>
          <h2 id="deliveries-heading">Deliveries</h2>
        </div>
        <p className="record-count" aria-label={`${total} total deliveries`}>
          <strong>{total.toLocaleString()}</strong> records
        </p>
      </div>

      <div className="table-toolbar" aria-label="Delivery filters">
        <label className="filter-field">
          <span><Icon name="filter" /> Status</span>
          <select value={status} onChange={(event) => onStatusChange(event.target.value as DeliveryStatus | "")}>
            {statusOptions.map((option) => (
              <option key={option.value || "all"} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="search-field">
          <span className="sr-only">Find in loaded records</span>
          <Icon name="search" />
          <input
            type="search"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Find event, endpoint, ID..."
            autoComplete="off"
          />
        </label>
      </div>

      {visible.length > 0 ? (
        <ol className="delivery-stream" aria-label="Webhook deliveries ordered newest first">
          {visible.map((delivery) => {
            const selected = delivery.id === selectedId;
            const timing = delivery.nextAttemptAt ?? delivery.deliveredAt ?? delivery.createdAt;
            return (
              <li key={delivery.id} className={selected ? "is-selected" : undefined}>
                <button
                  type="button"
                  className="delivery-selector"
                  id={`delivery-${delivery.id}`}
                  onClick={() => onSelect(delivery.id)}
                  aria-label={`Inspect delivery ${delivery.id}`}
                  aria-current={selected ? "true" : undefined}
                >
                  <span className="delivery-row-top">
                    <span className="event-name" title={delivery.event.eventType}>{delivery.event.eventType}</span>
                    <StatusLabel status={delivery.status} />
                  </span>
                  <span className="delivery-destination">
                    <Icon name="endpoint" />
                    <span>
                      <strong className="inspectable-value" title={delivery.endpoint.name} aria-label={`Endpoint name ${delivery.endpoint.name}`}>
                        {delivery.endpoint.name}
                      </strong>
                      <small className="inspectable-value" title={delivery.endpoint.url} aria-label={`Endpoint URL ${delivery.endpoint.url}`}>
                        {delivery.endpoint.url}
                      </small>
                    </span>
                  </span>
                  <span className="delivery-row-meta">
                    <span className="delivery-identity">
                      <span className="delivery-kind">{delivery.replayedFromDeliveryId ? "Replay" : "Original"}</span>
                      <code title={delivery.id}>{shortId(delivery.id)}</code>
                    </span>
                    <span className="sr-only" aria-label={`Event ID ${delivery.event.id}`}>{delivery.event.id}</span>
                    <span className="attempt-count"><strong>{delivery.attemptCount}</strong> {delivery.attemptCount === 1 ? "attempt" : "attempts"}</span>
                    <span className="delivery-timing">
                      <Timestamp value={timing} />
                      <small>{delivery.nextAttemptAt ? "Next retry" : delivery.deliveredAt ? "Completed" : "Created"}</small>
                    </span>
                  </span>
                  <Icon name="arrow-right" className="delivery-row-arrow" />
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}

      {visible.length === 0 ? (
        <div className="table-state">
          <span className="state-rule" aria-hidden="true" />
          <h2>{deliveries.length === 0 ? "No deliveries yet" : "No loaded deliveries match"}</h2>
          <p>
            {deliveries.length === 0
              ? status
                ? "No deliveries have this status. Clear the status filter or refresh."
                : "Send a webhook event to see its delivery lifecycle, retries, attempts, and replay history here."
              : "Try a different ID, event type, or endpoint name."}
          </p>
          <div className="state-actions">
            {status ? <button type="button" className="secondary-button" onClick={() => onStatusChange("")}>Clear status</button> : null}
            {search ? <button type="button" className="secondary-button" onClick={() => onSearchChange("")}>Clear search</button> : null}
            {!status && !search ? <button type="button" className="secondary-button" onClick={onRefresh}>Refresh deliveries</button> : null}
          </div>
        </div>
      ) : null}

      {deliveries.length < total ? (
        <div className="pagination-bar">
          <span>Showing {deliveries.length} of {total}</span>
          <button type="button" className="secondary-button" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? "Loading..." : "Load more"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
