import type { ComponentChildren } from "preact";

export interface FieldProps {
	label: string;
	htmlFor: string;
	required?: boolean;
	help?: string;
	error?: string;
	class?: string;
	children: ComponentChildren;
}

export function Field({
	label,
	htmlFor,
	required,
	help,
	error,
	class: extraClass,
	children,
}: FieldProps) {
	const classes = ["mb-3", extraClass].filter(Boolean).join(" ");

	return (
		<div class={classes}>
			<label htmlFor={htmlFor} class="block mb-1 text-xs font-semibold text-text-muted">
				{label}
				{required && (
					<span aria-hidden="true" class="text-accent">
						{" "}
						*
					</span>
				)}
			</label>
			{children}
			{error ? (
				<p role="alert" class="mt-1 text-xs text-danger-text">
					{error}
				</p>
			) : (
				help && <p class="mt-1 text-xs text-text-muted">{help}</p>
			)}
		</div>
	);
}
