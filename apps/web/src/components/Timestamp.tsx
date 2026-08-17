import { exactDateTime, relativeDateTime } from "../utilities/format";

export function Timestamp({ value, relative = true }: { value: string | null; relative?: boolean }) {
  if (!value) return <span className="empty-value">—</span>;
  const exact = exactDateTime(value);
  return (
    <time dateTime={value} title={exact} className="timestamp">
      {relative ? <span>{relativeDateTime(value)}</span> : null}
      <span className={relative ? "timestamp-exact" : undefined}>{exact}</span>
    </time>
  );
}
