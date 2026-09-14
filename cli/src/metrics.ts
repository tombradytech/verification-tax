import type { TaxConfig } from './config.js';
import type { PullRequest } from './github.js';
import type { ChurnResult } from './churn.js';

export interface Metrics {
  engineers: number;
  prsMerged: number;
  repoCount: number;
  windowDays: number;

  /**
   * Minutes, p50 and p90. Null when no PR in the window received a human
   * review. p90 matters more than the median here: the median describes the
   * easy PRs, the p90 describes the ones people actually complain about.
   */
  timeToFirstReviewP50: number | null;
  timeToFirstReviewP90: number | null;
  timeInReviewP50: number | null;
  timeInReviewP90: number | null;
  reviewedCount: number;

  /**
   * Open to merge, for every merged PR including the unreviewed ones. This is
   * the number a delivery conversation is actually about.
   */
  cycleTimeP50: number;
  cycleTimeP90: number;

  unreviewedCount: number;
  pctMergedUnreviewed: number;

  /**
   * 'file' asks whether the file was touched again - cheap, but it saturates
   * over long windows. 'line' asks whether the specific lines were deleted.
   */
  churnMethod: 'file' | 'line';
  reworkRate: number;
  reworkedLines: number;
  totalLines: number;

  prSizeP50: number;
  prSizeP90: number;

  reviewMinutesTotal: number;
  /** Mean weekly review hours carried by the busiest tenth of reviewers. */
  topDecileReviewHoursPerWeek: number;
  topDecileReviewerCount: number;
  /** Share of all review hours those people carry, 0..1. */
  topDecileShare: number;
  reviewerCount: number;

  delayedPrCount: number;
  /** PR-days beyond the delay threshold, summed. */
  excessDelayDays: number;

  /** Mean human reviewers on the PRs that got any review. Explains review hours. */
  reviewsPerReviewedPr: number;

  filesTruncatedCount: number;
}

const MS_PER_MIN = 60_000;
const MS_PER_DAY = 86_400_000;

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

/** p50 and p90 of an unsorted list, sorted once. */
function pair(xs: number[]): [number, number] {
  const sorted = [...xs].sort((a, b) => a - b);
  return [quantile(sorted, 0.5), quantile(sorted, 0.9)];
}

/**
 * Minutes we attribute to one reviewer reading one diff.
 *
 * Linear in lines up to a soft cap, then much shallower - reviewers skim large
 * diffs rather than reading them line by line - then hard-capped. Every
 * constant comes from tax.config.json and every one of them is a placeholder.
 */
export function reviewMinutesPerReviewer(lines: number, cfg: TaxConfig['review']): number {
  const effective =
    lines <= cfg.soft_cap_lines
      ? lines
      : cfg.soft_cap_lines + (lines - cfg.soft_cap_lines) * cfg.tail_rate;
  const mins = cfg.context_switch_minutes + effective * cfg.minutes_per_line;
  return Math.min(mins, cfg.max_minutes_per_reviewer);
}

