import type { DeliveryStatus } from "../api/client";
import { statusDetails } from "../utilities/format";

export function StatusLabel({ status }: { status: DeliveryStatus }) {
  return (
    <span className={`status-label status-${status}`}>
      <span className="status-mark" aria-hidden="true" />
      {statusDetails[status].label}
    </span>
  );
}
