# verification-tax

Reads your own GitHub history and prints what code review, rework and delay are
costing you. Runs on your machine. Sends nothing anywhere.

```bash
npx verification-tax --org your-org
```

No account, no OAuth app, no signup. It uses the GitHub token already in your
shell, writes an HTML report next to you, and exits.

## What it prints

```
  THE VERIFICATION TAX — acme, Sep 2025 – Sep 2026

  Engineers                               14
  PRs merged                           1,586
  PR cycle time, p50/p90          13m / 4.7d    opened to merged
  Time to first review, p50/p90   22m / 3.0d    938 reviewed PRs
  Merged with no human review          40.9%    648 PRs
  Added lines later deleted <21d       12.6%    71,193 of 565,840 lines
  Review load, busiest reviewer     5.1 h/wk    1 of 10 carry 31%
  PR size, p50 / p90              76 / 1,600    lines changed

  DEBITS

  Review hours consumed                   852 h/yr           €66,421
  Rework on already-merged code         1,158 h/yr           €90,324
                                                        ————————————
  NET                                                      −€156,745

  Every figure above rests on a coefficient you can argue with.
  This one does not:
  40.9% of merged pull requests had no human reviewer. 648 of them.
```

Plus `tax.html`: the same figures, every metric charted over time, and
breakdowns by pull request size, by repository and by person.

## Read this before you quote any euro figure

The first run writes `tax.config.json`. **Every coefficient in it is a
placeholder** — a plausible round number, not a measurement of your
organisation. Minutes per line of review, lines written per hour, the blended
hourly cost: all guesses you are meant to replace.

Trust the delta between two runs far more than any absolute figure, and trust
the counts — unreviewed rate, cycle time, PR size — more than either, because
no coefficient touches them.

## Usage

```
--org <name>            GitHub organisation or user. Required.
--since <YYYY-MM-DD>    Start of the window. Default: 365 days ago.
--until <YYYY-MM-DD>    End of the window. Default: today.
--baseline <a>..<b>     An earlier window to compare against. Required before
                        the tool will claim any authoring hours saved.
--churn <line|file>     How to measure rework. Default: line.
--series <week|month|off>  Bucket size for the trend charts.
--serve [port]          Local portal at http://127.0.0.1:7717 with selectable
                        periods and per-person charts.
--anonymise             Replace logins with "Engineer 1", "Engineer 2".
--json                  Machine-readable output.
--no-cache              Refetch instead of using the on-disk cache.
```

### The token

`GITHUB_TOKEN`, `GH_TOKEN`, or whatever `gh auth token` returns. It needs read
access to the organisation's repositories and nothing more. It is used to talk
to `api.github.com` and is never written to disk.

### What leaves your machine

Requests to `api.github.com`, and nothing else. No telemetry, no version check,
no crash reporting, no analytics.

It does read your diffs — that is the only way to tell a rewritten line from an
untouched one — and keeps the line numbers rather than the lines. `--churn file`
skips diffs entirely at the cost of a much cruder rework figure.

## Known limits

- **Review hours are inferred, not observed.** From diff size and reviewer
  count. Nobody is timed.
- **Churn is line-level but line numbers drift.** Intervening edits shift
  numbering, so individual attributions can be wrong in both directions.
- **Review away from GitHub is invisible.** Pairing, desk conversations and
  Slack threads are not counted, so teams that talk more than they comment are
  undercounted.
- **The authoring credit is the softest number here** and is not claimed at all
  without `--baseline`.
- **GitHub only.** GitLab and Bitbucket are not supported.
- **Below about ten engineers the numbers are noise.**

## Why the per-person table looks like that

It reports no lines written and no commit counts. Those measure typing, and
ranking people by them teaches a team to write longer diffs. What it reports is
load and blockage: who carries the review burden, whose work sits waiting, and
whether giving and receiving are balanced. A high wait time is something being
done to an engineer, not by them.

## Development

```bash
npm run build
npm test
```

79 tests, no framework dependency.

MIT.
