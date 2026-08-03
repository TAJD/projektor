// Fixture stand-in for apps/web/src/islands/ui/Button.tsx (PROJ-527, Task
// 14 scaffold). Named export only — no default export, matching the real
// component's convention. Referenced by future import-boundary rules
// (Tasks 15-18), not implemented yet.
import type { ComponentChildren } from "preact";

export interface ButtonProps {
	children: ComponentChildren;
}

export function Button({ children }: ButtonProps) {
	return <button class="btn">{children}</button>;
}
