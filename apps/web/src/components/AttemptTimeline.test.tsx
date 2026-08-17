import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DeliveryAttempt } from "../api/client";
import { AttemptTimeline } from "./AttemptTimeline";

const timestamp = "2026-08-16T10:00:00.000Z";

function attempt(attemptNumber: number, values: Partial<DeliveryAttempt>): DeliveryAttempt {
  return {
    id: `attempt-${attemptNumber}`,
    attemptNumber,
    startedAt: timestamp,
    completedAt: timestamp,
    responseStatus: 200,
    latencyMs: 25,
    errorMessage: null,
    ...values,
  };
}

describe("AttemptTimeline", () => {
  it("distinguishes success, HTTP failure, transport failure, and an unknown outcome", () => {
    render(
      <AttemptTimeline
        deliveryStatus="dead_letter"
        nextAttemptAt={null}
        attempts={[
          attempt(1, {}),
          attempt(2, { responseStatus: 400, errorMessage: "HTTP 400" }),
          attempt(3, { responseStatus: null, errorMessage: "Network error: connection refused" }),
          attempt(4, { completedAt: null, responseStatus: null, latencyMs: null }),
        ]}
      />,
    );

    expect(screen.getByText("Delivered")).toBeInTheDocument();
    expect(screen.getAllByText("HTTP 400").length).toBeGreaterThan(0);
    expect(screen.getByText("Network error: connection refused")).toBeInTheDocument();
    expect(screen.getByText("Outcome unknown")).toBeInTheDocument();
    expect(screen.getByText(/never durably recorded the result/)).toBeInTheDocument();
  });

  it("renders a queued zero-attempt waiting state", () => {
    render(<AttemptTimeline attempts={[]} deliveryStatus="queued" nextAttemptAt={null} />);
    expect(screen.getByText("Waiting for the first attempt")).toBeInTheDocument();
    expect(screen.getByText(/queued for worker processing/)).toBeInTheDocument();
  });

  it("shows the durable next-attempt time when a retry is scheduled", () => {
    render(
      <AttemptTimeline
        attempts={[attempt(1, { responseStatus: 500, errorMessage: "HTTP 500" })]}
        deliveryStatus="retry_scheduled"
        nextAttemptAt="2026-08-16T10:01:00.000Z"
      />,
    );
    expect(screen.getByText("Retry scheduled")).toBeInTheDocument();
    expect(screen.getByText(/Next worker attempt/)).toBeInTheDocument();
  });

  it("connects recorded retries with a truthful derived elapsed time", () => {
    render(
      <AttemptTimeline
        attempts={[
          attempt(1, {
            completedAt: "2026-08-16T10:00:01.000Z",
            responseStatus: 500,
            errorMessage: "HTTP 500",
          }),
          attempt(2, {
            startedAt: "2026-08-16T10:00:06.000Z",
            completedAt: "2026-08-16T10:00:07.000Z",
          }),
        ]}
        deliveryStatus="delivered"
        nextAttemptAt={null}
      />,
    );

    expect(screen.getByText("Next attempt began 5s later")).toBeInTheDocument();
  });
});
