# Source fonts

Unmodified upstream font files used as input to the subsetting scripts in
`apps/web/scripts/`. Never edit these directly — re-fetch from upstream and re-run the
relevant script instead.

## MonaspaceNeon-Variable.woff2

- Upstream project: [Monaspace](https://github.com/githubnext/monaspace) by GitHub, Inc.
  ("Riley Cran and the Lettermatic Team", per the font's own `name` table).
- Font version embedded in the file: `1.400`.
- Licence: SIL Open Font License 1.1 — see `apps/web/public/fonts/OFL-MonaspaceNeon.txt`.
  The exact licence text isn't embedded in the font binary (only a one-line reference in
  the `name` table pointing at the upstream `LICENSE` file), so `OFL-MonaspaceNeon.txt`
  uses the standard SIL OFL 1.1 boilerplate (identical wording to `OFL-IBMPlexSans.txt`
  next to it) with the upstream copyright/Reserved-Font-Name line verbatim: `Copyright
  (c) 2023, GitHub https://github.com/githubnext/monaspace` with Reserved Font Name
  "Monaspace" (subfamilies "Argon", "Neon", "Xenon", "Radon", "Krypton"). If you have
  network access to the upstream repo, diff that file's `LICENSE` against this one to
  confirm they match verbatim.
- **Renamed on subset, not just resized**: the OFL forbids a Modified Version (this
  subset is one — different glyph set, narrowed axes) from using the Reserved Font Name
  "Monaspace". `apps/web/scripts/subset-monaspace.mjs` runs
  `apps/web/scripts/rename-font-names.py` as its last step, which renames the shipped
  font's family to "Projektor Mono" and scrubs every other name-table mention of
  "Monaspace" (see that script for the exact fields changed). The upstream attribution
  stays in `OFL-MonaspaceNeon.txt` above, which is what OFL condition 2 requires — it
  doesn't have to also be inside the renamed binary.
- Produced by `apps/web/scripts/subset-monaspace.mjs`, which reads this file and writes
  the subset to `apps/web/public/fonts/MonaspaceNeon-Variable.woff2`.
