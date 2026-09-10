# verification-tax

The launch site for the `verification-tax` CLI. Static Astro, no client framework,
no cookies, no consent banner.

```
site/                  Astro project (the website)
functions/api/         Cloudflare Pages Function: POST /api/subscribe
scripts/fonts.mjs      Re-fetch and self-host the three faces
scripts/og.mjs         Regenerate the 1200x630 Open Graph image
pnpm-workspace.yaml    Room for the CLI to land alongside as `cli/` later
```

## Running it

Needs Node 20+ (see `.nvmrc`) and pnpm.

```bash
pnpm install
pnpm dev        # http://localhost:4321
pnpm build      # -> site/dist
pnpm preview
```

## Filling in the placeholders

Everything that was `REPLACE-ME` in the original mockup lives in one file:
[`site/src/config.ts`](site/src/config.ts). Set `origin`, `domain`, `repo`,
`author` and `buttondownUsername` there and the whole site updates. The
copyright line in `LICENSE` is the only other place a name appears.

## Deploying to Cloudflare Pages

Connect the GitHub repo once in the Cloudflare dashboard, then every push to
`main` deploys and every branch gets a preview URL.

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Build command | `pnpm install --frozen-lockfile && pnpm build` |
| Build output directory | `site/dist` |
| Root directory | *(leave blank — repo root)* |

Then add two environment variables under **Settings → Environment variables**:

| Name | Value | Notes |
| --- | --- | --- |
| `BUTTONDOWN_API_KEY` | your key | Mark it **Encrypt**. Never commit it. |
| `NODE_VERSION` | `20` | Or later. |

`functions/api/subscribe.ts` is picked up automatically because it sits in
`functions/` at the repo root. Nothing else needs configuring.

## The email form

`POST /api/subscribe` proxies to Buttondown so the API key stays server-side.
It returns 2xx **only** when Buttondown confirms the write. Every other outcome
is a 4xx/5xx, and the page shows a failure rather than a fake success — with
JavaScript on it reveals an error message, with JavaScript off it lands on
`/subscribe-failed`. If you change this file, keep that property.

## Analytics

Plausible, loaded from `plausible.io`, unproxied on purpose. No cookies, no
local storage, nothing that needs a consent banner. It records page views,
referrers, and one custom event (`copy_command`) when someone clicks a Copy
button. Set `analytics: false` in `site/src/config.ts` to remove it entirely.

## Fonts

Instrument Serif, Instrument Sans and DM Mono, all SIL OFL, self-hosted as
Latin-subset woff2 in `site/public/fonts` (~76 KB for all five faces). They are
committed. Run `pnpm fonts` only if you need to re-fetch them.

## Open Graph image

`site/public/og.png` is committed so builds are deterministic and offline.
Regenerate with `pnpm og` after changing the sample figures.
