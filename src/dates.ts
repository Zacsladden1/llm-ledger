/** Calendar helpers in local timezone (YYYY-MM-DD). */

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function monthBounds(ref = new Date()): { start: string; end: string } {
  const start = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const end = new Date(ref.getFullYear(), ref.getMonth() + 1, 1);
  return { start: formatDate(start), end: formatDate(end) };
}

export function parseYearMonth(ym?: string): { start: string; end: string } {
  if (!ym) return monthBounds();
  const m = ym.match(/^(\d{4})-(\d{2})$/);
  if (!m) throw new Error(`Invalid month "${ym}"; expected YYYY-MM`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`Invalid month "${ym}"`);
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);
  return { start: formatDate(start), end: formatDate(end) };
}
