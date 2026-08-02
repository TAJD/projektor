import type { ComponentChildren, JSX } from "preact";

export interface ButtonProps {
	variant?: "primary" | "outline" | "danger";
	size?: "sm";
	as?: "button" | "span" | "a";
	href?: string;
	class?: string;
	style?: JSX.CSSProperties;
	type?: "button" | "submit";
	disabled?: boolean;
	title?: string;
	onClick?: (e: MouseEvent) => void;
	children: ComponentChildren;
	[key: `aria-${string}`]: string | boolean | undefined;
}

/**
 * Wraps Base.astro's `.btn` primitive. `variant` omitted renders the bare
 * `.btn` class (border:1px solid transparent, no fill) — used by icon-reset
 * buttons that layer their own utility classes on top via `class`.
 * `as="span"` renders a non-interactive `.btn`-styled label (e.g. a file
 * upload trigger wrapped in a `<label>`), matching existing hand-rolled
 * `<span class="btn ...">` usage. `as="a"` renders a `.btn`-styled link
 * (requires `href`), matching existing `<a class="btn ...">` usage (e.g.
 * SprintManager.tsx's "start sprint" link).
 */
export function Button({
	variant,
	size,
	as = "button",
	href,
	class: extraClass,
	style,
	type = "button",
	disabled,
	title,
	onClick,
	children,
	...rest
}: ButtonProps) {
	const classes = ["btn", variant && `btn-${variant}`, size === "sm" && "btn-sm", extraClass]
		.filter(Boolean)
		.join(" ");

	if (as === "span") {
		return (
			<span class={classes} style={style} title={title} {...rest}>
				{children}
			</span>
		);
	}

	if (as === "a") {
		if (!href) throw new Error("Button: `href` is required when as='a'");
		return (
			<a href={href} class={classes} style={style} title={title} {...rest}>
				{children}
			</a>
		);
	}

	return (
		<button
			type={type}
			class={classes}
			style={style}
			disabled={disabled}
			title={title}
			onClick={onClick}
			{...rest}
		>
			{children}
		</button>
	);
}
