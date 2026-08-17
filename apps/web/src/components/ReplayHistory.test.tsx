import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReplayHistory, buildReplayForest } from "./ReplayHistory";

const createdAt = "2026-08-16T10:00:00.000Z";
const original = { id: "D1", status: "dead_letter" as const, createdAt, replayedFromDeliveryId: null };
const left = { id: "D2", status: "dead_letter" as const, createdAt, replayedFromDeliveryId: "D1" };
const right = { id: "D3", status: "delivered" as const, createdAt, replayedFromDeliveryId: "D1" };
const grandchild = { id: "D4", status: "queued" as const, createdAt, replayedFromDeliveryId: "D2" };

describe("ReplayHistory", () => {
  it("preserves replay branches and immediate ancestry", () => {
    const forest = buildReplayForest([grandchild, right, original, left]);
    expect(forest).toHaveLength(1);
    expect(forest[0]?.id).toBe("D1");
    expect(forest[0]?.children.map((node) => node.id)).toEqual(["D2", "D3"]);
    expect(forest[0]?.children[0]?.children[0]?.id).toBe("D4");
  });

  it("names and selects every related delivery", () => {
    const onSelect = vi.fn();
    render(
      <ReplayHistory
        deliveries={[original, left, right, grandchild]}
        selectedId="D2"
        onSelect={onSelect}
      />,
    );
    expect(screen.getByRole("button", { name: /^Selected replay delivery D2, status dead letter/ })).toHaveAttribute("aria-current", "true");
    fireEvent.click(screen.getByRole("button", { name: /^Inspect replay delivery D3, status delivered/ }));
    expect(onSelect).toHaveBeenCalledWith("D3");
  });
});
