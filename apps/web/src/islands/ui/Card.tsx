import type { ComponentChildren, JSX } from "preact";

export interface CardProps {
	as?: "div" | "a";
	href?: string;
	interactive?: boolean;
	class?: string;
	style?: JSX.CSSProperties;
	children: ComponentChildren;
}

export function Card({
	as = "div",
	href,
	interactive,
	class: extraClass,
	style,
	children,
}: CardProps) {
	const classes = [
		"flex flex-col gap-2 p-4 bg-surface border border-border rounded-lg",
		as === "a" && "no-underline",
		interactive && "transition-all duration-150 hover:border-accent hover:-translate-y-px",
		extraClass,
	]
		.filter(Boolean)
		.join(" ");

	if (as === "a") {
		if (!href) throw new Error("Card: `href` is required when as='a'");
		return (
			<a href={href} class={classes} style={style}>
				{children}
			</a>
		);
	}

	return (
		<div class={classes} style={style}>
			{children}
		</div>
	);
}
