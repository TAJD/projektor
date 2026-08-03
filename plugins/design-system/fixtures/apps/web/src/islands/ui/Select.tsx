// Fixture stand-in for apps/web/src/islands/ui/Select.tsx (PROJ-527, Task
// 14 scaffold). Default export only, matching the real component's
// convention (unlike Button, which is a named export). Referenced by
// future import-boundary rules (Tasks 15-18), not implemented yet.
export interface SelectOption {
	value: string;
	label: string;
}

export default function Select({ options }: { options: SelectOption[] }) {
	return (
		<select>
			{options.map((o) => (
				<option value={o.value}>{o.label}</option>
			))}
		</select>
	);
}
