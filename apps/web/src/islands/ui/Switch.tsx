import { useId } from "preact/hooks";

export interface SwitchProps {
	checked: boolean;
	onChange: (checked: boolean) => void;
	label: string;
	disabled?: boolean;
	class?: string;
}

/**
 * An on/off control whose change takes effect immediately (NN/g: use a switch, not a
 * checkbox, for instant binary settings like "Show archived"). The whole pill — track
 * and label — is one ≥24px-tall button (WCAG 2.5.8), exposed as `role="switch"`.
 * Styles: `.switch*` in components.css.
 */
export function Switch({ checked, onChange, label, disabled, class: extraClass }: SwitchProps) {
	const labelId = useId();
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-labelledby={labelId}
			disabled={disabled}
			class={extraClass ? `switch ${extraClass}` : "switch"}
			onClick={() => onChange(!checked)}
		>
			<span class="switch-track" aria-hidden="true">
				<span class="switch-thumb" />
			</span>
			<span id={labelId}>{label}</span>
		</button>
	);
}
