// Pure logic for scripts/bundle-budget.ts (PROJ-841), split out for unit testing without
// a real apps/web/dist build — see apps/web/src/test/bundle-budget-ratchet.test.ts.

export interface BudgetGroup {
  [stableName: string]: number; // gzip bytes
}

export interface Budget {
  initial: BudgetGroup;
  lazy: BudgetGroup;
}

export interface RatchetOptions {
  /** Fractional tolerance, e.g. 0.02 for 2%. */
  toleranceRatio: number;
  /** Absolute tolerance in bytes, e.g. 1024 for 1 KB. */
  toleranceBytes: number;
}

export type Verdict =
  | 'ok'
  | 'new-lazy'
  | 'new-eager-no-baseline'
  | 'grew'
  | 'shrank'
  | 'shrank-past-tolerance'
  | 'removed';

export interface ChunkDelta {
  name: string;
  group: 'initial' | 'lazy';
  baselineBytes: number | null;
  currentBytes: number | null;
  deltaBytes: number;
  verdict: Verdict;
}

/**
 * Strips a built chunk's content hash to get a name stable across builds.
 * rolldown/vite emit `<Name>.<hash>.<ext>` (e.g. `IssueList.BX52gRWz.js` ->
 * `IssueList.js`) or `chunk-<id>.<hash>.<ext>` for anonymous shared chunks (e.g.
 * `chunk-Y2CYZVJY.DsF7k-Jl.js` -> `chunk-Y2CYZVJY.js`). The latter's remaining prefix
 * is only as stable as rolldown's own internal chunk id, which is a known, accepted
 * limitation for wholly-anonymous vendor chunks (the same limitation any gzip-size-diff
 * tool has) — named application chunks (islands, mermaid diagrams, etc.) are unaffected.
 */
export function stableChunkName(fileName: string): string {
  const parts = fileName.split('.');
  if (parts.length < 3) return fileName; // no hash segment to strip — leave as-is
  const ext = parts[parts.length - 1];
  return `${parts.slice(0, -2).join('.')}.${ext}`;
}

/**
 * Collapses a build's {fileName -> gzipBytes} map into {stableName -> gzipBytes},
 * summing when two physical chunks happen to share a stable name (rare, but keeps the
 * budget honest rather than silently dropping one).
 */
export function toStableSizes(fileSizes: Record<string, number>): BudgetGroup {
  const out: BudgetGroup = {};
  for (const [file, size] of Object.entries(fileSizes)) {
    const name = stableChunkName(file);
    out[name] = (out[name] ?? 0) + size;
  }
  return out;
}

function allowedGrowth(baselineBytes: number, options: RatchetOptions): number {
  return Math.max(baselineBytes * options.toleranceRatio, options.toleranceBytes);
}

/**
 * Compares a group ('initial' or 'lazy') of the current build's stable sizes against the
 * baseline's, per the ratchet rule: fail if a chunk grew by more than `tolerance` over
 * baseline, or a new chunk appeared in the 'initial' group with no baseline entry at all
 * (lazy chunks are allowed to appear fresh — mermaid gaining a new diagram type, say —
 * since they never load on the initial page view).
 *
 * A chunk that *shrank* by more than the same tolerance never fails — that's a win — but
 * it usually means the baseline itself is stale (the chunk was split up, a dependency was
 * dropped, etc.), so it gets its own 'shrank-past-tolerance' verdict: a warning, not a
 * failure, pointing whoever reads the output at `--update` (see isWarningDelta below).
 *
 * There is deliberately no "override" escape hatch here (PROJ-841 review): this step also
 * runs on `workflow_call` from release.yml, where there is no PR to carry a label, so a
 * label-driven override would leave main permanently over budget. The only way to accept
 * growth is `--update` plus committing the new baseline, which shows up in the PR diff.
 */
