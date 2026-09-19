#!/usr/bin/env node
/**
 * Derive the header's coffee icon from its source animation, into
 * src/assets/ (committed — CI never runs this). Rerun with a new
 * source:
 *
 *     node scripts/generate-coffee-icon.mjs path/to/source.gif
 *
 * The source is a 480px, 100-frame, 569 KB GIF — a takeaway cup on a
 * yellow disc — which is two orders of magnitude more than a 24px
 * header glyph should cost the app shell. Two files come out of it:
 *
 *   coffee.gif        48px (2× the 24px it is drawn at, for dense
 *                     screens), every frame kept, ~1/50th the bytes.
 *   coffee-still.png  the first frame alone, for anyone who has asked
 *                     their device for less motion — AppHeader serves
 *                     it through a <picture> source keyed on
 *                     `prefers-reduced-motion`, since a GIF cannot be
 *                     paused from CSS.
 *
 * The source itself is not committed: the derived pair is the asset.
 */
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const SIZE = 48;
const source = process.argv[2];
if (source === undefined) {
  console.error("usage: node scripts/generate-coffee-icon.mjs <source.gif>");
  process.exit(1);
}

const outDir = fileURLToPath(new URL("../src/assets/", import.meta.url));
await mkdir(outDir, { recursive: true });

// `animated: true` reads every page; the resize applies to each frame
// and the encoder writes them back out with their original delays.
// 32 colours, no dither: the art is three flat fills (yellow, navy,
// white) and anti-aliasing, so a small palette loses nothing a 24px
// glyph could show, and it roughly halves the file. `effort` is the
// encoder's own quality/speed dial; 10 is slowest and smallest, and
// this runs once.
await sharp(source, { animated: true })
  .resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .gif({ colours: 32, dither: 0, effort: 10 })
  .toFile(`${outDir}coffee.gif`);

// Page 0 only — the still.
await sharp(source, { animated: false })
  .resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile(`${outDir}coffee-still.png`);

console.log(`wrote ${outDir}coffee.gif and coffee-still.png at ${SIZE}px`);
