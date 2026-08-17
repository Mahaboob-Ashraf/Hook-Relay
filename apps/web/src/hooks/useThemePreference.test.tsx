import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeControl } from "../components/ThemeControl";
import {
  themeStorageKey,
  useThemePreference,
} from "./useThemePreference";

function createThemeMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    get matches() { return matches; },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
    setMatches(next: boolean) {
      matches = next;
      const event = { matches: next, media: this.media } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    },
  };
  return media as unknown as MediaQueryList & { setMatches: (next: boolean) => void };
}

function Harness() {
  const theme = useThemePreference();
  return <ThemeControl value={theme.preference} onChange={theme.setPreference} />;
}

describe("theme preference", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.themePreference;
  });

  afterEach(() => vi.unstubAllGlobals());

  it("defaults to System and follows operating-system theme changes", () => {
    const media = createThemeMedia(false);
    vi.stubGlobal("matchMedia", vi.fn(() => media));
    render(<Harness />);

    expect(screen.getByRole("combobox", { name: "Theme preference" })).toHaveValue("system");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");

    act(() => media.setMatches(true));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement).toHaveAttribute("data-theme-preference", "system");
  });

  it("supports Light and Dark and persists the explicit preference", () => {
    const media = createThemeMedia(false);
    vi.stubGlobal("matchMedia", vi.fn(() => media));
    const view = render(<Harness />);
    const select = screen.getByRole("combobox", { name: "Theme preference" });

    fireEvent.change(select, { target: { value: "dark" } });
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem(themeStorageKey)).toBe("dark");

    fireEvent.change(select, { target: { value: "light" } });
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(localStorage.getItem(themeStorageKey)).toBe("light");

    view.unmount();
    render(<Harness />);
    const restored = screen.getByRole("combobox", { name: "Theme preference" });
    expect(restored).toHaveValue("light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");

    fireEvent.change(restored, { target: { value: "system" } });
    expect(localStorage.getItem(themeStorageKey)).toBe("system");
    expect(document.documentElement).toHaveAttribute("data-theme-preference", "system");
  });
});
