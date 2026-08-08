#!/usr/bin/env node
/**
 * Generate the PWA icon set into public/icons/ (committed — CI never
 * runs this). Rerun after changing the mark:
 *
 *     node scripts/generate-icons.mjs
 *
 * The mark is pure SVG shapes (no <text> — font rendering inside
 * librsvg is unreliable across platforms): an emerald tile with a
 * stroked open ring + bar reading as a "G".
 *
 * Variants:
 *   any       — rounded-corner tile (matches the app's 12px radius feel)
 *   maskable  — square full-bleed tile, mark shrunk into the 80% safe
 *               zone (the OS applies its own circle/squircle mask)
 *   apple     — square 180px (iOS rounds it itself)
 *   favicon   — 32/16 rounded tiles
 */
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const EMERALD = "#059669"; // emerald-600 — the app accent

function markSvg(size, { rounded, safe }) {
  const rx = rounded ? Math.round(size * 0.15) : 0;
  // Maskable safe zone: keep the mark inside the middle 80%.
  const scale = safe ? 0.8 : 1;
  const c = size / 2;
  const r = size * 0.26 * scale;
  const stroke = size * 0.11 * scale;
  const circumference = 2 * Math.PI * r;
  // Open the ring on the right-hand side (¼ gap), bar fills the gap.
  const dash = circumference * 0.78;
  const gap = circumference - dash;
  const barWidth = size * 0.26 * scale;
  const barHeight = stroke;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" rx="${rx}" fill="${EMERALD}"/>
  <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#ffffff"
          stroke-width="${stroke}" stroke-linecap="round"
          stroke-dasharray="${dash} ${gap}"
          transform="rotate(28 ${c} ${c})"/>
  <rect x="${c}" y="${c - barHeight / 2}" width="${barWidth}" height="${barHeight}"
        rx="${barHeight / 2}" fill="#ffffff"/>
</svg>`;
}

async function render(name, size, options) {
  await sharp(Buffer.from(markSvg(size, options)))
    .png()
    .toFile(fileURLToPath(new URL(`../public/icons/${name}`, import.meta.url)));
  console.log(`  icons/${name}`);
}

await mkdir(new URL("../public/icons/", import.meta.url), { recursive: true });

await render("icon-192.png", 192, { rounded: true, safe: false });
await render("icon-512.png", 512, { rounded: true, safe: false });
await render("icon-192-maskable.png", 192, { rounded: false, safe: true });
await render("icon-512-maskable.png", 512, { rounded: false, safe: true });
await render("apple-touch-icon.png", 180, { rounded: false, safe: false });
await render("favicon-32.png", 32, { rounded: true, safe: false });
await render("favicon-16.png", 16, { rounded: true, safe: false });

console.log("done");
