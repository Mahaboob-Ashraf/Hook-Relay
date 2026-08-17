import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";

export const themeStorageKey = "hookrelay.theme";
export const systemThemeQuery = "(prefers-color-scheme: dark)";

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function readThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(themeStorageKey);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): "light" | "dark" {
  return preference === "system"
    ? systemPrefersDark ? "dark" : "light"
    : preference;
}

function applyTheme(preference: ThemePreference, systemPrefersDark: boolean): void {
  const resolved = resolveTheme(preference, systemPrefersDark);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = resolved;
}

export function useThemePreference() {
  const [preference, setPreferenceState] = useState<ThemePreference>(readThemePreference);

  useEffect(() => {
    const media = window.matchMedia?.(systemThemeQuery);
    const updateResolvedTheme = () => applyTheme(preference, media?.matches ?? false);
    updateResolvedTheme();

    if (preference !== "system") return;
    media?.addEventListener?.("change", updateResolvedTheme);
    return () => media?.removeEventListener?.("change", updateResolvedTheme);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(themeStorageKey, next);
    } catch {
      // The selection still applies for this session when storage is unavailable.
    }
  }, []);

  return { preference, setPreference };
}
