// Heuristic definition-of-ready check (PROJ-253/291, spec: docs/design/agentic-workflow.md
// Phase 3). Deliberately a text heuristic over the existing body field, not a new
// structured schema — the epic's own child issues are already written this way, and a
// schema change would break every existing issue's readiness overnight.

export interface ReadinessCheck {
	ready: boolean;
	missing: string[];
}

// Does the line introduce a new section (so a section started earlier has ended)?
function isSectionBoundary(line: string): boolean {
	return /^#{1,6}\s/.test(line) || /^\*\*[A-Za-z][^*]*\*\*:?\s*$/.test(line);
}

function ci(source: string, flags: string): RegExp {
	return new RegExp(source, flags.includes("i") ? "i" : "");
}

// Is `line` a STRUCTURAL label line for `label` — a heading, a bold label, or a
// "Label:"-prefixed line — rather than prose that merely mentions the phrase
// (PROJ-291)? "## Scope / files", "**Acceptance criteria**", "Verification:" pass;
// "acceptance criteria are unclear" does not.
function isLabelLine(line: string, label: RegExp): boolean {
	const t = line.trim();
	const word = ci(`\\b(?:${label.source})\\b`, label.flags);

	const isHeading = /^#{1,6}\s+/.test(t);
	const isBold = /^\*\*[^*]+\*\*:?\s*$/.test(t) || /^[-*]\s+\*\*[^*]+\*\*/.test(t);
	if (isHeading || isBold) return word.test(t);

	// A plain line only counts when the label is a "Label:" prefix, not mid-sentence.
	const stripped = t.replace(/^[-*]\s+/, "");
	return ci(`^\\s*(?:${label.source})\\b[^:]*:`, label.flags).test(stripped);
}

// Non-empty content for `label`'s section: inline after a "Label:" or on a following
// non-blank line before the next section boundary.
function sectionHasContent(body: string, label: RegExp): boolean {
	const lines = body.split(/\r?\n/);
	const idx = lines.findIndex((l) => isLabelLine(l, label));
	if (idx === -1) return false;

	const inline = lines[idx]
		.replace(/^[#\-*\s]+/, "")
		.replace(/\*\*/g, "")
		.replace(/`/g, "");
	const afterColon = inline.includes(":") ? inline.slice(inline.indexOf(":") + 1).trim() : "";
	if (afterColon !== "") return true;

	for (let i = idx + 1; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === "") continue;
		if (isSectionBoundary(line)) break;
		return true;
	}
	return false;
}

// A path-shaped token inside an inline code span: contains a directory separator or a
// filename.ext. A lone span like `true` no longer satisfies "scope/files" (PROJ-291).
function hasFilePathToken(body: string): boolean {
	const spans = body.match(/`[^`\n]+`/g);
	if (!spans) return false;
	return spans.some((s) => {
		const inner = s.slice(1, -1).trim();
		return inner.includes("/") || /[\w-]+\.[a-z]{1,5}\b/i.test(inner);
	});
}

export function checkDefinitionOfReady(body: string): ReadinessCheck {
	const missing: string[] = [];

	if (!sectionHasContent(body, /acceptance criteria|\bAC\b/i)) {
		missing.push("acceptance criteria");
	}

	const hasScopeSection = sectionHasContent(body, /scope|files?/i);
	if (!hasScopeSection && !hasFilePathToken(body)) {
		missing.push("scope/files");
	}

	if (!sectionHasContent(body, /verification/i)) {
		missing.push("verification");
	}

	return { ready: missing.length === 0, missing };
}
