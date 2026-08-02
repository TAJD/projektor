import type { ComponentChildren, JSX } from "preact";

export interface BadgeProps {
	class?: string;
	style?: JSX.CSSProperties;
	children: ComponentChildren;
}

/** Wraps Base.astro's `.badge` primitive. Color is always caller-supplied
 * via `style` (priority/status colors are computed per-issue, not static
 * variants) — matches every existing `.badge` call site. */
export function Badge({ class: extraClass, style, children }: BadgeProps) {
	const classes = extraClass ? `badge ${extraClass}` : "badge";
	return (
		<span class={classes} style={style}>
			{children}
		</span>
	);
}
