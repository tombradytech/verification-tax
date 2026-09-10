#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { CONFIG_FILE, loadConfig } from './config.js';
import { Github, cached, resolveToken, type PullRequest } from './github.js';
import { buildLedger, type Window } from './model.js';
import { renderTerminal } from './report/terminal.js';
import { renderHtml } from './report/html.js';
import { computeLineChurn, type ChurnResult, type PullDiff } from './churn.js';

const VERSION = '0.1.0';

const HELP = `
verification-tax ${VERSION}

  Reads your own GitHub history and prints what code review, rework and delay
  cost you. Runs locally. Sends nothing anywhere.

USAGE
  npx verification-tax --org <org> [options]

OPTIONS
  --org <name>            GitHub organisation to read. Required.
  --since <YYYY-MM-DD>    Start of the window. Default: 365 days ago.
  --until <YYYY-MM-DD>    End of the window. Default: today.
  --baseline <a>..<b>     A second, earlier window. Required before the tool
                          will claim any authoring hours saved, because
                          without a before-and-after there is nothing to
                          infer a saving from.
  --churn <line|file>     How to measure rework. Default: line.
                          'line' asks whether the specific lines you added were
                          later deleted. This is the real measurement. It reads
                          the diff of every merged PR, which costs one request
                          each, so it is the slow part of a first run.
                          'file' only asks whether a file was touched again. It
                          is much faster and reads no diffs, but it saturates
                          over long windows and drifts toward 100%, so treat it
                          as a rough upper bound rather than a figure to quote.
                          Neither mode transmits anything.
  --out <path>            HTML report path. Default: ./tax.html
  --no-cache              Ignore the on-disk cache and refetch.
  --json                  Emit machine-readable JSON on stdout instead.
  --version, --help

TOKEN
  Uses GITHUB_TOKEN or GH_TOKEN, falling back to \`gh auth token\`. It needs
  read access to the org's repositories and nothing more. The token is used
  to talk to api.github.com and is never written anywhere.

FIRST RUN
  Writes ${CONFIG_FILE} with the cost model in it. Every coefficient in that
  file is a placeholder, not a measurement of your org. Read it before you
  quote any figure this tool prints.
`;

interface Args {
  org?: string;
  since?: string;
  until?: string;
  baseline?: string;
  out: string;
  churn: 'file' | 'line';
  cache: boolean;
  json: boolean;
  help: boolean;
  version: boolean;
  benchmark: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    out: 'tax.html',
    churn: 'line',
    cache: true,
    json: false,
    help: false,
    version: false,
    benchmark: false
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${t} needs a value`);
      return v;
    };
    switch (t) {
      case '--org': a.org = next(); break;
      case '--since': a.since = next(); break;
      case '--until': a.until = next(); break;
      case '--baseline': a.baseline = next(); break;
      case '--out': a.out = next(); break;
      case '--churn': {
        const v = next();
        if (v !== 'file' && v !== 'line') throw new Error("--churn must be 'line' or 'file'");
        a.churn = v;
        break;
      }
      case '--no-cache': a.cache = false; break;
      case '--json': a.json = true; break;
      case '--benchmark': a.benchmark = true; break;
      case '-h': case '--help': a.help = true; break;
      case '-v': case '--version': a.version = true; break;
      default:
        throw new Error(`Unknown option: ${t}\nRun with --help.`);
    }
  }
  return a;
}

function parseDate(s: string, what: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${what} must be YYYY-MM-DD, got "${s}"`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(+d)) throw new Error(`${what} is not a real date: "${s}"`);
  return d;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const label = (w: Window) =>
  `${MONTHS[w.since.getUTCMonth()]} ${w.since.getUTCFullYear()} – ` +
  `${MONTHS[w.until.getUTCMonth()]} ${w.until.getUTCFullYear()}`;

/** Fetches every merged PR in a window, with progress on stderr. */
async function collect(
  gh: Github,
  org: string,
  window: Window,
  cwd: string,
  useCache: boolean,
  note: (s: string) => void
): Promise<{ pulls: PullRequest[]; repoCount: number; fromCache: boolean }> {
  const since = window.since.toISOString();
  const until = window.until.toISOString();
  // Date granularity, not millisecond: --until defaults to "now", and a key
  // containing the current timestamp would never match on a second run - which
  // would quietly defeat the caching the front page promises.
  const key = `v1:${org}:${since.slice(0, 10)}:${until.slice(0, 10)}`;

  let fromCache = true;
  const produce = async () => {
    fromCache = false;
    note(`  Listing repositories in ${org}...`);
    const repos = await gh.repos(org, since);
    if (!repos.length) {
      throw new Error(
        `No repositories in "${org}" were pushed to since ${since.slice(0, 10)}. ` +
          'Check the org name and the window.'
      );
    }
    const pulls: PullRequest[] = [];
    for (let i = 0; i < repos.length; i++) {
      const repo = repos[i]!;
      note(`  [${i + 1}/${repos.length}] ${repo}`);
      try {
        pulls.push(...(await gh.mergedPulls(org, repo, since, until)));
      } catch (err) {
        note(`      skipped: ${(err as Error).message}`);
      }
    }
    return { pulls, repoCount: repos.length };
  };

  const result = useCache ? await cached(cwd, key, produce) : await produce();
  return { ...result, fromCache: useCache && fromCache };
}

