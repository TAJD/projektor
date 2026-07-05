// Heuristic definition-of-ready check (PROJ-253, spec: docs/design/agentic-workflow.md
// Phase 3). Deliberately a text heuristic over the existing body field, not a new
// structured schema — the epic's own child issues are already written this way, and a
// schema change would break every existing issue's readiness overnight.

export interface ReadinessCheck {
	ready: boolean;
	missing: string[];
}

// Does the line at `idx` in `lines` introduce a new section (so the section started at
// an earlier line has ended)? Matches a markdown heading or a bolded label line.
function isSectionBoundary(line: string): boolean {
	return /^#{1,6}\s/.test(line) || /^\*\*[A-Za-z][^*]*\*\*:?\s*$/.test(line);
}

// A section is "present" when its label line exists AND at least one non-blank line of
// real content follows before the next section boundary or the body ends.
function sectionHasContent(body: string, labelPattern: RegExp): boolean {
	const lines = body.split(/\r?\n/);
	const idx = lines.findIndex((l) => labelPattern.test(l));
	if (idx === -1) return false;

	for (let i = idx + 1; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === "") continue;
		if (isSectionBoundary(line)) break;
		return true;
	}
	return false;
}

export function checkDefinitionOfReady(body: string): ReadinessCheck {
	const missing: string[] = [];

	if (!sectionHasContent(body, /acceptance criteria/i)) {
		missing.push("acceptance criteria");
	}

	const hasScopeSection = sectionHasContent(body, /\b(scope|files?)\b/i);
	const hasInlineFilePath = /`[^`\n]+`/.test(body);
	if (!hasScopeSection && !hasInlineFilePath) {
		missing.push("scope/files");
	}

	if (!sectionHasContent(body, /verification/i)) {
		missing.push("verification");
	}

	return { ready: missing.length === 0, missing };
}
