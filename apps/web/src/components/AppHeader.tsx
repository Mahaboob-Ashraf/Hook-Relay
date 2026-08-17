import type { ReadinessResponse } from "../api/client";
import type { ThemePreference } from "../hooks/useThemePreference";
import { exactDateTime } from "../utilities/format";
import { Icon } from "./Icon";
import { ThemeControl } from "./ThemeControl";

export function AppHeader({
  readiness,
  readinessFailed,
  refreshing,
  lastRefresh,
  onRefresh,
  themePreference,
  onThemeChange,
}: {
  readiness: ReadinessResponse | null;
  readinessFailed: boolean;
  refreshing: boolean;
  lastRefresh: Date | null;
  onRefresh: () => void;
  themePreference: ThemePreference;
  onThemeChange: (preference: ThemePreference) => void;
}) {
  const ready = readiness?.status === "ready" && !readinessFailed;
  const readinessLabel = readinessFailed
    ? "Readiness check failed"
    : readiness
    ? ready
      ? "Dependencies ready"
      : "Dependencies unavailable"
    : "Checking dependencies";

  return (
    <header className="app-header">
      <div className="brand-lockup" translate="no">
        <span className="brand-path" aria-hidden="true"><i /><i /><i /></span>
        <span className="wordmark">HookRelay</span>
        <span className="header-context">Delivery operations</span>
      </div>
      <div className="header-operations">
        <ThemeControl value={themePreference} onChange={onThemeChange} />
        <div className={`readiness ${ready ? "is-ready" : "is-degraded"}`} title={readinessLabel}>
          <span className="readiness-mark" aria-hidden="true" />
          <span>
            <strong>{readinessLabel}</strong>
            {readinessFailed ? (
              <small>{readiness ? "Showing the last known dependency state" : "Health endpoint unavailable"}</small>
            ) : readiness ? (
              <small>
                PostgreSQL {readiness.dependencies.postgres.status} · Redis {readiness.dependencies.redis.status}
              </small>
            ) : null}
          </span>
        </div>
        <div className="refresh-meta">
          <span>
            {lastRefresh
              ? `Updated ${exactDateTime(lastRefresh.toISOString())}`
              : "No successful refresh yet"}
          </span>
          <button className="header-button" type="button" onClick={onRefresh} disabled={refreshing}>
            <Icon name="refresh" className={refreshing ? "refresh-glyph is-spinning" : "refresh-glyph"} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>
    </header>
  );
}
