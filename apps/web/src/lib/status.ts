export function statusDisplayName(
	statusName: string | null | undefined,
	statusKey: string | null | undefined
): string {
	return statusName ?? statusKey ?? "—";
}
