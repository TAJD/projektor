import type { ComponentChildren, JSX } from "preact";

export interface TableProps {
	class?: string;
	children: ComponentChildren;
}

export function Table({ class: extraClass, children }: TableProps) {
	const classes = ["w-full border-collapse text-[0.9rem]", extraClass].filter(Boolean).join(" ");
	return <table class={classes}>{children}</table>;
}

export interface TableHeadProps {
	children: ComponentChildren;
}

export function TableHead({ children }: TableHeadProps) {
	return <thead>{children}</thead>;
}

export interface TableBodyProps {
	children: ComponentChildren;
}

export function TableBody({ children }: TableBodyProps) {
	return <tbody>{children}</tbody>;
}

export interface TableRowProps extends JSX.HTMLAttributes<HTMLTableRowElement> {
	class?: string;
	children: ComponentChildren;
}

export function TableRow({ class: extraClass, children, ...rest }: TableRowProps) {
	return (
		<tr class={extraClass} {...rest}>
			{children}
		</tr>
	);
}

const TH_CLASS =
	"text-left px-3 py-2 border-b-2 border-border font-semibold text-text-base whitespace-nowrap";

export interface TableHeaderCellProps {
	class?: string;
	children?: ComponentChildren;
}

export function TableHeaderCell({ class: extraClass, children }: TableHeaderCellProps) {
	const classes = [TH_CLASS, extraClass].filter(Boolean).join(" ");
	return <th class={classes}>{children}</th>;
}

const TD_BASE = "px-3 py-2 border-b border-border align-middle [tr:last-child_&]:border-b-0";
const TD_MUTED = "font-mono text-[0.8rem] text-text-muted";

export interface TableCellProps {
	class?: string;
	muted?: boolean;
	children: ComponentChildren;
}

export function TableCell({ class: extraClass, muted, children }: TableCellProps) {
	const classes = [TD_BASE, muted && TD_MUTED, extraClass].filter(Boolean).join(" ");
	return <td class={classes}>{children}</td>;
}
