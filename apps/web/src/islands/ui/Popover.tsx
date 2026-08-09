import { type ComponentChildren, type Ref, render, type VNode } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";

/**
 * Manual compat-free portal (PROJ-552): `preact/compat`'s `createPortal`
 * installs global `options.vnode`/`options.event` patches that switch the
 * *entire app* to React-style event semantics, not just the importing
 * component — see LazyMarkdownEditor.tsx's PROJ-431 comment. Instead, each
 * instance renders into its own detached, never-inserted `container` (so
 * concurrent popovers never fight over a shared parentDom's diff tree —
 * `render()` keyed off the same real DOM parent would clobber siblings) and
 * only the resulting DOM node (`container.firstChild`) is moved into `into`,
 * keeping that node a direct child of `into` as callers rely on.
 */
function Portal({ into, vnode }: { into: Element; vnode: VNode }) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	if (!containerRef.current) containerRef.current = document.createElement("div");
	const container = containerRef.current;

	useLayoutEffect(() => {
		render(vnode, container);
		const node = container.firstChild;
		if (node && node.parentNode !== into) into.appendChild(node);
	});

	useLayoutEffect(() => {
		return () => {
			render(null, container);
		};
	}, [container]);

	return null;
}

export interface PopoverProps {
	id?: string;
	/** Omit both `role`/`ariaLabel` to render no ARIA attributes at all —
	 * needed when the caller's own children already declare the
	 * accessible role/name (e.g. AccountMenu's inner `role="menu"` div),
	 * so the popover wrapper doesn't create a second, conflicting
	 * landmark with the same accessible name. */
	role?: "dialog" | "menu" | "listbox";
	ariaLabel?: string;
	/** Only emitted when defined, independently of `role`/`ariaLabel` — needed
	 * by the non-modal toggletip contract (MetricHelp/GlossaryHelp render
	 * `role="dialog" aria-modal="false"`). */
	ariaModal?: boolean;
	/** Forwarded as `ref` on the rendered root element, in every strategy
	 * branch — needed by callers (AccountMenu, GlossaryHelp) that use it for
	 * outside-click-dismissal logic (a click inside the popover's own
	 * content must not count as "outside"). */
	elementRef?: Ref<HTMLElement>;
	/** Extra class(es) carrying usage-specific radius/padding/font-size/
	 * position — `.popover` alone only sets the properties genuinely
	 * shared across every current popover (background, border, shadow,
	 * z-index). */
	class?: string;
	/**
	 * "anchored" renders in place, positioned by the parent's own
	 * `position: relative` + the modifier class's own `position:
	 * absolute; top/left` rule. No current production caller uses it (see
	 * PROJ-607) — it's kept for a future toggletip that doesn't need to
	 * escape an ancestor's overflow/transform. "portal-fixed" portals to
	 * `document.body` with caller-computed fixed coordinates (matches
	 * `AccountMenu.tsx`/`GlossaryHelp.tsx`/`MetricHelp.tsx`'s existing
	 * pattern, needed to escape an ancestor's `transform`, e.g. the
	 * topbar's scroll-hide).
	 */
	strategy: "anchored" | "portal-fixed";
	/** Required when strategy is "portal-fixed". */
	position?: { top: number; left?: number; right?: number; width?: number };
	children: ComponentChildren;
}

export function Popover({
	id,
	role,
	ariaLabel,
	ariaModal,
	elementRef,
	class: extraClass,
	strategy,
	position,
	children,
}: PopoverProps) {
	const classes = extraClass ? `popover ${extraClass}` : "popover";
	const a11yProps = {
		...(role !== undefined ? { role } : {}),
		...(ariaLabel !== undefined ? { "aria-label": ariaLabel } : {}),
		...(ariaModal !== undefined
			? { "aria-modal": (ariaModal ? "true" : "false") as "true" | "false" }
			: {}),
	};
	if (strategy === "anchored") {
		return (
			<div id={id} class={classes} {...a11yProps} ref={elementRef as Ref<HTMLDivElement>}>
				{children}
			</div>
		);
	}

	if (!position) throw new Error("Popover: `position` is required when strategy is 'portal-fixed'");

	const style = {
		position: "fixed" as const,
		top: `${position.top}px`,
		...(position.left !== undefined ? { left: `${position.left}px` } : {}),
		...(position.right !== undefined ? { right: `${position.right}px` } : {}),
		...(position.width !== undefined ? { minWidth: `${position.width}px` } : {}),
	};

	const el = (
		<div
			id={id}
			class={classes}
			style={style}
			{...a11yProps}
			ref={elementRef as Ref<HTMLDivElement>}
		>
			{children}
		</div>
	);

	return <Portal into={document.body} vnode={el} />;
}
