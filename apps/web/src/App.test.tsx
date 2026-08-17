import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import {
  ApiError,
  getDelivery,
  getReadiness,
  listDeliveries,
  replayDelivery,
  type DeliveryDetailResponse,
  type DeliveryListResponse,
  type DeliveryStatus,
  type ReplayResponse,
} from "./api/client";

vi.mock("./api/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("./api/client")>();
  return {
    ...original,
    getDelivery: vi.fn(),
    getReadiness: vi.fn(),
    listDeliveries: vi.fn(),
    replayDelivery: vi.fn(),
  };
});

const sourceId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const replayId = "33333333-3333-4333-8333-333333333333";
const eventId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const endpointId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const timestamp = "2026-08-16T10:00:00.000Z";

function summary(id: string, status: DeliveryStatus = "dead_letter") {
  return {
    id,
    status,
    attemptCount: status === "dead_letter" ? 5 : 1,
    nextAttemptAt: null,
    deliveredAt: status === "delivered" ? timestamp : null,
    replayedFromDeliveryId: id === replayId ? sourceId : null,
    createdAt: timestamp,
    event: { id: eventId, eventType: "order.created", createdAt: timestamp },
    endpoint: {
      id: endpointId,
      name: id === secondId ? "Long-haul warehouse destination" : "Warehouse",
      url: "https://receiver.example.test/webhook",
    },
  };
}

function listResponse(deliveries = [summary(sourceId), summary(secondId, "delivered")]): DeliveryListResponse {
  return { deliveries, page: { limit: 50, offset: 0, total: deliveries.length } };
}

