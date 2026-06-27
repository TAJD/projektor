export function formatIssueRef(projectKey: string | null | undefined, number: number): string {
	return projectKey ? `${projectKey}-${number}` : String(number);
}

export function normalizeIssueRef(ref: string): string {
	return ref.trim().toUpperCase();
}

export function isValidIssueRef(ref: string): boolean {
	return /^[A-Z]+-\d+$/.test(ref);
}