export function diffGroup(
  group: 'initial' | 'lazy',
  baseline: BudgetGroup,
  current: BudgetGroup,
  options: RatchetOptions,
): ChunkDelta[] {
  const names = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  const deltas: ChunkDelta[] = [];
  for (const name of names) {
    const baselineBytes = baseline[name] ?? null;
    const currentBytes = current[name] ?? null;

    if (currentBytes === null) {
      deltas.push({ name, group, baselineBytes, currentBytes, deltaBytes: 0, verdict: 'removed' });
      continue;
    }
    if (baselineBytes === null) {
      const verdict: Verdict = group === 'initial' ? 'new-eager-no-baseline' : 'new-lazy';
      deltas.push({ name, group, baselineBytes, currentBytes, deltaBytes: currentBytes, verdict });
      continue;
    }
    const deltaBytes = currentBytes - baselineBytes;
    if (deltaBytes === 0) {
      deltas.push({ name, group, baselineBytes, currentBytes, deltaBytes, verdict: 'ok' });
      continue;
    }
    if (deltaBytes < 0) {
      const allowedShrink = allowedGrowth(baselineBytes, options);
      const verdict: Verdict = -deltaBytes > allowedShrink ? 'shrank-past-tolerance' : 'shrank';
      deltas.push({ name, group, baselineBytes, currentBytes, deltaBytes, verdict });
      continue;
    }
    const allowed = allowedGrowth(baselineBytes, options);
    const verdict: Verdict = deltaBytes > allowed ? 'grew' : 'ok';
    deltas.push({ name, group, baselineBytes, currentBytes, deltaBytes, verdict });
  }
  return deltas.sort((a, b) => a.name.localeCompare(b.name));
}

export function isFailingDelta(delta: ChunkDelta): boolean {
  return delta.verdict === 'grew' || delta.verdict === 'new-eager-no-baseline';
}

/** A chunk that shrank by more than the tolerance — not a failure, but likely means the
 * baseline is stale and should be refreshed with `--update`. */
export function isWarningDelta(delta: ChunkDelta): boolean {
  return delta.verdict === 'shrank-past-tolerance';
}

export function formatDeltaLine(d: ChunkDelta): string {
  const kib = (n: number) => `${(n / 1024).toFixed(2)} KiB`;
  switch (d.verdict) {
    case 'new-eager-no-baseline':
      return `NEW (no baseline, initial load): ${d.name} = ${kib(d.currentBytes!)}`;
    case 'new-lazy':
      return `new (lazy): ${d.name} = ${kib(d.currentBytes!)}`;
    case 'removed':
      return `removed: ${d.name} (was ${kib(d.baselineBytes!)})`;
    case 'grew':
      return `GREW: ${d.name} ${kib(d.baselineBytes!)} -> ${kib(d.currentBytes!)} (+${kib(d.deltaBytes)})`;
    case 'shrank':
      return `shrank: ${d.name} ${kib(d.baselineBytes!)} -> ${kib(d.currentBytes!)} (${kib(d.deltaBytes)})`;
    case 'shrank-past-tolerance':
      return (
        `WARN — shrank a lot: ${d.name} ${kib(d.baselineBytes!)} -> ${kib(d.currentBytes!)} ` +
        `(${kib(d.deltaBytes)}); baseline may be stale, consider re-running with --update`
      );
    default:
      return `ok: ${d.name} = ${kib(d.currentBytes!)}`;
  }
}

/** Renders only chunks with something to report — unchanged ('ok') chunks are omitted
 * for a readable PR summary; `unchangedCount` is still reported as a one-line footnote. */
export function markdownSummary(deltas: ChunkDelta[]): string {
  const notable = deltas.filter((d) => d.verdict !== 'ok');
  const unchangedCount = deltas.length - notable.length;
  const lines = [
    '| Group | Chunk | Baseline | Current | Δ | Status |',
    '| --- | --- | ---: | ---: | ---: | --- |',
  ];
  const kib = (n: number | null) => (n === null ? '—' : `${(n / 1024).toFixed(2)} KiB`);
  for (const d of notable) {
    const status =
      d.verdict === 'grew'
        ? '❌ grew'
        : d.verdict === 'new-eager-no-baseline'
          ? '❌ new, no baseline'
          : d.verdict === 'new-lazy'
            ? '🆕 new (lazy)'
            : d.verdict === 'removed'
              ? '🗑️ removed'
              : d.verdict === 'shrank-past-tolerance'
                ? '⚠️ shrank a lot — check `--update`'
                : d.verdict === 'shrank'
                  ? '✅ shrank'
                  : '✅ ok';
    lines.push(
      `| ${d.group} | \`${d.name}\` | ${kib(d.baselineBytes)} | ${kib(d.currentBytes)} | ${
        d.currentBytes === null ? '—' : `${d.deltaBytes >= 0 ? '+' : ''}${(d.deltaBytes / 1024).toFixed(2)} KiB`
      } | ${status} |`,
    );
  }
  if (unchangedCount > 0) {
    lines.push(`\n_${unchangedCount} unchanged chunk(s) omitted._`);
  }
  return lines.join('\n');
}
