import type { TaxConfig } from './config.js';
import type { PullRequest } from './github.js';
import { computeMetrics, type Metrics } from './metrics.js';
import { churnSubset, pullKey, type ChurnResult } from './churn.js';

export type Granularity = 'day' | 'week' | 'month';

export interface Period {
  /** ISO date of the first day in the bucket. */
  start: string;
  /** Short label for an axis, e.g. "6 Jan" or "Jan 26". */
  label: string;
  /** Unambiguous label for a tooltip, e.g. "Week of 6 Jan 2026". */
  full: string;
  prs: number;
  metrics: Metrics;
}

const MS_PER_DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Monday of the ISO week containing `d`, in UTC. */
function weekStart(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (x.getUTCDay() + 6) % 7; // Monday = 0
  x.setUTCDate(x.getUTCDate() - dow);
  return x;
}

const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

function nextBucket(d: Date, g: Granularity): Date {
  const x = new Date(d);
  if (g === 'day') x.setUTCDate(x.getUTCDate() + 1);
  else if (g === 'week') x.setUTCDate(x.getUTCDate() + 7);
  else x.setUTCMonth(x.getUTCMonth() + 1);
  return x;
}

const dayStart = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

const bucketStart = (d: Date, g: Granularity) =>
  g === 'day' ? dayStart(d) : g === 'week' ? weekStart(d) : monthStart(d);

export const labelFor = (d: Date, g: Granularity) =>
  g === 'month'
    ? `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`
    : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;

const FULL_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Says which day, which week, or which month - no guessing from an axis. */
export function fullLabelFor(d: Date, g: Granularity): string {
  const day = d.getUTCDate();
  const month = FULL_MONTHS[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  if (g === 'month') return `${month} ${year}`;
  if (g === 'week') return `Week of ${day} ${month} ${year}`;
  return `${DAYS[d.getUTCDay()]} ${day} ${month} ${year}`;
}

/**
 * Monthly for anything over four months, weekly below that. Weekly buckets on a
 * year of data give 52 points of mostly noise; monthly on six weeks gives two.
 */
export const defaultGranularity = (windowDays: number): Granularity =>
  windowDays > 120 ? 'month' : windowDays > 21 ? 'week' : 'day';

/**
 * Splits the window into periods and recomputes every metric inside each one.
 *
 * Churn is attributed to the pull request that WROTE the line, not the one that
 * deleted it, so a line added in March and removed in April counts against
 * March. That is why the churn result carries per-pull numbers.
 */
export function buildSeries(
  pulls: PullRequest[],
  cfg: TaxConfig,
  window: { since: Date; until: Date },
  repoCount: number,
  granularity: Granularity,
  churn?: ChurnResult
): Period[] {
  const buckets = new Map<number, PullRequest[]>();

  // Seed every bucket in range so quiet periods appear as zero, not as a gap.
  for (
    let d = bucketStart(window.since, granularity);
    +d < +window.until;
    d = nextBucket(d, granularity)
  ) {
    buckets.set(+d, []);
  }

  for (const p of pulls) {
    const key = +bucketStart(new Date(p.mergedAt), granularity);
    const list = buckets.get(key);
    if (list) list.push(p);
    else buckets.set(key, [p]);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ms, list]) => {
      const start = new Date(ms);
      const end = nextBucket(start, granularity);
      const sub = churn
        ? churnSubset(
            churn,
            list.map((p) => pullKey(p.repo, p.number))
          )
        : undefined;
      return {
        start: start.toISOString().slice(0, 10),
        label: labelFor(start, granularity),
        full: fullLabelFor(start, granularity),
        prs: list.length,
        metrics: computeMetrics(list, cfg, { since: start, until: end }, repoCount, sub)
      };
    });
}

export interface Trend {
  /** Mean over the first half of the periods, and over the second. */
  first: number | null;
  last: number | null;
  /** Fractional change, or null when the first half is zero or missing. */
  change: number | null;
}

/**
 * Compares the mean of the first half of the window with the second half.
 * Endpoint-to-endpoint comparisons on noisy weekly data say almost nothing;
 * half against half is far harder to fool with one bad week.
 */