export function computeMetrics(
  pulls: PullRequest[],
  cfg: TaxConfig,
  window: { since: Date; until: Date },
  repoCount: number,
  /** When supplied, replaces the file-level churn proxy. */
  churn?: ChurnResult
): Metrics {
  const windowDays = Math.max(1, Math.round((+window.until - +window.since) / MS_PER_DAY));
  const weeks = windowDays / 7;

  const authors = new Set(pulls.map((p) => p.author).filter((a): a is string => !!a));

  const ttfr: number[] = [];
  const tir: number[] = [];
  const cycle: number[] = [];
  let unreviewed = 0;
  const sizes: number[] = [];
  const reviewMinutesBy = new Map<string, number>();
  let reviewMinutesTotal = 0;
  let delayedPrCount = 0;
  let excessDelayDays = 0;
  let filesTruncatedCount = 0;

  for (const p of pulls) {
    const lines = p.additions + p.deletions;
    sizes.push(lines);
    cycle.push((+new Date(p.mergedAt) - +new Date(p.createdAt)) / MS_PER_MIN);
    if (p.filesTruncated) filesTruncatedCount++;

    if (p.reviewers.length === 0) {
      unreviewed++;
    } else {
      const created = +new Date(p.createdAt);
      const first = +new Date(p.firstReviewAt!);
      const merged = +new Date(p.mergedAt);
      if (first >= created) ttfr.push((first - created) / MS_PER_MIN);
      if (merged >= first) tir.push((merged - first) / MS_PER_MIN);
    }

    const perReviewer = reviewMinutesPerReviewer(lines, cfg.review);
    for (const r of p.reviewers) {
      reviewMinutesBy.set(r, (reviewMinutesBy.get(r) ?? 0) + perReviewer);
      reviewMinutesTotal += perReviewer;
    }

    const openDays = (+new Date(p.mergedAt) - +new Date(p.createdAt)) / MS_PER_DAY;
    if (openDays > cfg.delay.threshold_days) {
      delayedPrCount++;
      excessDelayDays += openDays - cfg.delay.threshold_days;
    }
  }

  // --- Rework ---------------------------------------------------------------
  // For every file, the sorted list of (mergedAt, lines) it appeared in. A PR's
  // lines in a file count as reworked if that file is touched again by a later
  // PR within the rework window. This is a proxy: it is file-level, not
  // line-level, so it overstates churn in large or frequently-edited files.
  const touches = new Map<string, { at: number; lines: number }[]>();
  for (const p of pulls) {
    const at = +new Date(p.mergedAt);
    for (const f of p.files) {
      const list = touches.get(f.path);
      if (list) list.push({ at, lines: f.changes });
      else touches.set(f.path, [{ at, lines: f.changes }]);
    }
  }

  let reworkedLines = 0;
  let totalLines = 0;
  let reviewerTotal = 0;
  for (const p of pulls) reviewerTotal += p.reviewers.length;
  const reworkMs = cfg.rework.window_days * MS_PER_DAY;
  for (const list of touches.values()) {
    list.sort((a, b) => a.at - b.at);
    for (let i = 0; i < list.length; i++) {
      const cur = list[i]!;
      totalLines += cur.lines;
      const next = list[i + 1];
      if (next && next.at - cur.at <= reworkMs) reworkedLines += cur.lines;
    }
  }

  // --- Review load concentration -------------------------------------------
  const loads = [...reviewMinutesBy.values()].sort((a, b) => b - a);
  const decileSize = Math.max(1, Math.ceil(loads.length / 10));
  const topSlice = loads.slice(0, decileSize);
  const topMinutes = topSlice.reduce((a, b) => a + b, 0);

  const sortedSizes = [...sizes].sort((a, b) => a - b);

  return {
    engineers: authors.size,
    prsMerged: pulls.length,
    repoCount,
    windowDays,

    timeToFirstReviewP50: ttfr.length ? pair(ttfr)[0] : null,
    timeToFirstReviewP90: ttfr.length ? pair(ttfr)[1] : null,
    timeInReviewP50: tir.length ? pair(tir)[0] : null,
    timeInReviewP90: tir.length ? pair(tir)[1] : null,
    reviewedCount: pulls.length - unreviewed,

    cycleTimeP50: pair(cycle)[0],
    cycleTimeP90: pair(cycle)[1],

    unreviewedCount: unreviewed,
    pctMergedUnreviewed: pulls.length ? (unreviewed / pulls.length) * 100 : 0,

    churnMethod: churn ? 'line' : 'file',
    reworkRate: churn ? churn.rate : totalLines ? (reworkedLines / totalLines) * 100 : 0,
    reworkedLines: churn ? churn.reworkedLines : reworkedLines,
    totalLines: churn ? churn.addedLines : totalLines,

    prSizeP50: Math.round(quantile(sortedSizes, 0.5)),
    prSizeP90: Math.round(quantile(sortedSizes, 0.9)),

    reviewMinutesTotal,
    topDecileReviewHoursPerWeek: decileSize ? topMinutes / decileSize / 60 / weeks : 0,
    topDecileReviewerCount: loads.length ? decileSize : 0,
    topDecileShare: topMinutes && reviewMinutesTotal ? topMinutes / reviewMinutesTotal : 0,
    reviewerCount: loads.length,

    delayedPrCount,
    excessDelayDays,

    reviewsPerReviewedPr: pulls.length - unreviewed ? reviewerTotal / (pulls.length - unreviewed) : 0,

    filesTruncatedCount
  };
}