function detailResponse(
  id = sourceId,
  status: DeliveryStatus = "dead_letter",
): DeliveryDetailResponse {
  return {
    delivery: {
      ...summary(id, status),
      event: {
        id: eventId,
        eventType: "order.created",
        createdAt: timestamp,
        payload: { orderId: 42, metadata: { priority: "high" } },
      },
    },
    attempts: status === "queued" ? [] : [
      {
        id: "attempt-1",
        attemptNumber: 1,
        startedAt: timestamp,
        completedAt: timestamp,
        responseStatus: status === "delivered" ? 200 : 500,
        latencyMs: 28,
        errorMessage: status === "delivered" ? null : "HTTP 500",
      },
    ],
    relatedDeliveries: [
      { id: sourceId, status: "dead_letter", createdAt: timestamp, replayedFromDeliveryId: null },
      ...(id === replayId
        ? [{ id: replayId, status, createdAt: "2026-08-16T10:05:00.000Z", replayedFromDeliveryId: sourceId } as const]
        : []),
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function configureDefaults() {
  vi.mocked(getReadiness).mockResolvedValue({
    status: "ready",
    dependencies: { postgres: { status: "up" }, redis: { status: "up" } },
  });
  vi.mocked(listDeliveries).mockResolvedValue(listResponse());
  vi.mocked(getDelivery).mockImplementation(async (id) =>
    id === replayId
      ? detailResponse(replayId, "queued")
      : id === secondId
        ? detailResponse(secondId, "delivered")
        : detailResponse(id),
  );
}

describe("delivery operations App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    window.history.replaceState({}, "", "/");
    configureDefaults();
  });

  it("shows an intentional loading state before rendering real delivery data", async () => {
    const pending = deferred<DeliveryListResponse>();
    vi.mocked(listDeliveries).mockReturnValueOnce(pending.promise);
    render(<App />);

    expect(screen.getByRole("heading", { name: "Loading delivery operations…" })).toBeInTheDocument();
    pending.resolve(listResponse());

    expect(await screen.findByRole("heading", { name: "Deliveries" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Inspect delivery ${sourceId}` })).toBeInTheDocument();
    expect(screen.getAllByLabelText(`Event ID ${eventId}`)[0]).toHaveTextContent(eventId);
    expect(screen.getByLabelText("Endpoint name Warehouse")).toHaveTextContent("Warehouse");
    expect(screen.getByText("Dependencies ready")).toBeInTheDocument();
  });

  it("renders empty data and provides a useful refresh action", async () => {
    vi.mocked(listDeliveries).mockResolvedValue(listResponse([]));
    render(<App />);

    expect(await screen.findByRole("heading", { name: "No deliveries yet" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh deliveries" })).toBeInTheDocument();
  });

  it("recovers from an initial API error without leaving a dead end", async () => {
    vi.mocked(listDeliveries)
      .mockRejectedValueOnce(new Error("API offline"))
      .mockResolvedValueOnce(listResponse());
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Delivery data is unavailable" })).toBeInTheDocument();
    expect(screen.getByText("API offline")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry loading deliveries" }));
    expect(await screen.findByRole("heading", { name: "Deliveries" })).toBeInTheDocument();
  });

  it("keeps last-known rows visible when a background refresh fails", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Deliveries" });
    vi.mocked(listDeliveries).mockRejectedValueOnce(new Error("temporary outage"));

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("Background refresh failed. Showing the last successful delivery data.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Inspect delivery ${sourceId}` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("does not clear a stale-detail warning when the concurrent list refresh succeeds", async () => {
    window.history.replaceState({}, "", `/?delivery=${sourceId}`);
    render(<App />);
    await screen.findByRole("heading", { name: /Delivery 11111111/ });

    const listRefresh = deferred<DeliveryListResponse>();
    vi.mocked(listDeliveries).mockReturnValueOnce(listRefresh.promise);
    vi.mocked(getDelivery).mockRejectedValueOnce(new Error("detail temporarily unavailable"));

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Background refresh failed. Showing the last successful delivery data.")).toBeInTheDocument();

    listRefresh.resolve(listResponse());
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
    expect(screen.getByText("Background refresh failed. Showing the last successful delivery data.")).toBeInTheDocument();
  });

  it("preserves all loaded pages across a background refresh", async () => {
    const deliveries = Array.from({ length: 150 }, (_, index) => {
      const serial = String(index + 1).padStart(12, "0");
      const id = `${serial.slice(0, 8)}-1111-4111-8111-${serial}`;
      return summary(id, "delivered");
    });
    vi.mocked(listDeliveries).mockImplementation(async (options = {}) => {
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 50;
      return {
        deliveries: deliveries.slice(offset, offset + limit),
        page: { limit, offset, total: deliveries.length },
      };
    });
    render(<App />);

    await screen.findByRole("button", { name: `Inspect delivery ${deliveries[49]!.id}` });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByRole("button", { name: `Inspect delivery ${deliveries[99]!.id}` });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByRole("button", { name: `Inspect delivery ${deliveries[149]!.id}` });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
    expect(screen.getByRole("button", { name: `Inspect delivery ${deliveries[149]!.id}` })).toBeInTheDocument();

    const calls = vi.mocked(listDeliveries).mock.calls;
    expect(calls[calls.length - 2]?.[0]).toEqual(expect.objectContaining({ limit: 100, offset: 0 }));
    expect(calls[calls.length - 1]?.[0]).toEqual(expect.objectContaining({ limit: 50, offset: 100 }));
  });

  it("shows detail loading and a recoverable unknown-delivery state", async () => {
    const missingId = "99999999-9999-4999-8999-999999999999";
    window.history.replaceState({}, "", `/?delivery=${missingId}`);
    const pending = deferred<DeliveryDetailResponse>();
    vi.mocked(getDelivery).mockReturnValueOnce(pending.promise);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Loading delivery…" })).toBeInTheDocument();
    pending.resolve(detailResponse(missingId));
    expect(await screen.findByRole("heading", { name: /Delivery 99999999/ })).toBeInTheDocument();
  });

  it("explains an unknown delivery selected from the URL", async () => {
    const missingId = "99999999-9999-4999-8999-999999999999";
    window.history.replaceState({}, "", `/?delivery=${missingId}`);
    vi.mocked(getDelivery).mockRejectedValue(new ApiError("Not found", 404, {}));
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Delivery not found" })).toBeInTheDocument();
    expect(screen.getByText(/URL is incorrect/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to deliveries" })).toBeInTheDocument();
  });

  it("filters by status, searches loaded records, and URL-selects a delivery", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Deliveries" });

    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), {
      target: { value: "dead_letter" },
    });
    await waitFor(() => {
      expect(vi.mocked(listDeliveries)).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "dead_letter" }),
      );
    });
    expect(window.location.search).toContain("status=dead_letter");

    fireEvent.change(screen.getByRole("searchbox", { name: "Find in loaded records" }), {
      target: { value: "does-not-exist" },
    });
    expect(screen.getByRole("heading", { name: "No loaded deliveries match" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

    fireEvent.click(screen.getByRole("button", { name: `Inspect delivery ${secondId}` }));
    expect(await screen.findByRole("heading", { name: /Delivery 22222222/ })).toBeInTheDocument();
    expect(window.location.search).toContain(`delivery=${secondId}`);
    expect(screen.queryByRole("button", { name: "Replay delivery" })).not.toBeInTheDocument();
  });

  it("copies the canonical event payload with accessible success feedback", async () => {
    window.history.replaceState({}, "", `/?delivery=${sourceId}`);
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    try {
      render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: "Copy event payload" }));

      await waitFor(() => expect(writeText).toHaveBeenCalledWith(JSON.stringify(
        { orderId: 42, metadata: { priority: "high" } },
        null,
        2,
      )));
      expect(screen.getByRole("button", { name: "Event payload copied" })).toHaveTextContent("Copied");
      expect(screen.getByText("Event payload copied.")).toHaveAttribute("role", "status");
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("moves focus into and back out of the responsive single-pane detail", async () => {
    const media = (query: string) => ({
      matches: query === "(max-width: 820px)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    }) as MediaQueryList;
    vi.stubGlobal("matchMedia", vi.fn(media));
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    try {
      render(<App />);
      const row = await screen.findByRole("button", { name: `Inspect delivery ${sourceId}` });
      fireEvent.click(row);

      const back = await screen.findByRole("button", { name: /Back to deliveries/ });
      await waitFor(() => expect(back).toHaveFocus());
      expect(scrollIntoView).toHaveBeenCalled();

      fireEvent.click(back);
      await waitFor(() => expect(row).toHaveFocus());
      expect(scrollTo).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      scrollTo.mockRestore();
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it("shows Replay only for dead letters and explains the confirmation", async () => {
    window.history.replaceState({}, "", `/?delivery=${sourceId}`);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Replay delivery" }));
    const dialog = screen.getByRole("dialog", { name: "Replay this dead letter?" });
    expect(dialog).toHaveTextContent("failed delivery and its attempt history will remain unchanged");
    expect(dialog).toHaveTextContent("fresh five-attempt budget");
    expect(screen.getByRole("button", { name: "Create replay delivery" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("prevents double submission and selects the new replay after success", async () => {
    window.history.replaceState({}, "", `/?delivery=${sourceId}`);
    const pending = deferred<ReplayResponse>();
    vi.mocked(replayDelivery).mockReturnValue(pending.promise);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Replay delivery" }));
    const confirm = screen.getByRole("button", { name: "Create replay delivery" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(vi.mocked(replayDelivery)).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Creating replay…" })).toBeDisabled();

    pending.resolve({
      sourceDelivery: { id: sourceId, status: "dead_letter" },
      replayDelivery: {
        id: replayId,
        eventId,
        endpointId,
        status: "queued",
        attemptCount: 0,
        nextAttemptAt: null,
        deliveredAt: null,
        replayedFromDeliveryId: sourceId,
        createdAt: timestamp,
      },
      reused: false,
      scheduled: true,
    });

    expect(await screen.findByRole("heading", { name: /Delivery 33333333/ })).toBeInTheDocument();
    expect(window.location.search).toContain(`delivery=${replayId}`);
    expect(sessionStorage.getItem("hookrelay.pending-replay")).toBeNull();
  });

  it("reuses one idempotency key after durable scheduling failure", async () => {
    window.history.replaceState({}, "", `/?delivery=${sourceId}`);
    const durableBody: ReplayResponse = {
      sourceDelivery: { id: sourceId, status: "dead_letter" },
      replayDelivery: {
        id: replayId,
        eventId,
        endpointId,
        status: "queued",
        attemptCount: 0,
        nextAttemptAt: null,
        deliveredAt: null,
        replayedFromDeliveryId: sourceId,
        createdAt: timestamp,
      },
      reused: false,
      scheduled: false,
      durableAccepted: true,
    };
    vi.mocked(replayDelivery)
      .mockRejectedValueOnce(new ApiError("Scheduling unavailable", 503, durableBody))
      .mockResolvedValueOnce({ ...durableBody, reused: true, scheduled: true });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Replay delivery" }));
    fireEvent.click(screen.getByRole("button", { name: "Create replay delivery" }));

    const retryDialog = await screen.findByRole("dialog", { name: "Retry queue scheduling" });
    expect(within(retryDialog).getByText("The replay was saved in PostgreSQL, but queue scheduling failed.")).toBeInTheDocument();
    expect(within(retryDialog).getByRole("button", { name: "Retry queue scheduling" })).toHaveFocus();
    expect(sessionStorage.getItem("hookrelay.pending-replay")).toContain(sourceId);
    fireEvent.click(screen.getByRole("button", { name: "Retry queue scheduling" }));

    await waitFor(() => expect(vi.mocked(replayDelivery)).toHaveBeenCalledTimes(2));
    const firstKey = vi.mocked(replayDelivery).mock.calls[0]?.[1];
    const secondKey = vi.mocked(replayDelivery).mock.calls[1]?.[1];
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBe(firstKey);
    expect(await screen.findByRole("heading", { name: /Delivery 33333333/ })).toBeInTheDocument();
  });

  it("retains and restores the same pending replay after a retry API error", async () => {
    window.history.replaceState({}, "", `/?delivery=${sourceId}`);
    const durableBody: ReplayResponse = {
      sourceDelivery: { id: sourceId, status: "dead_letter" },
      replayDelivery: {
        id: replayId,
        eventId,
        endpointId,
        status: "queued",
        attemptCount: 0,
        nextAttemptAt: null,
        deliveredAt: null,
        replayedFromDeliveryId: sourceId,
        createdAt: timestamp,
      },
      reused: false,
      scheduled: false,
      durableAccepted: true,
    };
    vi.mocked(replayDelivery)
      .mockRejectedValueOnce(new ApiError("Scheduling unavailable", 503, durableBody))
      .mockRejectedValueOnce(new ApiError("Gateway unavailable", 502, {}))
      .mockResolvedValueOnce({ ...durableBody, reused: true, scheduled: true });
    const view = render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Replay delivery" }));
    fireEvent.click(screen.getByRole("button", { name: "Create replay delivery" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry queue scheduling" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Gateway unavailable");
    const stored = sessionStorage.getItem("hookrelay.pending-replay");
    expect(stored).toContain(sourceId);
    const originalKey = vi.mocked(replayDelivery).mock.calls[0]?.[1];
    expect(vi.mocked(replayDelivery).mock.calls[1]?.[1]).toBe(originalKey);

    view.unmount();
    render(<App />);
    const restoredDialog = await screen.findByRole("dialog", { name: "Retry queue scheduling" });
    fireEvent.click(within(restoredDialog).getByRole("button", { name: "Retry queue scheduling" }));

    await waitFor(() => expect(vi.mocked(replayDelivery)).toHaveBeenCalledTimes(3));
    expect(vi.mocked(replayDelivery).mock.calls[2]?.[1]).toBe(originalKey);
    expect(await screen.findByRole("heading", { name: /Delivery 33333333/ })).toBeInTheDocument();
  });

  it("does not send or wedge a replay when session storage is unavailable", async () => {
    window.history.replaceState({}, "", `/?delivery=${sourceId}`);
    const storageSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Replay delivery" }));
    fireEvent.click(screen.getByRole("button", { name: "Create replay delivery" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("session storage is unavailable");
    expect(screen.getByRole("button", { name: "Create replay delivery" })).toBeEnabled();
    expect(vi.mocked(replayDelivery)).not.toHaveBeenCalled();
    storageSpy.mockRestore();
  });
});
