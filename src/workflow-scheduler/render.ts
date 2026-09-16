/**
 * Shared text-table rendering for scheduler commands.
 *
 * `install` and `status` both print aligned tables of the same shape, and a
 * second copy of the width calculation is how two tables in one CLI drift into
 * two conventions.
 */

export const renderTable = (
  rows: ReadonlyArray<ReadonlyArray<string>>,
  header: ReadonlyArray<string>,
): string => {
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const format = (cells: ReadonlyArray<string>): string =>
    cells.map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 0)).join("  ");
  return [format(header), format(widths.map((width) => "-".repeat(width))), ...rows.map(format)].join("\n");
};

/**
 * Relative time in either direction.
 *
 * A "next due" value is in the future and a heartbeat is in the past, so a
 * one-directional age would render an upcoming occurrence as a negative number
 * of seconds ago — which reads as a bug in the schedule rather than as a time.
 */
export const relativeTime = (iso: string | null): string => {
  if (iso === null) return "never";
  const deltaMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(deltaMs)) return iso;
  const seconds = Math.round(Math.abs(deltaMs) / 1000);
  const unit = seconds < 60
    ? `${seconds}s`
    : seconds < 3_600
      ? `${Math.round(seconds / 60)}m`
      : `${Math.round(seconds / 3_600)}h`;
  return deltaMs >= 0 ? `${unit} ago` : `in ${unit}`;
};
