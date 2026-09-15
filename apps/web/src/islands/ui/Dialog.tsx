import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";

const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
	open: boolean;
	onClose: () => void;
	ariaLabel: string;
	class?: string;
	children: ComponentChildren;
}

export function Dialog({ open, onClose, ariaLabel, class: extraClass, children }: DialogProps) {
	const panelRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<Element | null>(null);

	useEffect(() => {
		if (!open) return;
		triggerRef.current = document.activeElement;
		const prevOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";

		const panel = panelRef.current;
		const focusable = panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
		(focusable ?? panel)?.focus();

		return () => {
			document.body.style.overflow = prevOverflow;
			if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
		};
	}, [open]);

	useEffect(() => {
		if (!open) return;
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.preventDefault();
				onClose();
				return;
			}
			if (e.key !== "Tab") return;
			const panel = panelRef.current;
			if (!panel) return;
			const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
			if (items.length === 0) {
				e.preventDefault();
				return;
			}
			const first = items[0];
			const last = items[items.length - 1];
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last?.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first?.focus();
			}
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [open, onClose]);

	if (!open) return null;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close
		// biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled globally above
		<div
			class="fixed inset-0 z-[120] flex items-start justify-center pt-12 bg-black/40 max-sm:items-end max-sm:pt-0"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				ref={panelRef}
				class={[
					"bg-bg border border-border rounded-lg p-6 w-full max-w-[480px] max-h-[80dvh]",
					"overflow-y-auto overscroll-contain mx-4 max-sm:rounded-t-lg max-sm:rounded-b-none",
					"max-sm:max-h-[90dvh] max-sm:mx-0 max-sm:pb-[max(1.5rem,env(safe-area-inset-bottom))]",
					extraClass,
				]
					.filter(Boolean)
					.join(" ")}
				role="dialog"
				aria-modal="true"
				aria-label={ariaLabel}
				tabIndex={-1}
			>
				{children}
			</div>
		</div>
	);
}
