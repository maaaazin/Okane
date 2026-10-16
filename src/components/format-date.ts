// One date format for every component, so the server render and the browser
// render give the same text. Fixed locale and timezone, built from numeric
// parts so differences between ICU versions cannot change the output.
const PARTS = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const p: Record<string, string> = {};
  for (const part of PARTS.formatToParts(date)) p[part.type] = part.value;
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second} IST`;
}
