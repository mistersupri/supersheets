/**
 * Dates use the spreadsheet serial convention: whole days since 1899-12-30,
 * fractional part is the time of day. This matches XLSX files after 1900-03-01.
 */
const EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

export function dateToSerial(year: number, month: number, day: number): number {
  return (Date.UTC(year, month - 1, day) - EPOCH_MS) / DAY_MS;
}

export function jsDateToSerial(d: Date): number {
  return (d.getTime() - EPOCH_MS) / DAY_MS;
}

/** Serial for "now" in the local time zone of the machine evaluating. */
export function localNowSerial(now = new Date()): number {
  const utcLike = Date.UTC(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
  );
  return (utcLike - EPOCH_MS) / DAY_MS;
}

export interface DateParts {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
  weekday: number;
}

export function serialToParts(serial: number): DateParts {
  // Round to the nearest second to avoid 23:59:59.999 artefacts.
  const ms = Math.round((serial * DAY_MS) / 1000) * 1000 + EPOCH_MS;
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hours: d.getUTCHours(),
    minutes: d.getUTCMinutes(),
    seconds: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
  };
}

export function serialToJsDate(serial: number): Date {
  return new Date(Math.round(serial * DAY_MS) + EPOCH_MS);
}
