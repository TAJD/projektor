// PROJ-395: plain-language definitions for SDLC/PM jargon shown next to nav items and
// project tabs, for users unfamiliar with team-collaboration tooling. Same shape as
// metric-definitions.ts (PROJ-335) but a separate map — these terms describe app concepts,
// not computed metrics, so a shared "computation" field wouldn't apply.

export type GlossaryTermId = "sprint" | "epic" | "groups" | "tokens";

export interface GlossaryTerm {
	label: string;
	definition: string;
}

export const GLOSSARY_TERMS: Record<GlossaryTermId, GlossaryTerm> = {
	sprint: {
		label: "Sprint",
		definition:
			"A fixed time window (often 1-2 weeks) used to plan and track a batch of issues together.",
	},
	epic: {
		label: "Epic",
		definition: "A large body of work broken down into several smaller, related issues.",
	},
	groups: {
		label: "Groups",
		definition: "Teams of members that share the same project access permissions.",
	},
	tokens: {
		label: "Tokens",
		definition: "API keys that let external tools or AI agents act on your behalf.",
	},
};
