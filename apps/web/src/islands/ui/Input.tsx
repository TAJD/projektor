import type { JSX, Ref } from "preact";

const BASE_CLASS =
	"w-full px-[0.625rem] py-[0.4rem] border border-border rounded text-[0.875rem] bg-bg text-text-base font-[inherit] focus:outline-[2px] focus:outline-accent focus:outline-offset-1 disabled:opacity-60 disabled:cursor-not-allowed";

export interface InputProps extends Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "ref"> {
	class?: string;
	inputRef?: Ref<HTMLInputElement>;
}

export interface TextareaProps
	extends Omit<JSX.TextareaHTMLAttributes<HTMLTextAreaElement>, "ref"> {
	class?: string;
	inputRef?: Ref<HTMLTextAreaElement>;
}

export function Input({ class: extraClass, inputRef, ...rest }: InputProps) {
	const classes = [BASE_CLASS, extraClass].filter(Boolean).join(" ");
	return <input ref={inputRef} class={classes} {...rest} />;
}

export function Textarea({ class: extraClass, inputRef, ...rest }: TextareaProps) {
	const classes = [BASE_CLASS, extraClass].filter(Boolean).join(" ");
	return <textarea ref={inputRef} class={classes} {...rest} />;
}