export function trendOf(periods: Period[], pick: (m: Metrics) => number | null): Trend {
  const values = periods.map((p) => pick(p.metrics)).filter((v): v is number => v !== null);
  if (values.length < 2) return { first: null, last: null, change: null };

  const mid = Math.floor(values.length / 2);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const first = mean(values.slice(0, mid));
  const last = mean(values.slice(mid));

  return {
    first,
    last,
    change: first && last !== null ? (last - first) / Math.abs(first) : null
  };
}

export interface SeriesSpec {
  key: string;
  title: string;
  /** One or two lines on the same chart, e.g. p50 and p90. */
  lines: { name: string; pick: (m: Metrics) => number | null }[];
  /** How to render a value on the axis and in the summary. */
  format: 'count' | 'percent' | 'minutes' | 'lines' | 'ratio' | 'hours';
  /** Is an increase good or bad? Used to colour the trend. */
  better: 'lower' | 'higher' | 'neutral';
  note: string;
}

/** Everything the report charts, in the order it charts them. */
export const SERIES: SeriesSpec[] = [
  {
    key: 'prs',
    title: 'PRs merged',
    lines: [{ name: 'merged', pick: (m) => m.prsMerged }],
    format: 'count',
    better: 'neutral',
    note: 'Throughput. Context for everything below it.'
  },
  {
    key: 'cycle',
    title: 'PR cycle time',
    lines: [
      { name: 'p50', pick: (m) => m.cycleTimeP50 },
      { name: 'p90', pick: (m) => m.cycleTimeP90 }
    ],
    format: 'minutes',
    better: 'lower',
    note: 'Opened to merged. The p90 is the one people feel.'
  },
  {
    key: 'ttfr',
    title: 'Time to first review',
    lines: [
      { name: 'p50', pick: (m) => m.timeToFirstReviewP50 },
      { name: 'p90', pick: (m) => m.timeToFirstReviewP90 }
    ],
    format: 'minutes',
    better: 'lower',
    note: 'How long a PR waits before anyone looks.'
  },
  {
    key: 'tir',
    title: 'Time in review',
    lines: [
      { name: 'p50', pick: (m) => m.timeInReviewP50 },
      { name: 'p90', pick: (m) => m.timeInReviewP90 }
    ],
    format: 'minutes',
    better: 'lower',
    note: 'First review to merge.'
  },
  {
    key: 'unreviewed',
    title: 'Merged with no human review',
    lines: [{ name: '%', pick: (m) => m.pctMergedUnreviewed }],
    format: 'percent',
    better: 'lower',
    note: 'No coefficient involved. Straight from the reviews API.'
  },
  {
    key: 'churn',
    title: 'Rework rate',
    lines: [{ name: '%', pick: (m) => m.reworkRate }],
    format: 'percent',
    better: 'lower',
    note: 'Added lines a later PR deleted.'
  },
  {
    key: 'size',
    title: 'PR size',
    lines: [
      { name: 'p50', pick: (m) => m.prSizeP50 },
      { name: 'p90', pick: (m) => m.prSizeP90 }
    ],
    format: 'lines',
    better: 'lower',
    note: 'Lines changed. Big diffs are reviewed worse.'
  },
  {
    key: 'reviewers',
    title: 'Reviewers per reviewed PR',
    lines: [{ name: 'mean', pick: (m) => m.reviewsPerReviewedPr }],
    format: 'ratio',
    better: 'higher',
    note: 'How many people actually looked.'
  },
  {
    key: 'load',
    title: 'Busiest reviewer load',
    lines: [{ name: 'h/wk', pick: (m) => m.topDecileReviewHoursPerWeek }],
    format: 'hours',
    better: 'lower',
    note: 'Weekly review hours carried by the top decile.'
  },
  {
    key: 'engineers',
    title: 'Active engineers',
    lines: [{ name: 'authors', pick: (m) => m.engineers }],
    format: 'count',
    better: 'neutral',
    note: 'Distinct PR authors. Most other series scale with this.'
  }
];
