import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  getDelivery,
  getReadiness,
  listDeliveries,
  type DeliveryDetailResponse,
  type DeliveryListResponse,
  type DeliveryStatus,
  type ReadinessResponse,
} from "../api/client";

const POLL_INTERVAL_MS = 10_000;
const deliveryStatuses = new Set<DeliveryStatus>([
  "queued",
  "delivering",
  "retry_scheduled",
  "delivered",
  "dead_letter",
]);

function currentUrlState(): { deliveryId: string | null; status: DeliveryStatus | "" } {
  const query = new URLSearchParams(window.location.search);
  const statusValue = query.get("status");
  return {
    deliveryId: query.get("delivery"),
    status: statusValue && deliveryStatuses.has(statusValue as DeliveryStatus)
      ? (statusValue as DeliveryStatus)
      : "",
  };
}

function updateUrl(
  deliveryId: string | null,
  status: DeliveryStatus | "",
  replace = false,
): void {
  const url = new URL(window.location.href);
  if (deliveryId) url.searchParams.set("delivery", deliveryId);
  else url.searchParams.delete("delivery");
  if (status) url.searchParams.set("status", status);
  else url.searchParams.delete("status");
  window.history[replace ? "replaceState" : "pushState"]({}, "", url);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function useDeliveryData(fallbackSelectedId: string | null) {
  const initialUrl = useRef(currentUrlState());
  const [status, setStatus] = useState<DeliveryStatus | "">(initialUrl.current.status);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialUrl.current.deliveryId ?? fallbackSelectedId,
  );
  const [search, setSearch] = useState("");
  const [list, setList] = useState<DeliveryListResponse | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [detail, setDetail] = useState<DeliveryDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<{ message: string; missing: boolean } | null>(null);
  const [readiness, setReadiness] = useState<ReadinessResponse | null>(null);
  const [readinessFailed, setReadinessFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [listStale, setListStale] = useState(false);
  const [detailStale, setDetailStale] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const listController = useRef<AbortController | null>(null);
  const detailController = useRef<AbortController | null>(null);
  const readinessController = useRef<AbortController | null>(null);
  const selectedIdRef = useRef(selectedId);
  const listRef = useRef(list);
  const detailRef = useRef(detail);
  selectedIdRef.current = selectedId;
  listRef.current = list;
  detailRef.current = detail;

  const staleMessage = listStale || detailStale
    ? "Background refresh failed. Showing the last successful delivery data."
    : null;

  const selectDelivery = useCallback((deliveryId: string, replace = false) => {
    setSelectedId(deliveryId);
    updateUrl(deliveryId, status, replace);
  }, [status]);

  const clearSelection = useCallback(() => {
    setSelectedId(null);
    updateUrl(null, status);
  }, [status]);

  const loadList = useCallback(async ({
    background = false,
    append = false,
  }: { background?: boolean; append?: boolean } = {}) => {
    listController.current?.abort();
    const controller = new AbortController();
    listController.current = controller;
    if (append) setLoadingMore(true);
    else if (!background) setListLoading(true);
    try {
      const current = listRef.current;
      let response: DeliveryListResponse;
      if (append) {
        response = await listDeliveries({
          status: status || undefined,
          limit: 50,
          offset: current?.deliveries.length ?? 0,
          signal: controller.signal,
        });
      } else {
        const desiredCount = Math.max(50, current?.deliveries.length ?? 50);
        const deliveries: DeliveryListResponse["deliveries"] = [];
        let total = Number.POSITIVE_INFINITY;

        while (deliveries.length < desiredCount && deliveries.length < total) {
          const page = await listDeliveries({
            status: status || undefined,
            limit: Math.min(100, desiredCount - deliveries.length),
            offset: deliveries.length,
            signal: controller.signal,
          });
          deliveries.push(...page.deliveries);
          total = page.page.total;
          if (page.deliveries.length === 0) break;
        }

        response = {
          deliveries,
          page: {
            limit: Math.min(100, desiredCount),
            offset: 0,
            total: Number.isFinite(total) ? total : 0,
          },
        };
      }
      setList((previous) => append && previous
        ? { ...response, deliveries: [...previous.deliveries, ...response.deliveries] }
        : response);
      setListError(null);
      setListStale(false);
      setLastRefresh(new Date());
      if (background) setAnnouncement("Delivery data refreshed.");
    } catch (error) {
      if (isAbortError(error)) return;
      const message = error instanceof Error ? error.message : "Could not load deliveries.";
      if (background && listRef.current) {
        setListStale(true);
      } else {
        setListError(message);
      }
    } finally {
      if (!controller.signal.aborted) {
        setListLoading(false);
        setLoadingMore(false);
      }
    }
  }, [status]);

  const loadDetail = useCallback(async (deliveryId: string, background = false) => {
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    if (!background) {
      setDetail(null);
      setDetailLoading(true);
      setDetailError(null);
      setDetailStale(false);
    }
    try {
      const response = await getDelivery(deliveryId, controller.signal);
      if (selectedIdRef.current !== deliveryId) return;
      setDetail(response);
      setDetailError(null);
      setDetailStale(false);
    } catch (error) {
      if (isAbortError(error)) return;
      const missing = error instanceof ApiError && error.status === 404;
      if (background && detailRef.current) {
        setDetailStale(true);
      } else {
        setDetailError({
          missing,
          message: missing
            ? "This delivery no longer exists or the URL is incorrect."
            : error instanceof Error
              ? error.message
              : "Could not load delivery details.",
        });
      }
    } finally {
      if (!controller.signal.aborted) setDetailLoading(false);
    }
  }, []);

  const loadReadiness = useCallback(async () => {
    readinessController.current?.abort();
    const controller = new AbortController();
    readinessController.current = controller;
    try {
      setReadiness(await getReadiness(controller.signal));
      setReadinessFailed(false);
    } catch (error) {
      if (!isAbortError(error)) setReadinessFailed(true);
    }
  }, []);

  useEffect(() => {
    setList(null);
    setListError(null);
    void loadList();
    return () => listController.current?.abort();
  }, [loadList]);

  useEffect(() => {
    if (!selectedId) {
      detailController.current?.abort();
      setDetail(null);
      setDetailError(null);
      setDetailStale(false);
      return;
    }
    void loadDetail(selectedId);
    return () => detailController.current?.abort();
  }, [selectedId, loadDetail]);

  useEffect(() => {
    void loadReadiness();
    return () => readinessController.current?.abort();
  }, [loadReadiness]);

  useEffect(() => {
    const refreshVisibleData = () => {
      if (document.visibilityState === "hidden") return;
      void loadList({ background: true });
      if (selectedIdRef.current) void loadDetail(selectedIdRef.current, true);
      void loadReadiness();
    };
    const interval = window.setInterval(refreshVisibleData, POLL_INTERVAL_MS);
    const visibilityHandler = () => {
      if (document.visibilityState === "visible") refreshVisibleData();
    };
    document.addEventListener("visibilitychange", visibilityHandler);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visibilityHandler);
    };
  }, [loadDetail, loadList, loadReadiness]);

  useEffect(() => {
    const handlePopState = () => {
      const next = currentUrlState();
      setStatus(next.status);
      setSelectedId(next.deliveryId);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const changeStatus = (nextStatus: DeliveryStatus | "") => {
    setStatus(nextStatus);
    updateUrl(selectedId, nextStatus);
  };

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([
      loadList({ background: Boolean(listRef.current) }),
      selectedIdRef.current
        ? loadDetail(selectedIdRef.current, Boolean(detailRef.current))
        : Promise.resolve(),
      loadReadiness(),
    ]);
    setRefreshing(false);
  };

  return {
    status,
    selectedId,
    search,
    setSearch,
    list,
    listLoading,
    loadingMore,
    listError,
    detail,
    detailLoading,
    detailError,
    readiness,
    readinessFailed,
    refreshing,
    lastRefresh,
    staleMessage,
    announcement,
    announce: setAnnouncement,
    selectDelivery,
    clearSelection,
    loadList,
    loadDetail,
    changeStatus,
    refresh,
  };
}
