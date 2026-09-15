import type { ComponentChildren } from "preact";

export interface EmptyStateProps {
	title: string;
	description?: string;
	action?: ComponentChildren;
	icon?: ComponentChildren;
	class?: string;
}

export function EmptyState({
	title,
	description,
	action,
	icon,
	class: extraClass,
}: EmptyStateProps) {
	const classes = [
		"flex flex-col items-center justify-center gap-2 py-12 px-4 text-center",
		extraClass,
	]
		.filter(Boolean)
		.join(" ");

	return (
		<div class={classes}>
			{icon}
			<p class="text-sm font-medium text-text-base">{title}</p>
			{description && <p class="text-xs text-text-muted max-w-[28rem]">{description}</p>}
			{action && <div class="mt-2">{action}</div>}
		</div>
	);
}
