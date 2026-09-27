#!/usr/bin/env node
// Reproducibly subsets Monaspace Neon (SIL OFL) down to what projektor's UI actually needs:
// Latin + Latin-1 + Latin Extended-A (accented names), general punctuation, and the
// box-drawing / block-element glyphs used by terminal-style output — with the variable
// weight axis narrowed to the range the UI actually uses (400–700) and the width/slant
// axes pinned to their defaults, since we never vary those in CSS.
//
// PROJ-861: the unsubset variable font is 510,832 B and downloads on every page even
// though only a few hundred code points ever render.
//
// Requires (not part of the JS toolchain — install once):
//   pip install --break-system-packages fonttools brotli
//
// Usage:
//   node apps/web/scripts/subset-monaspace.mjs
//
// Input:  apps/web/scripts/source-fonts/MonaspaceNeon-Variable.woff2 (the untouched
//         upstream variable font — see README.md next to it for provenance/version).
// Output: apps/web/public/fonts/MonaspaceNeon-Variable.woff2 (overwritten)

import { execFileSync } from 'node:child_process';
import { existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, 'source-fonts', 'MonaspaceNeon-Variable.woff2');
const OUTPUT = join(here, '..', 'public', 'fonts', 'MonaspaceNeon-Variable.woff2');
const BUDGET_BYTES = 60 * 1024;

// Basic Latin, Latin-1 Supplement, Latin Extended-A, General Punctuation, Arrows, Math
// Operators, Box Drawing, Block Elements, Geometric Shapes, plus a few individual
// symbols (currency, check/cross marks) UI chrome actually renders. Kept as a literal
// list (not a shorthand like "latin") so the exact scope is visible and reviewable here.
const UNICODES = [
  'U+0020-007E', // Basic Latin (printable)
  'U+00A0-00FF', // Latin-1 Supplement
  'U+0100-017F', // Latin Extended-A
  'U+20AC', // € Euro sign
  'U+2000-206F', // General Punctuation
  'U+2190-21FF', // Arrows
  'U+2200-22FF', // Mathematical Operators
  'U+2500-257F', // Box Drawing
  'U+2580-259F', // Block Elements
  'U+25A0-25FF', // Geometric Shapes
  'U+2713', // ✓ check mark
  'U+2715', // ✕ multiplication x
  'U+2717', // ✗ ballot x
].join(',');

// The UI only ever sets font-weight in the 400–700 range; narrowing the axis (rather than
// instancing to a single static weight) keeps font-weight: 400..700 working in CSS while
// dropping most of the gvar/avar deltas for weights nobody uses. Width and slant are never
// varied, so they're pinned to their defaults.
const AXIS_LIMITS = 'wght=400:700 wdth=100 slnt=0';

function run(cmd, args) {
  console.log(`+ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit' });
}

if (!existsSync(SOURCE)) {
  console.error(
    `subset-monaspace: source font not found at ${SOURCE}.\n` +
      'Place the untouched upstream Monaspace Neon variable woff2 there ' +
      '(see apps/web/scripts/source-fonts/README.md) and re-run.',
  );
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'monaspace-subset-'));
try {
  const instanced = join(tmp, 'instanced.woff2');
  const subset = join(tmp, 'subset.woff2');
  const renamed = join(tmp, 'renamed.woff2');

  // 1. Narrow the variable axes (fonttools varLib.instancer keeps it a variable font
  //    when a range, rather than a single point, is given for an axis).
  run('fonttools', [
    'varLib.instancer',
    '-o',
    instanced,
    SOURCE,
    ...AXIS_LIMITS.split(' '),
  ]);

  // 2. Subset glyphs to the unicode ranges above and strip unused tables/features.
  run('fonttools', [
    'subset',
    instanced,
    `--output-file=${subset}`,
    `--unicodes=${UNICODES}`,
    '--flavor=woff2',
    // No ligatures/stylistic sets: this font renders UI chrome and inline code, not a
    // programming-ligature editor surface, and dropping GSUB/GPOS buys back real KB.
    // Measured keeping just `calt` (texture healing) at ~62.8 KB with the current glyph
    // set — over the 60 KB budget — so it stays dropped; re-measure before re-adding it
    // if the unicode ranges above shrink again.
    '--layout-features=',
    '--glyph-names',
    '--symbol-cmap',
    '--legacy-cmap',
    '--notdef-glyph',
    '--notdef-outline',
    '--name-IDs=1,2,3,4,5,6,7,8,9,11,12,13,14,16,17',
    '--name-legacy',
    '--drop-tables=DSIG,GDEF,GSUB,STAT',
  ]);

  // 3. Rename away from the Reserved Font Name "Monaspace" (SIL OFL 1.1 forbids a
  //    Modified Version from using it) and scrub every other name-table mention of it —
  //    attribution lives in the sibling OFL-MonaspaceNeon.txt instead. See
  //    apps/web/scripts/rename-font-names.py for exactly what changes.
  run('python3', [
    join(here, 'rename-font-names.py'),
    subset,
    renamed,
  ]);

  const size = statSync(renamed).size;
  console.log(`subset-monaspace: output is ${size} B (budget ${BUDGET_BYTES} B)`);
  if (size > BUDGET_BYTES) {
    console.error(
      `subset-monaspace: FAIL — ${size} B exceeds the ${BUDGET_BYTES} B budget. ` +
        'Narrow AXIS_LIMITS or UNICODES further.',
    );
    process.exit(1);
  }

  execFileSync('cp', [renamed, OUTPUT]);
  console.log(`subset-monaspace: wrote ${OUTPUT}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
