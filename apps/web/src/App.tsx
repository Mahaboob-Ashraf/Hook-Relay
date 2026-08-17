import { useCallback, useEffect, useRef, useState } from "react";
import { AppHeader } from "./components/AppHeader";
import { DeliveryDetail } from "./components/DeliveryDetail";
import { DeliveryOverview } from "./components/DeliveryOverview";
import { DeliveryTable } from "./components/DeliveryTable";
import { ReplayDialog } from "./components/ReplayDialog";
import { useDeliveryData } from "./hooks/useDeliveryData";
import { readPendingReplay, useReplayOperation } from "./hooks/useReplayOperation";
import { useThemePreference } from "./hooks/useThemePreference";

export { generateReplayKey } from "./hooks/useReplayOperation";

const singlePaneQuery = "(max-width: 820px)";

function usesSinglePaneLayout(): boolean {
  return window.matchMedia?.(singlePaneQuery).matches ?? false;
}

export function App() {
  const [initialPending] = useState(readPendingReplay);
  const theme = useThemePreference();
  const data = useDeliveryData(initialPending?.sourceDeliveryId ?? null);
  const detailPanelRef = useRef<HTMLElement>(null);
  const previousSelectedId = useRef<string | null>(null);
  const lastSelectedId = useRef<string | null>(data.selectedId);
  const listScrollPosition = useRef(0);

  const selectDelivery = useCallback((deliveryId: string) => {
    if (usesSinglePaneLayout() && !data.selectedId) {
      listScrollPosition.current = window.scrollY;
    }
    lastSelectedId.current = deliveryId;
    data.selectDelivery(deliveryId);
  }, [data.selectedId, data.selectDelivery]);

  const replay = useReplayOperation({
    initialPending,
    detail: data.detail,
    refreshList: () => data.loadList({ background: true }),
    selectDelivery,
    announce: data.announce,
  });

  useEffect(() => {
    const previous = previousSelectedId.current;
    previousSelectedId.current = data.selectedId;
    if (data.selectedId) lastSelectedId.current = data.selectedId;
    if (previous === data.selectedId || !usesSinglePaneLayout()) return;

    const frame = window.requestAnimationFrame(() => {
      if (data.selectedId) {
        detailPanelRef.current?.focus({ preventScroll: true });
        detailPanelRef.current?.scrollIntoView?.({ block: "start" });
        return;
      }

      window.scrollTo({ top: listScrollPosition.current, behavior: "auto" });
      const rowButton = lastSelectedId.current
        ? document.getElementById(`delivery-${lastSelectedId.current}`)
        : null;
      rowButton?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [data.selectedId]);

  useEffect(() => {
    if (
      !usesSinglePaneLayout() ||
      !data.selectedId ||
      data.detail?.delivery.id !== data.selectedId
    ) return;

    const frame = window.requestAnimationFrame(() => {
      detailPanelRef.current
        ?.querySelector<HTMLElement>(".mobile-back")
        ?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [data.detail?.delivery.id, data.selectedId]);

  return (
    <>
      <a className="skip-link" href="#main-content">Skip to delivery workspace</a>
      <AppHeader
        readiness={data.readiness}
        readinessFailed={data.readinessFailed}
        refreshing={data.refreshing}
        lastRefresh={data.lastRefresh}
        onRefresh={() => void data.refresh()}
        themePreference={theme.preference}
        onThemeChange={theme.setPreference}
      />
      <div className="live-region sr-only" aria-live="polite" aria-atomic="true">
        {data.announcement}
      </div>

      <main id="main-content" className="operations-canvas">
        {data.staleMessage ? (
          <div className="stale-banner" role="status">
            <span>{data.staleMessage}</span>
            <button type="button" onClick={() => void data.refresh()}>Try again</button>
          </div>
        ) : null}

        {data.listLoading && !data.list ? (
          <section className="initial-state" aria-label="Loading deliveries">
            <div className="loading-track" aria-hidden="true"><span /><span /><span /></div>
            <h1>Loading delivery operations…</h1>
            <p>Reading durable delivery state from HookRelay.</p>
          </section>
        ) : data.listError && !data.list ? (
          <section className="initial-state error-state">
            <span className="state-rule" aria-hidden="true" />
            <h1>Delivery data is unavailable</h1>
            <p>{data.listError}</p>
            <button
              type="button"
              className="primary-button"
              onClick={() => void data.loadList()}
            >
              Retry loading deliveries
            </button>
          </section>
        ) : data.list ? (
          <>
            <DeliveryOverview
              deliveries={data.list.deliveries}
              matchingTotal={data.list.page.total}
            />
            <div className={data.selectedId ? "workspace has-selection" : "workspace"}>
              <DeliveryTable
                deliveries={data.list.deliveries}
                selectedId={data.selectedId}
                status={data.status}
                search={data.search}
                total={data.list.page.total}
                loadingMore={data.loadingMore}
                onStatusChange={data.changeStatus}
                onSearchChange={data.setSearch}
                onSelect={selectDelivery}
                onLoadMore={() => void data.loadList({ append: true })}
                onRefresh={() => void data.refresh()}
              />

              <section
                ref={detailPanelRef}
                className="detail-panel"
                aria-label="Delivery inspection"
                tabIndex={-1}
              >
              {!data.selectedId ? (
                <div className="detail-placeholder">
                  <span className="relay-placeholder" aria-hidden="true"><i /><i /><i /></span>
                  <h2>Select a delivery</h2>
                  <p>Inspect its durable state, attempt outcomes, payload, and replay ancestry.</p>
                </div>
              ) : data.detailLoading && !data.detail ? (
                <div className="detail-placeholder" aria-label="Loading delivery detail">
                  <span className="relay-placeholder is-loading" aria-hidden="true"><i /><i /><i /></span>
                  <h2>Loading delivery…</h2>
                </div>
              ) : data.detailError && !data.detail ? (
                <div className="detail-placeholder error-state">
                  <span className="state-rule" aria-hidden="true" />
                  <h2>{data.detailError.missing ? "Delivery not found" : "Could not load this delivery"}</h2>
                  <p>{data.detailError.message}</p>
                  <div className="state-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={data.clearSelection}
                    >
                      Back to deliveries
                    </button>
                    {!data.detailError.missing ? (
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => void data.loadDetail(data.selectedId!)}
                      >
                        Retry detail
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : data.detail ? (
                <DeliveryDetail
                  response={data.detail}
                  onSelectRelated={selectDelivery}
                  onReplay={replay.beginReplay}
                  onBack={data.clearSelection}
                />
              ) : null}
              </section>
            </div>
          </>
        ) : null}
      </main>

      {replay.dialogSourceId ? (
        <ReplayDialog
          sourceDeliveryId={replay.dialogSourceId}
          submitting={replay.replaySubmitting}
          pending={replay.pendingReplay}
          errorMessage={replay.replayError}
          onConfirm={replay.confirmReplay}
          onRetry={replay.retryReplay}
          onClose={replay.closeDialog}
          onDismissPending={replay.dismissPending}
        />
      ) : null}
    </>
  );
}
