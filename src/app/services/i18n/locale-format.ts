/** Date and number formatting in a language, with one cached `Intl` formatter per language. */

export type DateStyle =
  'medium' | 'short' | 'compact' | 'date' | 'time' | 'timeShort' | 'clock' | 'clockMs';

const DATE_OPTIONS: Readonly<Record<DateStyle, Intl.DateTimeFormatOptions>> = {
  medium: { dateStyle: 'medium', timeStyle: 'medium' },
  short: { dateStyle: 'short', timeStyle: 'short' },
  compact: { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  date: { dateStyle: 'medium' },
  time: { timeStyle: 'medium' },
  timeShort: { timeStyle: 'short' },
  clock: { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' },
  clockMs: {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hourCycle: 'h23',
  },
};

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const numberFormatters = new Map<string, Intl.NumberFormat>();

function cached<T>(
  cache: Map<string, T>,
  key: string,
  create: (locale: string) => T,
  locale: string
): T {
  let formatter = cache.get(key);
  if (!formatter) {
    try {
      formatter = create(locale);
    } catch {
      formatter = create('en-US');
    }
    cache.set(key, formatter);
  }
  return formatter;
}

/** A date in the style of the language; an empty string for a missing or invalid date. */
export function formatDate(
  locale: string,
  value: Date | string | number | null | undefined,
  style: DateStyle = 'medium'
): string {
  if (value === null || value === undefined || value === '') return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return cached(
    dateFormatters,
    `${locale}|${style}`,
    tag => new Intl.DateTimeFormat(tag, DATE_OPTIONS[style]),
    locale
  ).format(date);
}

/** A number with the grouping and decimal separators of the language. */
export function formatNumber(
  locale: string,
  value: number,
  maxFractionDigits = 3,
  minFractionDigits = 0
): string {
  return cached(
    numberFormatters,
    `${locale}|${minFractionDigits}|${maxFractionDigits}`,
    tag =>
      new Intl.NumberFormat(tag, {
        minimumFractionDigits: minFractionDigits,
        maximumFractionDigits: maxFractionDigits,
      }),
    locale
  ).format(value);
}
