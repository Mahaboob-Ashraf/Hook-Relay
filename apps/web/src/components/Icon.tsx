import type { ReactNode } from "react";

type IconName =
  | "arrow-left"
  | "arrow-right"
  | "check"
  | "copy"
  | "endpoint"
  | "filter"
  | "refresh"
  | "replay"
  | "search"
  | "webhook";

const paths: Record<IconName, ReactNode> = {
  "arrow-left": <path d="m12.5 5-5 5 5 5M8 10h9" />,
  "arrow-right": <path d="m11.5 5 5 5-5 5M16 10H7" />,
  check: <path d="m5.5 10 3 3 6-7" />,
  copy: <><rect x="7" y="7" width="9" height="9" rx="2" /><path d="M13 7V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h1" /></>,
  endpoint: <><path d="M7 5H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2M13 5h2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2" /><path d="M7 10h6M10 7v6" /></>,
  filter: <path d="M4 5h12l-4.5 5v4l-3 1.5V10L4 5Z" />,
  refresh: <><path d="M15.5 7A6 6 0 1 0 16 12" /><path d="M15.5 3v4h-4" /></>,
  replay: <><path d="M5 7.5A6 6 0 1 1 4.5 12" /><path d="M5 3.5v4H1" /></>,
  search: <><circle cx="8.5" cy="8.5" r="4.5" /><path d="m12 12 4 4" /></>,
  webhook: <><circle cx="4" cy="10" r="2" /><circle cx="16" cy="5" r="2" /><circle cx="16" cy="15" r="2" /><path d="M6 10h3.5a3 3 0 0 0 3-3M9.5 10a3 3 0 0 1 3 3" /></>,
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
