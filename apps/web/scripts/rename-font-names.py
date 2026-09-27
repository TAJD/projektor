#!/usr/bin/env python3
"""Rewrites the `name` table of a subset Monaspace Neon font so it no longer uses the
Reserved Font Name "Monaspace" (SIL OFL 1.1 forbids a Modified Version from using it),
and no longer mentions "Monaspace" anywhere in the binary's metadata at all.

Attribution to the original Monaspace project is kept in the sibling text file
(apps/web/public/fonts/OFL-MonaspaceNeon.txt) instead, which satisfies OFL condition 2
("stand-alone text file... or machine-readable metadata") without requiring the
Reserved Name to appear in the renamed font's own name table.

Usage: rename-font-names.py <in.woff2> <out.woff2>
"""

import sys

from fontTools.ttLib import TTFont

FAMILY = "Projektor Mono"
SUBFAMILY = "Regular"
POSTSCRIPT = "ProjektorMono-Regular"
VERSION = "Version 1.400"
UNIQUE_ID = f"{VERSION};PROJEKTOR;{POSTSCRIPT}"
COPYRIGHT = (
    "Subset of an SIL Open Font License font. See the accompanying licence text "
    "file next to this font for full attribution and license terms."
)
LICENSE_DESCRIPTION = "SIL Open Font License 1.1 — see http://scripts.sil.org/OFL"

# nameID -> fixed value. Covers the ids the review asked to rename (1, 3, 4, 6, 16, 17)
# plus every other id that could otherwise still carry "Monaspace" text (2, 5, 7, 13).
REPLACEMENTS = {
    1: FAMILY,
    2: SUBFAMILY,
    3: UNIQUE_ID,
    4: FAMILY,
    5: VERSION,
    6: POSTSCRIPT,
    7: COPYRIGHT,
    13: LICENSE_DESCRIPTION,
    16: FAMILY,
    17: SUBFAMILY,
}


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    src, dst = sys.argv[1], sys.argv[2]

    font = TTFont(src)
    name = font["name"]

    for name_id, value in REPLACEMENTS.items():
        # setName replaces every existing record for this nameID across all
        # platform/encoding/language entries actually present in the table, rather than
        # assuming Windows-only — some woff2 tools keep a Mac (platformID 1) copy too.
        existing = [r for r in name.names if r.nameID == name_id]
        if not existing:
            continue
        for rec in existing:
            name.setName(value, name_id, rec.platformID, rec.platEncID, rec.langID)

    # fvar's named instances (weight/width/style combinations like "SemiWide Bold") keep
    # their own name-table records (id >= 256) referencing "MonaspaceNeonVar-*", which
    # aren't in REPLACEMENTS above since there's one per instance, not a fixed id. Scrub
    # any of those still carrying the reserved name generically instead of listing each
    # instance id by hand.
    for rec in name.names:
        if rec.nameID in REPLACEMENTS:
            continue
        text = rec.toUnicode()
        if "monaspace" not in text.lower():
            continue
        cleaned = (
            text.replace("MonaspaceNeonVar", "ProjektorMono")
            .replace("Monaspace Neon Var", "Projektor Mono")
            .replace("Monaspace", "Projektor")
            .replace("monaspace", "projektor")
        )
        name.setName(cleaned, rec.nameID, rec.platformID, rec.platEncID, rec.langID)

    # Belt-and-suspenders: fail loudly if anything still slipped through, rather than
    # silently shipping a font that still trips the OFL Reserved Font Name restriction.
    offenders = [
        (r.nameID, r.toUnicode())
        for r in name.names
        if "monaspace" in r.toUnicode().lower()
    ]
    if offenders:
        print(f"rename-font-names: FAIL — still found 'Monaspace' in: {offenders}", file=sys.stderr)
        sys.exit(1)

    font.save(dst)


if __name__ == "__main__":
    main()
