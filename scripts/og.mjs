/**
 * Generates site/public/og.png (1200x630) - a fragment of the sample terminal
 * output, which is the thing worth previewing. No logo.
 *
 * Committed to the repo so builds stay deterministic and offline.
 * Run: pnpm og
 */
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'site', 'public', 'og.png');

// satori cannot read woff2, so the OG script pulls TTFs straight from the
// upstream OFL repo. These are build-time only and never shipped to a browser.
const TTF = {
  mono400:
    'https://raw.githubusercontent.com/google/fonts/main/ofl/dmmono/DMMono-Regular.ttf',
  mono500: 'https://raw.githubusercontent.com/google/fonts/main/ofl/dmmono/DMMono-Medium.ttf'
};

const INK = '#F0F0EC';
const DIM = '#86868F';
const RED = '#E58072';
const GREEN = '#55B58C';
const BG = '#08080A';

/** Right-align `s` so it ends at column `col`, given the text so far. */
const pad = (soFar, col, s) => ' '.repeat(Math.max(1, col - soFar.length - s.length)) + s;

function row(label, hours, money, moneyColor = DIM) {
  let line = label;
  const withHours = line + pad(line, 46, hours);
  const withMoney = withHours + pad(withHours, 62, money);
  return [
    { t: label, c: INK },
    { t: withHours.slice(label.length), c: DIM },
    { t: withMoney.slice(withHours.length), c: moneyColor }
  ];
}

const RULE = ' '.repeat(50) + '—'.repeat(12);

const LINES = [
  [{ t: 'DEBITS', c: INK }],
  [],
  row('Review hours consumed', '18,940 h/yr', '€1,477,000'),
  row('Rework on already-merged code', '6,210 h/yr', '€  484,000'),
  row('Cost of delay, PRs over 5 days', '—', '€  212,000'),
  row('AI tooling spend', '—', '€  204,000'),
  [{ t: RULE, c: DIM }],
  [{ t: pad('', 62, '€2,377,000'), c: RED }],
  [],
  [{ t: 'CREDITS', c: INK }],
  [],
  row('Authoring hours saved', '21,300 h/yr', '€1,661,000', GREEN),
  [{ t: RULE, c: DIM }],
  [
    { t: 'NET', c: INK },
    { t: pad('NET', 62, '−€716,000'), c: RED }
  ]
];

const line = (spans) => ({
  type: 'div',
  props: {
    style: { display: 'flex', height: '30px' },
    children: spans.map((s) => ({
      type: 'span',
      props: {
        style: { color: s.c, whiteSpace: 'pre', fontWeight: s.c === INK ? 500 : 400 },
        children: s.t
      }
    }))
  }
});

const tree = {
  type: 'div',
  props: {
    style: {
      width: '1200px',
      height: '630px',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      background: BG,
      fontFamily: 'DM Mono',
      fontSize: '24px',
      padding: '46px 56px'
    },
    children: [
      {
        type: 'div',
        props: {
          style: { display: 'flex', fontSize: '20px', color: DIM },
          children: [
            { type: 'span', props: { style: { color: INK }, children: 'verification' } },
            { type: 'span', props: { style: { color: RED }, children: '-' } },
            { type: 'span', props: { style: { color: INK }, children: 'tax' } },
            {
              type: 'span',
              props: {
                style: { whiteSpace: 'pre' },
                children: '   THE VERIFICATION TAX — acme, 12 months'
              }
            }
          ]
        }
      },
      { type: 'div', props: { style: { display: 'flex', flexDirection: 'column' }, children: LINES.map(line) } },
      {
        type: 'div',
        props: {
          style: { display: 'flex', fontSize: '19px', color: DIM, whiteSpace: 'pre' },
          children: 'npx verification-tax --org your-org   ·   runs locally, sends nothing'
        }
      }
    ]
  }
};

const fetchFont = async (url) => Buffer.from(await fetch(url).then((r) => {
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.arrayBuffer();
}));

const [regular, medium] = await Promise.all([fetchFont(TTF.mono400), fetchFont(TTF.mono500)]);

const svg = await satori(tree, {
  width: 1200,
  height: 630,
  fonts: [
    { name: 'DM Mono', data: regular, weight: 400, style: 'normal' },
    { name: 'DM Mono', data: medium, weight: 500, style: 'normal' }
  ]
});

const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, png);
console.log(`og.png  ${(png.length / 1024).toFixed(1)} KB  1200x630`);
