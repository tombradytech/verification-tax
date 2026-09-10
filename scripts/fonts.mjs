/**
 * Self-host the three faces. Pulls the *latin-only* woff2 that Google already
 * subsets (the latin unicode-range covers U+20AC euro and U+2212 minus, both of
 * which the copy uses), then writes them into site/public/fonts.
 *
 * Run: pnpm fonts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'site', 'public', 'fonts');

// A modern UA is required or Google serves ttf instead of woff2.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const FACES = [
  { file: 'instrument-serif-400.woff2', query: 'Instrument+Serif:ital@0', match: /font-style: normal/ },
  { file: 'instrument-serif-400-italic.woff2', query: 'Instrument+Serif:ital@1', match: /font-style: italic/ },
  { file: 'instrument-sans-var.woff2', query: 'Instrument+Sans:wght@400..700', match: /./ },
  { file: 'dm-mono-400.woff2', query: 'DM+Mono:wght@400', match: /./ },
  { file: 'dm-mono-500.woff2', query: 'DM+Mono:wght@500', match: /./ }
];

/** Pull the @font-face block whose unicode-range is plain `latin`. */
function latinBlock(css) {
  const blocks = css.split('/*').filter((b) => b.trimStart().startsWith('latin */'));
  if (!blocks.length) throw new Error('no latin block in css');
  return blocks[0];
}

await mkdir(OUT, { recursive: true });

for (const face of FACES) {
  const url = `https://fonts.googleapis.com/css2?family=${face.query}&display=swap`;
  const css = await fetch(url, { headers: { 'User-Agent': UA } }).then((r) => {
    if (!r.ok) throw new Error(`${face.query}: css ${r.status}`);
    return r.text();
  });

  const block = latinBlock(css);
  const src = block.match(/src: url\((https:[^)]+\.woff2)\)/);
  if (!src) throw new Error(`${face.file}: no woff2 url found`);

  const buf = Buffer.from(
    await fetch(src[1], { headers: { 'User-Agent': UA } }).then((r) => {
      if (!r.ok) throw new Error(`${face.file}: font ${r.status}`);
      return r.arrayBuffer();
    })
  );

  await writeFile(join(OUT, face.file), buf);
  console.log(`${face.file.padEnd(32)} ${(buf.length / 1024).toFixed(1)} KB`);
}
