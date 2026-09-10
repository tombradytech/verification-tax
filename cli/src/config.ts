import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * The whole model lives here, in a file the user owns and edits.
 *
 * READ THIS BEFORE YOU BELIEVE ANY NUMBER THIS TOOL PRINTS.
 *
 * Every coefficient below is a PLACEHOLDER. They are plausible round numbers,
 * not measurements of your org, and not values lifted from a specific paper.
 * The published research (DORA, METR, GitClear, Faros) measures related things
 * under different definitions; none of it hands you a minutes-per-line constant.
 * So: treat these as a starting point to argue with, edit them, and rerun.
 */
export interface TaxConfig {
  $schema_version: number;
  $warning: string;

  /** Fully loaded cost of an engineer-hour, in your currency. */
  hourly_cost: number;
  currency: string;

  review: {
    /** Fixed minutes per reviewer per PR: opening it, paging in context. */
    context_switch_minutes: number;
    /** Minutes spent per line of diff, per reviewer, before diminishing returns. */
    minutes_per_line: number;
    /**
     * Reviewers skim large diffs rather than reading them linearly. Effective
     * lines reviewed = min(lines, soft_cap) + (lines - soft_cap) * tail_rate.
     */
    soft_cap_lines: number;
    tail_rate: number;
    /** Hard ceiling on attributed minutes per reviewer per PR. */
    max_minutes_per_reviewer: number;
  };

  rework: {
    /** A file touched again within this many days counts as rework. */
    window_days: number;
    /** Lines an engineer writes per hour, used to convert rework lines to hours. */
    lines_per_hour: number;
    /**
     * The churn signal is file-level, not line-level: it can tell you a file was
     * edited again, not which lines were rewritten. So most of the lines it flags
     * were not actually reworked. This is the fraction we assume genuinely were.
     *
     * It is a guess, and it is the single largest lever on the rework figure.
     * It sits here rather than hidden in the code precisely so you can argue
     * with it. Set it to 1.0 to charge every flagged line as rework.
     */
    attribution_rate: number;
  };

  delay: {
    /** PRs open longer than this are counted as delayed. */
    threshold_days: number;
    /**
     * Cost of one PR sitting idle for one extra day. This is the softest number
     * in the file - it is a stand-in for opportunity cost and has no defensible
     * universal value. Set it to 0 if you would rather not claim it at all.
     */
    cost_per_pr_per_day: number;
  };

  /** What you actually pay for AI tooling per year. The tool cannot know this. */
  ai_tooling_spend_per_year: number;

  authoring: {
    /**
     * Lines per engineer-hour when writing new code, used to convert a
     * throughput delta into hours saved. Only used when --baseline is given.
     */
    lines_per_hour: number;
  };

  /** Fraction each coefficient is varied by to produce the sensitivity range. */
  sensitivity: number;
}

export const DEFAULT_CONFIG: TaxConfig = {
  $schema_version: 1,
  $warning:
    'Every coefficient in this file is a placeholder, not a measurement. Edit them, rerun, and trust the delta between runs more than any absolute figure.',
  hourly_cost: 78,
  currency: 'EUR',
  review: {
    context_switch_minutes: 8,
    minutes_per_line: 0.2,
    soft_cap_lines: 400,
    tail_rate: 0.05,
    max_minutes_per_reviewer: 240
  },
  rework: { window_days: 21, lines_per_hour: 60, attribution_rate: 0.3 },
  delay: { threshold_days: 5, cost_per_pr_per_day: 0 },
  ai_tooling_spend_per_year: 0,
  authoring: { lines_per_hour: 60 },
  sensitivity: 0.4
};

export const CONFIG_FILE = 'tax.config.json';

/** Loads the config, creating it with documented defaults on first run. */
export async function loadConfig(cwd: string): Promise<{ config: TaxConfig; created: boolean }> {
  const path = resolve(cwd, CONFIG_FILE);
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<TaxConfig>;
    return { config: merge(DEFAULT_CONFIG, parsed), created: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await writeFile(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
    return { config: DEFAULT_CONFIG, created: true };
  }
}

/** Shallow-per-section merge so a partial config file still works. */
function merge(base: TaxConfig, over: Partial<TaxConfig>): TaxConfig {
  return {
    ...base,
    ...over,
    review: { ...base.review, ...(over.review ?? {}) },
    rework: { ...base.rework, ...(over.rework ?? {}) },
    delay: { ...base.delay, ...(over.delay ?? {}) },
    authoring: { ...base.authoring, ...(over.authoring ?? {}) }
  };
}
