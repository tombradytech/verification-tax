/**
 * Every value that was REPLACE-ME in the original mockup lives here.
 * Change it once, it changes everywhere.
 */
export const SITE = {
  /** Canonical origin, no trailing slash. Used for og:url, canonical, sitemap. */
  origin: 'https://REPLACE-ME.example',
  /** Bare domain, printed in the OG image and used as the Plausible site id. */
  domain: 'REPLACE-ME.example',
  /** GitHub repository, no trailing slash. */
  repo: 'https://github.com/REPLACE-ME/verification-tax',
  /** Name printed in the footer byline. */
  author: 'REPLACE-ME',
  /** Buttondown newsletter username. The API key is NEVER here - it is read
   *  from env.BUTTONDOWN_API_KEY inside the Pages Function. */
  buttondownUsername: 'REPLACE-ME',
  /** Turn analytics on once the domain is real. */
  analytics: true
} as const;

export const issuesUrl = `${SITE.repo}/issues`;

/** The command shown in the hero, and the one the copy button copies. */
export const HERO_CMD = 'npx verification-tax --org your-org --since 2024-09-01';
export const CLOSER_CMD = 'npx verification-tax --org your-org';
export const BENCH_CMD = 'npx verification-tax --org your-org --benchmark';

/** The twelve integers the --benchmark flag sends. Single source of truth for
 *  the chip list on the home page and the table on /benchmark. */
export const BENCHMARK_FIELDS = [
  ['engineers', 'Count of distinct PR authors in the window.'],
  ['prs_merged', 'Count of merged pull requests in the window.'],
  ['median_time_to_first_review', 'Minutes from PR open to first review comment.'],
  ['median_time_in_review', 'Minutes from first review to merge.'],
  ['pct_merged_unreviewed', 'Percentage merged with no human review, to one decimal.'],
  ['rework_rate', 'Percentage of merged lines changed again within 21 days.'],
  ['top_decile_review_hours', 'Weekly review hours carried by the busiest tenth.'],
  ['pr_size_p50', 'Median lines changed per pull request.'],
  ['pr_size_p90', '90th percentile lines changed per pull request.'],
  ['window_days', 'Length of the analysis window in days.'],
  ['repo_count', 'Number of repositories included.'],
  ['schema_version', 'Integer version of this payload shape.']
] as const;
