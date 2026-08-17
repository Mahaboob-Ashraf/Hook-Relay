import type { ThemePreference } from "../hooks/useThemePreference";

function ThemeGlyph({ preference }: { preference: ThemePreference }) {
  if (preference === "light") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="3.25" />
        <path d="M10 1.5v2M10 16.5v2M1.5 10h2M16.5 10h2M4 4l1.4 1.4M14.6 14.6 16 16M16 4l-1.4 1.4M5.4 14.6 4 16" />
      </svg>
    );
  }
  if (preference === "dark") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M16.7 12.2A7 7 0 0 1 7.8 3.3 7 7 0 1 0 16.7 12.2Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="2.5" y="3.5" width="15" height="10.5" rx="1.8" />
      <path d="M7 17h6M10 14v3" />
    </svg>
  );
}

export function ThemeControl({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (preference: ThemePreference) => void;
}) {
  return (
    <label className="theme-control">
      <span className="theme-glyph"><ThemeGlyph preference={value} /></span>
      <span className="sr-only">Appearance</span>
      <select
        aria-label="Theme preference"
        value={value}
        onChange={(event) => onChange(event.target.value as ThemePreference)}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
