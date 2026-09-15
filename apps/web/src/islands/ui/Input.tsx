import type { JSX } from "preact";

const BASE_CLASS =
	"w-full px-[0.625rem] py-[0.4rem] border border-border rounded text-[0.875rem] bg-bg text-text-base font-[inherit] focus:outline-[2px] focus:outline-accent focus:outline-offset-1 disabled:opacity-60 disabled:cursor-not-allowed";

export interface InputProps extends JSX.InputHTMLAttributes<HTMLInputElement> {
	class?: string;
}

export interface TextareaProps extends JSX.TextareaHTMLAttributes<HTMLTextAreaElement> {
	class?: string;
}

export function Input({ class: extraClass, ...rest }: InputProps) {
	const classes = [BASE_CLASS, extraClass].filter(Boolean).join(" ");
	return <input class={classes} {...rest} />;
}

export function Textarea({ class: extraClass, ...rest }: TextareaProps) {
	const classes = [BASE_CLASS, extraClass].filter(Boolean).join(" ");
	return <textarea class={classes} {...rest} />;
}