/**
 * Fetches every PR's diff, reduced to line ranges. One REST call per PR, so
 * this is the expensive path - eight at a time, with progress.
 */
async function collectDiffs(
  gh: Github,
  org: string,
  pulls: PullRequest[],
  note: (s: string) => void
): Promise<PullDiff[]> {
  const out: PullDiff[] = [];
  let done = 0;
  const queue = [...pulls];

  const worker = async () => {
    for (;;) {
      const p = queue.pop();
      if (!p) return;
      try {
        const files = await gh.pullDiffRanges(org, p.repo, p.number);
        out.push({ repo: p.repo, number: p.number, mergedAt: p.mergedAt, files });
      } catch (err) {
        note(`      ${p.repo}#${p.number}: ${(err as Error).message}`);
      }
      if (++done % 50 === 0 || done === pulls.length) {
        note(`  diffs ${done}/${pulls.length}`);
      }
    }
  };

  await Promise.all(Array.from({ length: 8 }, worker));
  return out;
}

const cachedIf = <T>(use: boolean, cwd: string, key: string, produce: () => Promise<T>) =>
  use ? cached(cwd, key, produce) : produce();

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) return void process.stdout.write(HELP);
  if (args.version) return void process.stdout.write(VERSION + '\n');

  if (args.benchmark) {
    throw new Error(
      'The --benchmark flag is not implemented yet. There is no aggregate endpoint to submit to,\n' +
        'and shipping a flag that silently does nothing would be worse than not having it.\n' +
        'Track it at https://github.com/tombradytech/verification-tax/issues'
    );
  }
  if (!args.org) throw new Error('--org is required. Run with --help.');

  const cwd = process.cwd();
  const note = (s: string) => process.stderr.write(s + '\n');

  const until = args.until ? parseDate(args.until, '--until') : new Date();
  const since = args.since
    ? parseDate(args.since, '--since')
    : new Date(+until - 365 * 86_400_000);
  if (+since >= +until) throw new Error('--since must be earlier than --until.');
  const window: Window = { since, until };

  let baseline: { pulls: PullRequest[]; window: Window; repoCount: number } | null = null;
  let baselineWindow: Window | null = null;
  if (args.baseline) {
    const [a, b] = args.baseline.split('..');
    if (!a || !b) throw new Error('--baseline must look like 2023-09-01..2024-09-01');
    baselineWindow = { since: parseDate(a, '--baseline start'), until: parseDate(b, '--baseline end') };
    if (+baselineWindow.since >= +baselineWindow.until) {
      throw new Error('--baseline start must be earlier than its end.');
    }
  }

  const { config, created } = await loadConfig(cwd);
  if (created) {
    note(`  Wrote ${CONFIG_FILE}. Every coefficient in it is a placeholder — read it.`);
  }

  const token = await resolveToken();
  const gh = new Github(token, note);

  const main = await collect(gh, args.org, window, cwd, args.cache, note);
  if (!main.pulls.length) {
    throw new Error(
      `Found no merged pull requests in ${args.org} between ` +
        `${since.toISOString().slice(0, 10)} and ${until.toISOString().slice(0, 10)}.`
    );
  }

  if (baselineWindow) {
    note('  Reading the baseline window...');
    const b = await collect(gh, args.org, baselineWindow, cwd, args.cache, note);
    baseline = { pulls: b.pulls, window: baselineWindow, repoCount: b.repoCount };
  }

  let churn: ChurnResult | undefined;
  if (args.churn === 'line') {
    note(`  Measuring line-level churn. This reads diffs (${main.pulls.length} requests).`);
    const diffs = await cachedIf(
      args.cache,
      cwd,
      `churn:v1:${args.org}:${since.toISOString().slice(0, 10)}:` +
        `${until.toISOString().slice(0, 10)}`,
      () => collectDiffs(gh, args.org!, main.pulls, note)
    );
    churn = computeLineChurn(diffs, config.rework.window_days);
  }

  const ledger = buildLedger(main.pulls, config, window, main.repoCount, baseline, churn);
  const outPath = resolve(cwd, args.out);
  const rel = (p: string) => './' + relative(cwd, p);

  await writeFile(
    outPath,
    renderHtml(ledger, config, {
      org: args.org,
      windowLabel: label(window),
      generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
      version: VERSION
    }),
    'utf8'
  );

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        { version: VERSION, org: args.org, window: { since, until }, ...ledger },
        null,
        2
      ) + '\n'
    );
    return;
  }

  process.stdout.write(
    renderTerminal(ledger, config, {
      org: args.org,
      windowLabel: label(window),
      reportPath: rel(outPath),
      configPath: './' + CONFIG_FILE,
      cached: main.fromCache
    })
  );
  note(`  ${gh.stats.calls} API calls.`);
}

main().catch((err: unknown) => {
  process.stderr.write('\n' + (err instanceof Error ? err.message : String(err)) + '\n\n');
  process.exit(1);
});
