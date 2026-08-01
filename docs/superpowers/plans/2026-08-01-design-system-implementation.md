# Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Componentize `apps/web`'s existing `.btn`/`.badge`/`.select-*`/popover CSS primitives into real `islands/ui/` components, migrate every call site to them (88 `.btn`/`.badge` occurrences across 15 files, plus 2 popover call sites, plus 10 files with raw color literals), and add a `plugins/design-system` cofferdam plugin that fails the build on future drift.

**Architecture:** Four new Preact components (`Button`, `Badge`, `Popover`, `Select`) in `apps/web/src/islands/ui/`, each a thin wrapper around CSS classes/tokens already defined in `apps/web/src/layouts/Base.astro` — no new visual design. Every current call site of the underlying classes migrates to import the component instead. A new `plugins/design-system` cofferdam plugin (TypeScript, `@cofferdam/check-sdk`, following the existing `plugins/island-api` pattern exactly) enforces the convention going forward with four line-scan rules.

**Tech Stack:** Preact (islands), Astro (`Base.astro` global CSS), `@cofferdam/check-sdk` (`defineCheck`), vitest (existing `*.test.tsx` pattern), `cofferdam check` (fixture regression via `scripts/check-fixture.mjs`).

## Global Constraints

- No new visual design — every component must render the exact same DOM class names / computed styles the call site had before migration. Existing `*.test.tsx` files (which assert on rendered class names/roles/text) are the regression guard — if a test breaks, the component's output changed and that's a bug in the migration, not the test.
- Codebase uses Preact's `class` attribute (not React's `className`) throughout — new components follow the same convention.
- New cofferdam plugin follows `plugins/island-api`'s exact structure: `package.json` (`@projektor/cofferdam-design-system`, `@cofferdam/check-sdk` dependency), `tsconfig.json` (identical compiler options), `cofferdam.toml` (local fixture config, `plugins = ["./"]`), `fixtures/` directory, `scripts/check-fixture.mjs`, `expected.json`.
- Cofferdam check severity: `High`, no baseline (per PROJ-527 acceptance criteria — `cofferdam check` must report zero `DesignSystemConvention` findings once migration is complete).
- `MetricsDashboard.tsx` and `apps/web/src/islands/metrics/flow-charts.tsx` keep their `readThemeColor()` hex fallbacks as-is (legitimate: canvas can't read CSS custom properties) — these get inline `// cofferdam-ignore: DesignSystemConvention` comments, not code changes.
- bestefforttools is out of scope for this plan entirely.

---

## Component API reference (used by every later task)

### `Button` — `apps/web/src/islands/ui/Button.tsx`

```tsx
import type { JSX, ComponentChildren } from "preact";

export interface ButtonProps {
	variant?: "primary" | "outline" | "danger";
	size?: "sm";
	as?: "button" | "span";
	class?: string;
	style?: JSX.CSSProperties;
	type?: "button" | "submit";
	disabled?: boolean;
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
 * `<span class="btn ...">` usage.
 */
export function Button({
	variant,
	size,
	as = "button",
	class: extraClass,
	style,
	type = "button",
	disabled,
	onClick,
	children,
	...rest
}: ButtonProps) {
	const classes = [
		"btn",
		variant && `btn-${variant}`,
		size === "sm" && "btn-sm",
		extraClass,
	]
		.filter(Boolean)
		.join(" ");

	if (as === "span") {
		return (
			<span class={classes} style={style} {...rest}>
				{children}
			</span>
		);
	}

	return (
		<button type={type} class={classes} style={style} disabled={disabled} onClick={onClick} {...rest}>
			{children}
		</button>
	);
}
```

### `Badge` — `apps/web/src/islands/ui/Badge.tsx`

```tsx
import type { JSX, ComponentChildren } from "preact";

export interface BadgeProps {
	class?: string;
	style?: JSX.CSSProperties;
	children: ComponentChildren;
}

/** Wraps Base.astro's `.badge` primitive. Color is always caller-supplied
 * via `style` (priority/status colors are computed per-issue, not static
 * variants) — matches every existing `.badge` call site. */
export function Badge({ class: extraClass, style, children }: BadgeProps) {
	const classes = extraClass ? `badge ${extraClass}` : "badge";
	return (
		<span class={classes} style={style}>
			{children}
		</span>
	);
}
```

### `Popover` — `apps/web/src/islands/ui/Popover.tsx`

```tsx
import type { ComponentChildren } from "preact";
import { createPortal } from "preact/compat";

export interface PopoverProps {
	id?: string;
	role?: "dialog" | "menu";
	ariaLabel?: string;
	/** Extra class(es) carrying usage-specific radius/padding/font-size —
	 * `.popover` alone only sets the properties genuinely shared across
	 * every current popover (background, border, shadow, z-index). */
	class?: string;
	/**
	 * "anchored" renders in place, positioned by the parent's own
	 * `position: relative` + the modifier class's own `top`/`left` rule
	 * (matches `.metric-help-popover`'s existing CSS). "portal-fixed"
	 * portals to `document.body` with caller-computed fixed coordinates
	 * (matches `AccountMenu`'s existing pattern, needed to escape the
	 * topbar's scroll-hide `transform`).
	 */
	strategy: "anchored" | "portal-fixed";
	/** Required when strategy === "portal-fixed". */
	position?: { top: number; left?: number; right?: number };
	children: ComponentChildren;
}

export function Popover({ id, role = "dialog", ariaLabel, class: extraClass, strategy, position, children }: PopoverProps) {
	const classes = extraClass ? `popover ${extraClass}` : "popover";

	if (strategy === "anchored") {
		return (
			<div id={id} role={role} aria-modal="false" aria-label={ariaLabel} class={classes}>
				{children}
			</div>
		);
	}

	if (!position) throw new Error("Popover: `position` is required when strategy is 'portal-fixed'");

	return createPortal(
		<div
			id={id}
			role={role}
			aria-label={ariaLabel}
			class={classes}
			style={{
				position: "fixed",
				top: `${position.top}px`,
				...(position.left !== undefined ? { left: `${position.left}px` } : {}),
				...(position.right !== undefined ? { right: `${position.right}px` } : {}),
			}}
		>
			{children}
		</div>,
		document.body
	);
}
```

New shared `.popover` base CSS class (added to `Base.astro`, not a new file — see Task 4): `background: var(--bg); border: 1px solid var(--border); box-shadow: var(--shadow-sm); z-index: 200;` — pulled out of the three duplicated blocks. Each caller keeps a small modifier class for its own radius/padding/font-size so visual output is unchanged (`.popover-metric-help`, `.popover-account-menu`).

### `Select` — moved as-is from `apps/web/src/islands/Select.tsx` to `apps/web/src/islands/ui/Select.tsx` (Task 5). No behavior/API change; import path changes only.

### Class → component mapping table (used by every migration task, Tasks 7–13)

| Existing markup | Migrated to |
|---|---|
| `<button ... class="btn btn-primary">` | `<Button variant="primary">` |
| `<button ... class="btn btn-primary btn-sm">` | `<Button variant="primary" size="sm">` |
| `<button ... class="btn btn-outline">` | `<Button variant="outline">` |
| `<button ... class="btn btn-outline btn-sm">` | `<Button variant="outline" size="sm">` |
| `<button ... class="btn btn-danger">` / `btn-danger btn-sm` | `<Button variant="danger">` / `<Button variant="danger" size="sm">` |
| `<button ... class="btn btn-sm <extra tailwind utility classes>">` (icon-reset buttons, no variant) | `<Button size="sm" class="<extra tailwind utility classes>">` |
| `<span class="btn btn-outline btn-sm ...">` (non-interactive label, e.g. file-upload trigger) | `<Button as="span" variant="outline" size="sm" class="...">` |
| `class="btn btn-primary btn-sm${cond ? " opacity-60" : ""}"` (template literal with conditional extra class) | `<Button variant="primary" size="sm" class={cond ? "opacity-60" : undefined}>` |
| Any `class="btn ..."` combo not covered above | Same pattern: `variant` from `btn-primary`/`btn-outline`/`btn-danger` (or omit), `size="sm"` if `btn-sm` present, everything else becomes the `class` passthrough |
| `<span class="badge" style={{...}}>` | `<Badge style={{...}}>` |
| `<span class="badge <extra classes>" style={{...}}>` | `<Badge class="<extra classes>" style={{...}}>` |

Every migration task: preserve `onClick`, `disabled`, `type`, `aria-*`, `key`, and any other existing props verbatim on the new component — the mapping only changes how `class`/`variant`/`size` are expressed, nothing else about the element's behavior.

---

## Task 1: `Button` component

**Files:**
- Create: `apps/web/src/islands/ui/Button.tsx`
- Test: `apps/web/src/islands/ui/Button.test.tsx`

**Interfaces:**
- Produces: `Button` (named export), `ButtonProps` (see API reference above) — imported as `import { Button } from "../ui/Button"` (or `./ui/Button` from files directly in `islands/`).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/islands/ui/Button.test.tsx
import { render, screen, fireEvent } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button";

describe("Button", () => {
	it("renders the base btn class with no variant", () => {
		render(<Button>Click</Button>);
		const el = screen.getByRole("button", { name: "Click" });
		expect(el.className).toBe("btn");
	});

	it("applies variant and size classes", () => {
		render(
			<Button variant="primary" size="sm">
				Save
			</Button>
		);
		expect(screen.getByRole("button", { name: "Save" }).className).toBe("btn btn-primary btn-sm");
	});

	it("appends an extra class", () => {
		render(
			<Button variant="outline" class="w-full">
				Wide
			</Button>
		);
		expect(screen.getByRole("button", { name: "Wide" }).className).toBe("btn btn-outline w-full");
	});

	it("fires onClick", () => {
		const onClick = vi.fn();
		render(<Button onClick={onClick}>Go</Button>);
		fireEvent.click(screen.getByRole("button", { name: "Go" }));
		expect(onClick).toHaveBeenCalledOnce();
	});

	it("renders as a span when as='span'", () => {
		render(
			<Button as="span" variant="outline" size="sm">
				Choose file
			</Button>
		);
		const el = screen.getByText("Choose file");
		expect(el.tagName).toBe("SPAN");
		expect(el.className).toBe("btn btn-outline btn-sm");
	});

	it("respects disabled", () => {
		render(<Button disabled>Nope</Button>);
		expect(screen.getByRole("button", { name: "Nope" })).toBeDisabled();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web exec vitest run src/islands/ui/Button.test.tsx`
Expected: FAIL — `Cannot find module './Button'`

- [ ] **Step 3: Write the component**

Create `apps/web/src/islands/ui/Button.tsx` with the exact code from the "Component API reference" section above (`Button` / `ButtonProps`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web exec vitest run src/islands/ui/Button.test.tsx`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/islands/ui/Button.tsx apps/web/src/islands/ui/Button.test.tsx
git commit -m "feat(design-system): add Button component wrapping .btn primitive"
```

---

## Task 2: `Badge` component

**Files:**
- Create: `apps/web/src/islands/ui/Badge.tsx`
- Test: `apps/web/src/islands/ui/Badge.test.tsx`

**Interfaces:**
- Produces: `Badge` (named export), `BadgeProps`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/islands/ui/Badge.test.tsx
import { render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { Badge } from "./Badge";

describe("Badge", () => {
	it("renders the badge class with caller-supplied style", () => {
		render(<Badge style={{ background: "red", color: "white" }}>Urgent</Badge>);
		const el = screen.getByText("Urgent");
		expect(el.className).toBe("badge");
		expect(el.style.background).toBe("red");
		expect(el.style.color).toBe("white");
	});

	it("appends an extra class", () => {
		render(<Badge class="border border-current font-semibold capitalize">active</Badge>);
		expect(screen.getByText("active").className).toBe("badge border border-current font-semibold capitalize");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web exec vitest run src/islands/ui/Badge.test.tsx`
Expected: FAIL — `Cannot find module './Badge'`

- [ ] **Step 3: Write the component**

Create `apps/web/src/islands/ui/Badge.tsx` with the exact code from the API reference section above.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web exec vitest run src/islands/ui/Badge.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/islands/ui/Badge.tsx apps/web/src/islands/ui/Badge.test.tsx
git commit -m "feat(design-system): add Badge component wrapping .badge primitive"
```

---

## Task 3: `Popover` component + shared `.popover` CSS

**Files:**
- Create: `apps/web/src/islands/ui/Popover.tsx`
- Test: `apps/web/src/islands/ui/Popover.test.tsx`
- Modify: `apps/web/src/layouts/Base.astro` (add `.popover` base class; add `.popover-metric-help` / `.popover-account-menu` modifier classes carrying the radius/padding/font-size currently on `.metric-help-popover` / `.account-menu-popover`)

**Interfaces:**
- Consumes: none (self-contained).
- Produces: `Popover` (named export), `PopoverProps` — used by Task 6 (`MetricHelp.tsx`) and Task 6b (`AccountMenu.tsx`).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/islands/ui/Popover.test.tsx
import { render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { Popover } from "./Popover";

describe("Popover", () => {
	it("renders anchored, in place, with the popover class", () => {
		render(
			<Popover strategy="anchored" class="popover-metric-help" ariaLabel="Info">
				<p>content</p>
			</Popover>
		);
		const el = screen.getByRole("dialog", { name: "Info" });
		expect(el.className).toBe("popover popover-metric-help");
	});

	it("renders portal-fixed to document.body with computed position", () => {
		render(
			<Popover strategy="portal-fixed" class="popover-account-menu" role="menu" ariaLabel="Account" position={{ top: 60, right: 8 }}>
				<p>menu</p>
			</Popover>
		);
		const el = screen.getByRole("menu", { name: "Account" });
		expect(el.parentElement).toBe(document.body);
		expect(el.style.position).toBe("fixed");
		expect(el.style.top).toBe("60px");
		expect(el.style.right).toBe("8px");
	});

	it("throws when portal-fixed is used without position", () => {
		expect(() =>
			render(
				<Popover strategy="portal-fixed">
					<p>oops</p>
				</Popover>
			)
		).toThrow(/position.*required/);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web exec vitest run src/islands/ui/Popover.test.tsx`
Expected: FAIL — `Cannot find module './Popover'`

- [ ] **Step 3: Write the component**

Create `apps/web/src/islands/ui/Popover.tsx` with the exact code from the API reference section above.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web exec vitest run src/islands/ui/Popover.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Add the shared `.popover` CSS to `Base.astro`**

In `apps/web/src/layouts/Base.astro`, in the `<style is:global>` block, immediately before the existing `.metric-help-popover` rule (~line 578), add:

```css
      /* ── Shared popover primitive (islands/ui/Popover) ────────────────── */
      .popover {
        background: var(--bg);
        border: 1px solid var(--border);
        box-shadow: var(--shadow-sm);
        z-index: 200;
      }
      .popover-metric-help {
        width: 16rem;
        max-width: min(16rem, 80vw);
        padding: 0.625rem 0.75rem;
        border-radius: 6px;
        font-weight: normal;
        text-transform: none;
        letter-spacing: normal;
      }
      .popover-account-menu {
        width: 14rem;
        max-width: min(14rem, 85vw);
        border-radius: 8px;
        padding: 0.375rem;
        font-size: 0.875rem;
      }
```

Then remove `background`, `border`, `box-shadow`, `z-index` from the existing `.metric-help-popover` and `.account-menu-popover` rules (they now come from `.popover`) — leave the rest of each rule (`position`, `top`, `left`, `width`, etc. for `.metric-help-popover`) untouched.

- [ ] **Step 6: Manually diff the computed CSS is unchanged**

Run: `pnpm --filter web build` then grep the built CSS for `.popover-metric-help` and `.metric-help-popover` to confirm both class names' combined declarations match the pre-change `.metric-help-popover` block exactly (background/border/shadow/z-index/radius/padding/font all present, no duplicates, no drops).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/islands/ui/Popover.tsx apps/web/src/islands/ui/Popover.test.tsx apps/web/src/layouts/Base.astro
git commit -m "feat(design-system): add Popover component + shared .popover CSS primitive"
```

---

## Task 4: Move `Select` into `islands/ui/`

**Files:**
- Move: `apps/web/src/islands/Select.tsx` → `apps/web/src/islands/ui/Select.tsx`
- Move: `apps/web/src/islands/Select.test.tsx` → `apps/web/src/islands/ui/Select.test.tsx`
- Modify (import path only, no other change): `apps/web/src/islands/EpicList.tsx`, `apps/web/src/islands/FeedbackList.tsx`, `apps/web/src/islands/FeedbackSourceDetail.tsx`, `apps/web/src/islands/IssueDetailParts.tsx`, `apps/web/src/islands/MetricsDashboard.tsx`, `apps/web/src/islands/WikiPage.tsx`, `apps/web/src/islands/issue-list/issue-render-helpers.tsx`, `apps/web/src/islands/issue-list/CreateIssueModal.tsx`, `apps/web/src/islands/issue-list/Toolbar.tsx`

**Interfaces:**
- No API change. `import Select from "./Select"` → `import Select from "./ui/Select"` in files directly under `islands/`; `import Select from "../Select"` → `import Select from "../ui/Select"` in files under `islands/issue-list/`.

- [ ] **Step 1: Move the files**

```bash
git mv apps/web/src/islands/Select.tsx apps/web/src/islands/ui/Select.tsx
git mv apps/web/src/islands/Select.test.tsx apps/web/src/islands/ui/Select.test.tsx
```

- [ ] **Step 2: Update the 9 import sites**

For each of these lines, change only the import path (component name, props, everything else stays identical):

- `apps/web/src/islands/EpicList.tsx:16`: `import Select from "./Select";` → `import Select from "./ui/Select";`
- `apps/web/src/islands/FeedbackList.tsx:3`: `import Select from "./Select";` → `import Select from "./ui/Select";`
- `apps/web/src/islands/FeedbackSourceDetail.tsx:7`: `import Select from "./Select";` → `import Select from "./ui/Select";`
- `apps/web/src/islands/IssueDetailParts.tsx:27`: `import Select from "./Select";` → `import Select from "./ui/Select";`
- `apps/web/src/islands/MetricsDashboard.tsx:18`: `import Select, { type SelectOption } from "./Select";` → `import Select, { type SelectOption } from "./ui/Select";`
- `apps/web/src/islands/WikiPage.tsx:10`: `import Select, { type SelectOption } from "./Select";` → `import Select, { type SelectOption } from "./ui/Select";`
- `apps/web/src/islands/issue-list/issue-render-helpers.tsx:5`: `import Select from "../Select";` → `import Select from "../ui/Select";`
- `apps/web/src/islands/issue-list/CreateIssueModal.tsx:5`: `import Select from "../Select";` → `import Select from "../ui/Select";`
- `apps/web/src/islands/issue-list/Toolbar.tsx:4`: `import Select from "../Select";` → `import Select from "../ui/Select";`

- [ ] **Step 3: Update `Select.test.tsx`'s own self-import if present**

Open `apps/web/src/islands/ui/Select.test.tsx` — it already imports from `"./Select"` (relative, unaffected by the move since both files moved together). Confirm this line is unchanged.

- [ ] **Step 4: Run the full web test suite**

Run: `pnpm --filter web test`
Expected: PASS, same pass count as before this task (no new failures — the move is import-path-only).

- [ ] **Step 5: Grep to confirm no stale references remain**

Run: `grep -rn 'from "\.\./Select"\|from "\./Select"' apps/web/src` (excluding `apps/web/src/islands/ui/Select.tsx`/`Select.test.tsx`'s own internal references, which don't exist)
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add -A apps/web/src/islands/
git commit -m "refactor(design-system): move Select into islands/ui/"
```

---

## Task 5: Migrate `MetricHelp.tsx` and `AccountMenu.tsx` to `Popover`

**Files:**
- Modify: `apps/web/src/islands/MetricHelp.tsx`
- Modify: `apps/web/src/islands/AccountMenu.tsx`

**Interfaces:**
- Consumes: `Popover` from `./ui/Popover` (both files are directly under `islands/`).

- [ ] **Step 1: Migrate `MetricHelp.tsx`**

Add the import: `import { Popover } from "./ui/Popover";`

Replace (current lines 43–54):

```tsx
				{open && (
					<div
						id={popoverId}
						role="dialog"
						aria-modal="false"
						aria-label={`${def.label} definition`}
						class="metric-help-popover"
					>
						<p class="m-0 mb-1 text-[0.8rem] text-text-base">{def.definition}</p>
						<p class="m-0 text-[0.72rem] text-text-muted">{def.computation}</p>
					</div>
				)}
```

with:

```tsx
				{open && (
					<Popover id={popoverId} strategy="anchored" class="popover-metric-help" ariaLabel={`${def.label} definition`}>
						<p class="m-0 mb-1 text-[0.8rem] text-text-base">{def.definition}</p>
						<p class="m-0 text-[0.72rem] text-text-muted">{def.computation}</p>
					</Popover>
				)}
```

- [ ] **Step 2: Migrate `AccountMenu.tsx`**

Add the import: `import { Popover } from "./ui/Popover";` (keep the existing `createPortal` import removed — `Popover` now owns portalling).

Replace (current lines 140–177, the `open && popoverPos && createPortal(...)` block) with:

```tsx
				{open && popoverPos && (
					<Popover
						id={menuId}
						strategy="portal-fixed"
						class="popover-account-menu"
						role="menu"
						ariaLabel="Account"
						position={popoverPos}
					>
						<div class="account-menu-identity">
							<div class="account-menu-identity-name">{user.name}</div>
							<div class="account-menu-identity-email">{user.email}</div>
						</div>
						<div role="menu" aria-label="Account">
							<a
								role="menuitem"
								class="account-menu-item"
								href={`/auth/login?redirect_url=${encodeURIComponent(redirectTarget)}`}
							>
								Refresh session
							</a>
							<a
								role="menuitem"
								class="account-menu-item"
								href="/cdn-cgi/access/logout"
								onClick={() => clearAllDrafts()}
							>
								Log out
							</a>
						</div>
					</Popover>
				)}
```

Note the `ref={popoverRef}` from the original `<div>` is dropped — `popoverRef` is only read inside `isInside()` to decide whether an outside click is really outside. Since `Popover`'s rendered DOM still has the same `id`/`role`/class structure, replace `popoverRef.current?.contains(node)` in `isInside()` with a lookup via `document.getElementById(menuId)?.contains(node)` instead of a ref, since `Popover` doesn't expose a ref passthrough. Update:

```tsx
	function isInside(node: Node) {
		return !!(rootRef.current?.contains(node) || document.getElementById(menuId)?.contains(node));
	}
```

and remove the now-unused `popoverRef` declaration and its `useRef` import usage if `useRef` becomes otherwise unused (it's still used for `rootRef`/`triggerRef`, so keep the import, just drop the one `popoverRef` line).

- [ ] **Step 3: Run the affected test files**

Run: `pnpm --filter web exec vitest run src/islands/MetricHelp.test.tsx src/islands/AccountMenu.test.tsx`

If `MetricHelp.test.tsx` does not exist yet, skip it (not all islands have one) — confirm with `ls apps/web/src/islands/MetricHelp.test.tsx` first.

Expected: PASS, same assertions as before (tests query by role/aria-label, which are unchanged).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/islands/MetricHelp.tsx apps/web/src/islands/AccountMenu.tsx
git commit -m "refactor(design-system): migrate MetricHelp and AccountMenu popovers to islands/ui/Popover"
```

---

## Task 6: Migrate `.btn`/`.badge` call sites — batch 1

**Files:**
- Modify: `apps/web/src/islands/FeedbackSourceSettings.tsx` (6 occurrences)
- Modify: `apps/web/src/islands/EpicList.tsx` (3 occurrences)
- Modify: `apps/web/src/islands/issue-list/HeaderRow.tsx` (1 occurrence, plus the `"#fff"` raw-color fix)

**Interfaces:**
- Consumes: `Button` from `./ui/Button` (files directly under `islands/`) or `../ui/Button` (files under `islands/issue-list/`).

- [ ] **Step 1: Add the `Button` import to each file**

`FeedbackSourceSettings.tsx` and `EpicList.tsx`: `import { Button } from "./ui/Button";`
`issue-list/HeaderRow.tsx`: `import { Button } from "../ui/Button";`

- [ ] **Step 2: Migrate each `.btn`-classed element using the mapping table**

Read each file, find every element with a `class` containing `btn`, and apply the "Class → component mapping table" from the top of this plan. Preserve every other prop (`onClick`, `disabled`, `type`, `key`, etc.) verbatim.

- [ ] **Step 3: Fix the raw hex color in `HeaderRow.tsx`**

At `apps/web/src/islands/issue-list/HeaderRow.tsx:72`, change:

```tsx
									color: view === v ? "#fff" : "var(--text-muted)",
```

to:

```tsx
									color: view === v ? "var(--on-accent)" : "var(--text-muted)",
```

- [ ] **Step 4: Verify no `.btn` classes remain unmigrated**

Run: `grep -n 'class="btn\|class={.*btn ' apps/web/src/islands/FeedbackSourceSettings.tsx apps/web/src/islands/EpicList.tsx apps/web/src/islands/issue-list/HeaderRow.tsx`
Expected: no output.

- [ ] **Step 5: Run the affected tests**

Run: `pnpm --filter web exec vitest run src/islands/FeedbackSourceSettings.test.tsx src/islands/EpicList.test.tsx src/islands/issue-list/HeaderRow.test.tsx`
Expected: PASS, unchanged assertion count.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/islands/FeedbackSourceSettings.tsx apps/web/src/islands/EpicList.tsx apps/web/src/islands/issue-list/HeaderRow.tsx
git commit -m "refactor(design-system): migrate FeedbackSourceSettings, EpicList, HeaderRow to Button"
```

---

## Task 7: Migrate `.btn` call sites — batch 2

**Files:**
- Modify: `apps/web/src/islands/issue-list/CreateIssueModal.tsx` (2 occurrences)
- Modify: `apps/web/src/islands/NewSourceModal.tsx` (3 occurrences)
- Modify: `apps/web/src/islands/FeedbackList.tsx` (4 occurrences)

Same procedure as Task 6, Steps 1–2 (imports: `../ui/Button` for `CreateIssueModal.tsx`, `./ui/Button` for the other two), applied to these three files, then:

- [ ] **Step 1: Migrate imports + call sites** (per mapping table, as in Task 6 Step 2)
- [ ] **Step 2: Verify no `.btn` classes remain** — `grep -n 'class="btn\|class={.*btn ' apps/web/src/islands/issue-list/CreateIssueModal.tsx apps/web/src/islands/NewSourceModal.tsx apps/web/src/islands/FeedbackList.tsx` → no output
- [ ] **Step 3: Run tests** — `pnpm --filter web exec vitest run src/islands/issue-list/CreateIssueModal.test.tsx src/islands/NewSourceModal.test.tsx src/islands/FeedbackList.test.tsx` → PASS
- [ ] **Step 4: Commit**

```bash
git add apps/web/src/islands/issue-list/CreateIssueModal.tsx apps/web/src/islands/NewSourceModal.tsx apps/web/src/islands/FeedbackList.tsx
git commit -m "refactor(design-system): migrate CreateIssueModal, NewSourceModal, FeedbackList to Button"
```

---

## Task 8: Migrate `.btn` call sites — batch 3 (+ raw-hex fixes)

**Files:**
- Modify: `apps/web/src/islands/ProjectLanding.tsx` (2 occurrences)
- Modify: `apps/web/src/islands/ProjectList.tsx` (3 occurrences)
- Modify: `apps/web/src/islands/issue-list/SprintBannerSection.tsx` (2 occurrences, plus raw-hex fixes)
- Modify: `apps/web/src/islands/issue-list/Toolbar.tsx` (1 occurrence)

- [ ] **Step 1: Migrate imports + call sites** (per mapping table). `ProjectLanding.tsx`/`ProjectList.tsx`: `import { Button } from "./ui/Button";`. `issue-list/SprintBannerSection.tsx`/`issue-list/Toolbar.tsx`: `import { Button } from "../ui/Button";`.

- [ ] **Step 2: Fix raw hex in `issue-list/SprintBannerSection.tsx`**

Read the file, find each hex/`rgb()`/`rgba()` literal found by `grep -nE "#[0-9a-fA-F]{3,8}\\b|rgba?\\(" apps/web/src/islands/issue-list/SprintBannerSection.tsx`, and replace each with the matching `var(--*)` token from the token table in `/wiki/design-system` (e.g. a color matching `--status-in-progress`'s hex value becomes `var(--status-in-progress)`; a color not matching any existing token gets the nearest semantic token — flag any literal with no clear token match as a step-5 finding instead of guessing).

- [ ] **Step 3: Verify no `.btn` classes or raw hex remain**

Run: `grep -n 'class="btn\|class={.*btn ' apps/web/src/islands/ProjectLanding.tsx apps/web/src/islands/ProjectList.tsx apps/web/src/islands/issue-list/SprintBannerSection.tsx apps/web/src/islands/issue-list/Toolbar.tsx`
Run: `grep -nE "#[0-9a-fA-F]{3,8}\\b|rgba?\\(" apps/web/src/islands/issue-list/SprintBannerSection.tsx`
Expected: no output from either.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter web exec vitest run src/islands/ProjectLanding.test.tsx src/islands/ProjectList.test.tsx`
(no dedicated test files expected for `SprintBannerSection.tsx`/`Toolbar.tsx` — confirm with `ls`; if present, include them.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/islands/ProjectLanding.tsx apps/web/src/islands/ProjectList.tsx apps/web/src/islands/issue-list/SprintBannerSection.tsx apps/web/src/islands/issue-list/Toolbar.tsx
git commit -m "refactor(design-system): migrate ProjectLanding, ProjectList, SprintBannerSection, Toolbar to Button; fix raw hex"
```

---

## Task 9: Migrate `ShareView.tsx` and `SprintManager.tsx` to `Button`/`Badge`

**Files:**
- Modify: `apps/web/src/islands/ShareView.tsx` (2 `badge` occurrences)
- Modify: `apps/web/src/islands/SprintManager.tsx` (8 `.btn`/`.badge` occurrences, plus raw hex — see Step 2)

- [ ] **Step 1: Migrate `ShareView.tsx`**

Add `import { Badge } from "./ui/Badge";`. Replace (line 101):

```tsx
				<span class="badge" style={{ background: priorityStyle.bg, color: priorityStyle.text }}>
					{PRIORITY_LABELS[issue.priority] ?? issue.priority}
				</span>
```

with:

```tsx
				<Badge style={{ background: priorityStyle.bg, color: priorityStyle.text }}>
					{PRIORITY_LABELS[issue.priority] ?? issue.priority}
				</Badge>
```

And replace the status badge (lines 105–113):

```tsx
					<span
						class="badge"
						style={{
							background: "var(--surface)",
							color: "var(--text-muted)",
							border: "1px solid var(--border)",
						}}
					>
						{issue.status_name}
					</span>
```

with:

```tsx
					<Badge
						style={{
							background: "var(--surface)",
							color: "var(--text-muted)",
							border: "1px solid var(--border)",
						}}
					>
						{issue.status_name}
					</Badge>
```

- [ ] **Step 2: Migrate `SprintManager.tsx`**

Add `import { Button } from "./ui/Button"; import { Badge } from "./ui/Badge";`.

Replace the `statusBadge` helper (lines 62–71):

```tsx
function statusBadge(status: Sprint["status"]) {
	const styles: Record<Sprint["status"], { bg: string; color: string }> = {
		planned: { bg: "var(--surface)", color: "var(--text-muted)" },
		active: { bg: "rgba(37,99,235,0.12)", color: "var(--status-in-progress)" },
		completed: { bg: "rgba(22,163,74,0.12)", color: "var(--status-done)" },
	};
	const s = styles[status] ?? styles.planned;
	return (
		<span
			class="badge border border-current font-semibold capitalize"
			style={{ background: s.bg, color: s.color }}
		>
			{status}
		</span>
	);
}
```

with (also replacing the two raw `rgba(...)` literals — `rgba(37,99,235,0.12)` matches `--priority-medium-bg`'s hue family but is not an exact existing token; introduce two new semantic tokens instead of forcing a mismatched reuse — see Step 3):

```tsx
function statusBadge(status: Sprint["status"]) {
	const styles: Record<Sprint["status"], { bg: string; color: string }> = {
		planned: { bg: "var(--surface)", color: "var(--text-muted)" },
		active: { bg: "var(--sprint-active-bg)", color: "var(--status-in-progress)" },
		completed: { bg: "var(--sprint-completed-bg)", color: "var(--status-done)" },
	};
	const s = styles[status] ?? styles.planned;
	return (
		<Badge class="border border-current font-semibold capitalize" style={{ background: s.bg, color: s.color }}>
			{status}
		</Badge>
	);
}
```

Then migrate the remaining 6 `.btn`-classed elements in the file (lines ~536, 789, 796, 829, 839, 845, 890) using the mapping table.

- [ ] **Step 3: Add the two new tokens to `Base.astro`**

In `apps/web/src/layouts/Base.astro`'s `:root` block, immediately after `--status-cancelled: #dc2626;` (~line 120), add:

```css
        /* Sprint status badge background tokens (light) */
        --sprint-active-bg: rgba(37, 99, 235, 0.12);
        --sprint-completed-bg: rgba(22, 163, 74, 0.12);
```

In the `@media (prefers-color-scheme: dark)` block, after the dark `--status-cancelled` line (~line 166), add:

```css
          --sprint-active-bg: rgba(129, 140, 248, 0.18);
          --sprint-completed-bg: rgba(74, 222, 128, 0.18);
```

In `[data-theme='dark']`, after its `--status-cancelled` line (~line 207), add the same dark values. In `[data-theme='light']`, after its `--status-cancelled` line (~line 244), add the same light values as `:root`.

- [ ] **Step 4: Verify no `.btn`/`.badge` classes or raw hex remain**

Run: `grep -n 'class="btn\|class="badge\|class={.*\(btn\|badge\)' apps/web/src/islands/ShareView.tsx apps/web/src/islands/SprintManager.tsx`
Run: `grep -nE "#[0-9a-fA-F]{3,8}\\b|rgba?\\(" apps/web/src/islands/ShareView.tsx apps/web/src/islands/SprintManager.tsx`
Expected: no output from either (the `rgba(...)` calls are now inside `Base.astro`'s token definitions, not the island files).

- [ ] **Step 5: Run tests**

Run: `pnpm --filter web exec vitest run src/islands/ShareView.test.tsx src/islands/SprintManager.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/islands/ShareView.tsx apps/web/src/islands/SprintManager.tsx apps/web/src/layouts/Base.astro
git commit -m "refactor(design-system): migrate ShareView, SprintManager to Button/Badge; add sprint status tokens"
```

---

## Task 10: Migrate `TokenManager.tsx`

**Files:**
- Modify: `apps/web/src/islands/TokenManager.tsx` (9 occurrences)

- [ ] **Step 1: Add `import { Button } from "./ui/Button";`**
- [ ] **Step 2: Migrate all 9 `.btn`-classed elements** (lines ~252, 267, 279, 384, 389, 509, 517, 530, 711) using the mapping table.
- [ ] **Step 3: Verify** — `grep -n 'class="btn\|class={.*btn ' apps/web/src/islands/TokenManager.tsx` → no output
- [ ] **Step 4: Run tests** — `pnpm --filter web exec vitest run src/islands/TokenManager.test.tsx` → PASS
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/islands/TokenManager.tsx
git commit -m "refactor(design-system): migrate TokenManager to Button"
```

---

## Task 11: Migrate `WikiPage.tsx` (`.btn` + raw hex)

**Files:**
- Modify: `apps/web/src/islands/WikiPage.tsx` (21 `.btn` occurrences)

- [ ] **Step 1: Add `import { Button } from "./ui/Button";`** (note: `Select` import already updated to `./ui/Select` in Task 4)
- [ ] **Step 2: Migrate all 21 `.btn`-classed elements** using the mapping table — includes two `<span class="btn btn-outline btn-sm">` file-upload-trigger labels (lines 961, 1328) that use `as="span"`.
- [ ] **Step 3: Fix raw hex/rgb literals**

Run: `grep -nE "#[0-9a-fA-F]{3,8}\\b|rgba?\\(" apps/web/src/islands/WikiPage.tsx` to find every occurrence, and replace each with the matching `var(--*)` token per the token table in `/wiki/design-system`. Where no existing token matches, add a new one to `Base.astro` following the same four-block pattern (`:root` / dark media query / `[data-theme='dark']` / `[data-theme='light']`) used in Task 9 Step 3.

- [ ] **Step 4: Verify**

Run: `grep -n 'class="btn\|class={.*btn ' apps/web/src/islands/WikiPage.tsx` → no output
Run: `grep -nE "#[0-9a-fA-F]{3,8}\\b|rgba?\\(" apps/web/src/islands/WikiPage.tsx` → no output

- [ ] **Step 5: Run tests** — `pnpm --filter web exec vitest run src/islands/WikiPage.test.tsx` → PASS
- [ ] **Step 6: Commit**

```bash
git add apps/web/src/islands/WikiPage.tsx apps/web/src/layouts/Base.astro
git commit -m "refactor(design-system): migrate WikiPage to Button; fix raw hex"
```

---

## Task 12: Migrate `IssueDetailParts.tsx` (`.btn` + raw hex)

**Files:**
- Modify: `apps/web/src/islands/IssueDetailParts.tsx` (21 `.btn` occurrences, largest single file — its own task)

- [ ] **Step 1: Add `import { Button } from "./ui/Button";`** (note: `Select` import already updated to `./ui/Select` in Task 4)
- [ ] **Step 2: Migrate all 21 `.btn`-classed elements** using the mapping table.
- [ ] **Step 3: Fix raw hex/rgb literals**

Run: `grep -nE "#[0-9a-fA-F]{3,8}\\b|rgba?\\(" apps/web/src/islands/IssueDetailParts.tsx` and replace each per the token table, adding new tokens to `Base.astro` (same four-block pattern) if no existing token matches.

- [ ] **Step 4: Verify**

Run: `grep -n 'class="btn\|class={.*btn ' apps/web/src/islands/IssueDetailParts.tsx` → no output
Run: `grep -nE "#[0-9a-fA-F]{3,8}\\b|rgba?\\(" apps/web/src/islands/IssueDetailParts.tsx` → no output

- [ ] **Step 5: Run tests** — `pnpm --filter web exec vitest run src/islands/IssueDetailParts.test.tsx src/islands/IssueDetail.test.tsx` → PASS
- [ ] **Step 6: Commit**

```bash
git add apps/web/src/islands/IssueDetailParts.tsx apps/web/src/layouts/Base.astro
git commit -m "refactor(design-system): migrate IssueDetailParts to Button; fix raw hex"
```

---

## Task 13: Fix remaining raw-hex files

**Files:**
- Modify: `apps/web/src/islands/IssueDetail.tsx`
- Modify: `apps/web/src/islands/issue-list/BoardView.tsx`
- Modify: `apps/web/src/islands/issue-list/FiltersPopover.tsx`
- Modify: `apps/web/src/islands/ApiHealth.tsx`

None of these four files have `.btn`/`.badge` classes to migrate (confirmed by the Task 6–12 grep list not including them) — only raw color literals.

- [ ] **Step 1: For each file, find and fix raw hex/rgb literals**

Run: `grep -nE "#[0-9a-fA-F]{3,8}\\b|rgba?\\(" apps/web/src/islands/IssueDetail.tsx apps/web/src/islands/issue-list/BoardView.tsx apps/web/src/islands/issue-list/FiltersPopover.tsx apps/web/src/islands/ApiHealth.tsx`

Replace each with the matching `var(--*)` token from `/wiki/design-system`'s token table, adding a new token to `Base.astro` (same four-block pattern as Task 9 Step 3) if nothing matches.

- [ ] **Step 2: Verify**

Run the same grep again — expected: no output.

- [ ] **Step 3: Run tests**

Run: `pnpm --filter web exec vitest run src/islands/IssueDetail.test.tsx src/islands/issue-list/BoardView.test.tsx src/islands/issue-list/FiltersPopover.test.tsx src/islands/ApiHealth.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/islands/IssueDetail.tsx apps/web/src/islands/issue-list/BoardView.tsx apps/web/src/islands/issue-list/FiltersPopover.tsx apps/web/src/islands/ApiHealth.tsx apps/web/src/layouts/Base.astro
git commit -m "fix(design-system): replace raw hex/rgb literals with tokens in remaining files"
```

---

## Task 14: Scaffold `plugins/design-system`

**Files:**
- Create: `plugins/design-system/package.json`
- Create: `plugins/design-system/tsconfig.json`
- Create: `plugins/design-system/cofferdam.toml`
- Create: `plugins/design-system/fixtures/apps/web/src/islands/fixture.tsx`
- Create: `plugins/design-system/fixtures/apps/web/src/islands/ui/Button.tsx` (empty-ish stand-in so the fixture's exclude-path rule has a real file to not-flag)
- Create: `plugins/design-system/scripts/check-fixture.mjs`

**Interfaces:**
- Produces: the plugin package skeleton Task 15–18 add rules to.

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@projektor/cofferdam-design-system",
  "private": true,
  "version": "0.0.0",
  "description": "cofferdam plugin: enforce design-system token/component reuse in apps/web/src (raw colors, hand-rolled primitives, new primitive-shaped CSS, inline token-shaped styles). PROJ-527.",
  "license": "MIT",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p .",
    "test": "node scripts/check-fixture.mjs"
  },
  "dependencies": {
    "@cofferdam/check-sdk": "^0.3.7"
  },
  "devDependencies": {
    "typescript": "^5.5.0"
  },
  "engines": {
    "node": ">=16"
  }
}
```

- [ ] **Step 2: `tsconfig.json`** (identical to `plugins/island-api/tsconfig.json`)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "lib": ["ES2022"]
  },
  "include": ["src/index.ts"]
}
```

- [ ] **Step 3: `cofferdam.toml`** (local fixture config, mirrors `plugins/island-api/cofferdam.toml`)

```toml
# cofferdam.toml — local config for the design-system plugin fixture (PROJ-527).
#
# Self-contained next to the plugin so `cofferdam check
# fixtures/apps/web/src/islands/fixture.tsx --config ./cofferdam.toml` is
# reproducible without polluting the repo-root config. The fixture lives
# under fixtures/apps/web/src/islands/ (not flat) because the check's own
# `files.pathPatterns: ["apps/web/src/**/*"]` scope must match it.

plugins = ["./"]

[checks."DesignSystemConvention"]
severity = "high"
```

- [ ] **Step 4: `fixtures/apps/web/src/islands/fixture.tsx`** — combined fixture covering all four rules (positive and negative cases), built out incrementally in Tasks 15–18. Create the initial skeleton now (Task 15 fills in rule 1's section, etc.):

```tsx
// fixture.tsx — input to `cofferdam check` for the DesignSystemConvention
// plugin (PROJ-527). Comments label the expected outcome on each line.
// Sections are filled in one per rule (Tasks 15–18); each section notes
// which rule it exercises.

// ---- Rule 1: raw color literal ----------------------------------------
// (filled in Task 15)

// ---- Rule 2: hand-rolled primitive markup (import boundary) -----------
// (filled in Task 16)

// ---- Rule 3: new primitive-shaped CSS class ----------------------------
// (filled in Task 17)

// ---- Rule 4: inline style with token-shaped values ---------------------
// (filled in Task 18)
```

- [ ] **Step 5: Placeholder fixture ui component**

Create `plugins/design-system/fixtures/apps/web/src/islands/ui/Button.tsx`:

```tsx
// Stand-in for the real islands/ui/Button.tsx, so a fixture case that
// imports "./ui/Button" (Rule 2's negative case) resolves to something.
export function Button() {
	return null;
}
```

- [ ] **Step 6: `scripts/check-fixture.mjs`** (mirrors `plugins/island-api/scripts/check-fixture.mjs`, adjusted for `.tsx` fixture and the `DesignSystemConvention` id)

```js
#!/usr/bin/env node
// Regression check for the DesignSystemConvention plugin (PROJ-527): runs
// cofferdam against fixture.tsx and diffs its own findings (ignoring
// unrelated built-in findings, which vary across cofferdam versions)
// against expected.json. Exits non-zero and prints a diff on mismatch.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let raw;
try {
  raw = execFileSync(
    "npx",
    [
      "--no-install",
      "cofferdam",
      "check",
      "fixtures/apps/web/src/islands/fixture.tsx",
      "--config",
      "./cofferdam.toml",
      "--format",
      "json",
    ],
    { cwd: pluginDir, encoding: "utf8", shell: process.platform === "win32" },
  );
} catch (err) {
  if (typeof err.stdout !== "string" || err.stdout.length === 0) throw err;
  raw = err.stdout;
}

const actual = JSON.parse(raw).findings.filter((f) => f.id === "Warning.DesignSystemConvention");
const expected = JSON.parse(readFileSync(path.join(pluginDir, "expected.json"), "utf8")).findings;

const match = JSON.stringify(actual) === JSON.stringify(expected);
if (!match) {
  console.error("Mismatch between expected.json and actual DesignSystemConvention findings:");
  console.error("expected:", JSON.stringify(expected, null, 2));
  console.error("actual:  ", JSON.stringify(actual, null, 2));
  process.exit(1);
}
console.log(`OK — ${actual.length} DesignSystemConvention finding(s) match expected.json`);
```

- [ ] **Step 7: Install dependencies and confirm the skeleton builds**

Run: `cd plugins/design-system && npm install`
Run: `npm run build`
Expected: fails (no `src/index.ts` yet) — that's expected at this point; confirms `npm install`/tsconfig wiring is otherwise sound. Proceed to Task 15 to add `src/index.ts`.

- [ ] **Step 8: Commit**

```bash
git add plugins/design-system
git commit -m "chore(design-system): scaffold plugins/design-system cofferdam plugin"
```

---

## Task 15: Rule 1 — raw color literal

**Files:**
- Create: `plugins/design-system/src/index.ts`
- Modify: `plugins/design-system/fixtures/apps/web/src/islands/fixture.tsx`
- Create: `plugins/design-system/expected.json` (rule 1 findings only for now — Tasks 16–18 append to it)

**Interfaces:**
- Produces: `default` export (the `Check` from `defineCheck`), id `DesignSystemConvention`.

- [ ] **Step 1: Write `src/index.ts` with rule 1 only**

```ts
// DesignSystemConvention — enforces reuse of apps/web/src/islands/ui/*
// components and Base.astro's CSS tokens instead of hand-rolled
// primitives / raw color literals (PROJ-527).
//
// Four rules in one check, each a line-text scan (matching island-api's
// precedent: the check-sdk v0 AST surface has no JSX node kinds, so a
// className-based or CSS-selector-based rule can't be AST-driven anyway).
// None of the rules skip LineView.isStringLiteral lines — a
// `class="btn ..."` or `color: "#fff"` literal IS a string literal, so
// skipping those lines would make every rule blind to its own target.

import { Category, defineCheck, Severity } from "@cofferdam/check-sdk";

const RAW_COLOR_PATTERN = /#[0-9a-fA-F]{3,8}\b|rgba?\(/g;

// cofferdam-ignore: Design.OrphanExport: loaded dynamically via cofferdam.toml's `plugins = ["./plugins/design-system"]`, not a static import
export default defineCheck({
  id: "DesignSystemConvention",
  category: Category.Warning,
  basePriority: 15,
  defaultSeverity: Severity.High,
  explanation:
    "apps/web/src components must reuse islands/ui/* primitives and Base.astro's " +
    "CSS tokens instead of raw color literals, hand-rolled button/badge/popover " +
    "markup, new primitive-shaped CSS classes, or inline styles matching known " +
    "primitive dimensions.",
  files: {
    extensions: ["tsx", "astro"],
    pathPatterns: ["apps/web/src/**/*"],
    excludePatterns: ["apps/web/src/layouts/Base.astro", "apps/web/src/islands/ui/**/*"],
  },
  run(file, ctx) {
    for (const ln of file.lines()) {
      for (const m of ln.text.matchAll(RAW_COLOR_PATTERN)) {
        ctx.report({
          message: `Raw color literal "${m[0]}" — use a var(--*) token from Base.astro instead.`,
          span: ln.spanFor(m.index, m.index + m[0].length),
        });
      }
    }
  },
});
```

- [ ] **Step 2: Add rule-1 fixture cases**

Replace the `// ---- Rule 1 ----` section of `plugins/design-system/fixtures/apps/web/src/islands/fixture.tsx` with:

```tsx
// ---- Rule 1: raw color literal ----------------------------------------
export function RawColorPositive() {
	return <div style={{ color: "#fff" }}>flagged hex</div>; // FLAG raw color literal "#fff"
}

export function RawColorPositiveRgba() {
	return <div style={{ background: "rgba(0,0,0,0.1)" }}>flagged rgba</div>; // FLAG raw color literal "rgba("
}

export function RawColorNegative() {
	return <div style={{ color: "var(--text)" }}>ok, token</div>; // OK — token, not a literal
}
```

- [ ] **Step 3: Build and run against the fixture to observe raw output**

Run: `cd plugins/design-system && npm run build && npx --no-install cofferdam check fixtures/apps/web/src/islands/fixture.tsx --config ./cofferdam.toml --format json`

Read the printed JSON `findings` array filtered to `id === "Warning.DesignSystemConvention"` — expect exactly 2 entries (the `#fff` and `rgba(` lines), with real `line`/`column`/`start_byte`/`end_byte` values from this run (copy them, don't guess).

- [ ] **Step 4: Write `expected.json` from the observed output**

Create `plugins/design-system/expected.json` with a `{"findings": [...]}` shape containing exactly the 2 objects observed in Step 3 (same field shape as `plugins/island-api/expected.json`: `id`, `category`, `priority`, `severity`, `file`, `line`, `column`, `start_byte`, `end_byte`, `message`, `baselined`).

- [ ] **Step 5: Run the fixture-check script**

Run: `npm test` (inside `plugins/design-system`)
Expected: `OK — 2 DesignSystemConvention finding(s) match expected.json`

- [ ] **Step 6: Commit**

```bash
git add plugins/design-system/src/index.ts plugins/design-system/fixtures plugins/design-system/expected.json
git commit -m "feat(design-system): implement DesignSystemConvention rule 1 (raw color literal)"
```

---

## Task 16: Rule 2 — hand-rolled primitive markup (import boundary)

**Files:**
- Modify: `plugins/design-system/src/index.ts`
- Modify: `plugins/design-system/fixtures/apps/web/src/islands/fixture.tsx`
- Modify: `plugins/design-system/expected.json`

- [ ] **Step 1: Add the rule-2 constants and logic to `src/index.ts`**

Add near the top, after `RAW_COLOR_PATTERN`:

```ts
const PRIMITIVE_CLASS_TOKENS = [
  "btn",
  "badge",
  "select-button",
  "select-menu",
  "account-menu-popover",
  "metric-help-popover",
];
const PRIMITIVE_CLASS_PATTERN = new RegExp(
  `class(?:Name)?=["'{][^"'}]*\\b(${PRIMITIVE_CLASS_TOKENS.join("|")})\\b`
);
const UI_IMPORT_PATTERN = /from\s+["'][.\/]*islands\/ui\/|from\s+["']\.\.?\/ui\//;
```

Inside `run(file, ctx)`, after the rule-1 loop, add:

```ts
    const importsUi = UI_IMPORT_PATTERN.test(file.text);
    if (!importsUi) {
      for (const ln of file.lines()) {
        const m = PRIMITIVE_CLASS_PATTERN.exec(ln.text);
        if (!m) continue;
        ctx.report({
          message: `Hand-rolled primitive class "${m[1]}" without an islands/ui import — use the shared component instead.`,
          span: ln.spanFor(m.index, m.index + m[0].length),
        });
      }
    }
```

- [ ] **Step 2: Add rule-2 fixture cases**

Replace the `// ---- Rule 2 ----` section with:

```tsx
// ---- Rule 2: hand-rolled primitive markup (import boundary) -----------
export function HandRolledPositive() {
	return (
		<button type="button" class="btn btn-primary"> {/* FLAG hand-rolled primitive class "btn" — no ui import in this file */}
			No import
		</button>
	);
}
```

(Deliberately no negative case importing `islands/ui/Button` in this fixture file — adding one here would make `UI_IMPORT_PATTERN.test(file.text)` true for the *whole file*, silencing rule 2 for `HandRolledPositive` above and breaking the positive case. The negative case — a file that imports the component and correctly avoids raw `.btn` markup — is exercised implicitly by every real `islands/ui/*.tsx` file itself, which is path-excluded, and by the real migrated call sites from Tasks 6–13 all passing `cofferdam check` with zero findings at Task 19.)

- [ ] **Step 3: Rebuild, run against the fixture, observe output**

Run: `npm run build && npx --no-install cofferdam check fixtures/apps/web/src/islands/fixture.tsx --config ./cofferdam.toml --format json`

Expect 3 findings total now (2 from rule 1, 1 new from rule 2). Copy the new finding's exact `line`/`column`/`start_byte`/`end_byte`.

- [ ] **Step 4: Append the new finding to `expected.json`**

Add the observed rule-2 finding object to the `findings` array (keep the 2 rule-1 entries from Task 15 unchanged — re-verify their line numbers haven't shifted from the fixture edit; update if they have).

- [ ] **Step 5: Run the fixture-check script**

Run: `npm test`
Expected: `OK — 3 DesignSystemConvention finding(s) match expected.json`

- [ ] **Step 6: Commit**

```bash
git add plugins/design-system/src/index.ts plugins/design-system/fixtures plugins/design-system/expected.json
git commit -m "feat(design-system): implement DesignSystemConvention rule 2 (import-boundary)"
```

---

## Task 17: Rule 3 — new primitive-shaped CSS class

**Files:**
- Modify: `plugins/design-system/src/index.ts`
- Modify: `plugins/design-system/fixtures/apps/web/src/islands/fixture.tsx`
- Modify: `plugins/design-system/expected.json`

- [ ] **Step 1: Add the rule-3 constant and logic to `src/index.ts`**

Add near the other constants:

```ts
const NEW_PRIMITIVE_CSS_CLASS_PATTERN = /\.[\w-]*(btn|badge|popover|dropdown|menu-)[\w-]*\s*\{/;
```

Inside `run(file, ctx)`, after the rule-2 block, add:

```ts
    for (const ln of file.lines()) {
      const m = NEW_PRIMITIVE_CSS_CLASS_PATTERN.exec(ln.text);
      if (!m) continue;
      ctx.report({
        message: `New CSS class "${m[0].replace(/\s*\{$/, "")}" looks like a reimplemented primitive — reuse islands/ui/* instead of defining a new button/badge/popover/dropdown/menu style.`,
        span: ln.spanFor(m.index, m.index + m[0].length),
      });
    }
```

- [ ] **Step 2: Add rule-3 fixture cases**

Replace the `// ---- Rule 3 ----` section with:

```tsx
// ---- Rule 3: new primitive-shaped CSS class ----------------------------
// (Astro <style> block syntax isn't valid in a .tsx file, so this exercises
// the rule via a CSS-in-JS-shaped string, which the line-scan treats the
// same way — the regex only cares about the ".classname {" text shape.)
const styleBlock = `
.my-custom-dropdown-menu { position: absolute; } /* FLAG new primitive-shaped CSS class ".my-custom-dropdown-menu" */
.my-widget { display: flex; } /* OK — no primitive keyword in the class name */
`;
```

- [ ] **Step 3: Rebuild, run against the fixture, observe output**

Run: `npm run build && npx --no-install cofferdam check fixtures/apps/web/src/islands/fixture.tsx --config ./cofferdam.toml --format json`

Expect 4 findings total. Copy the new one's exact location fields.

- [ ] **Step 4: Append to `expected.json`**, re-verifying prior entries' line numbers.

- [ ] **Step 5: Run `npm test`** — expect `OK — 4 DesignSystemConvention finding(s) match expected.json`

- [ ] **Step 6: Commit**

```bash
git add plugins/design-system/src/index.ts plugins/design-system/fixtures plugins/design-system/expected.json
git commit -m "feat(design-system): implement DesignSystemConvention rule 3 (new primitive-shaped CSS class)"
```

---

## Task 18: Rule 4 — inline style with token-shaped values

**Files:**
- Modify: `plugins/design-system/src/index.ts`
- Modify: `plugins/design-system/fixtures/apps/web/src/islands/fixture.tsx`
- Modify: `plugins/design-system/expected.json`

- [ ] **Step 1: Add the rule-4 constant and logic to `src/index.ts`**

Add near the other constants — the exact dimension values are `.btn`'s `border-radius: 4px` / `padding: 0.375rem 0.75rem`, `.badge`'s `border-radius: 4px` / `padding: 0.125rem 0.5rem`, `.popover-metric-help`'s `border-radius: 6px`, `.popover-account-menu`'s `border-radius: 8px` (from Base.astro / Task 3):

```ts
const TOKEN_SHAPED_STYLE_VALUES = [
  "border-radius:\\s*4px",
  "border-radius:\\s*6px",
  "border-radius:\\s*8px",
  "padding:\\s*0\\.375rem\\s*0\\.75rem",
  "padding:\\s*0\\.125rem\\s*0\\.5rem",
];
const INLINE_STYLE_LINE_PATTERN = /style=(\{\{|")/;
const TOKEN_SHAPED_VALUE_PATTERN = new RegExp(TOKEN_SHAPED_STYLE_VALUES.join("|"));
```

Inside `run(file, ctx)`, after the rule-3 block, add:

```ts
    for (const ln of file.lines()) {
      if (!INLINE_STYLE_LINE_PATTERN.test(ln.text)) continue;
      const m = TOKEN_SHAPED_VALUE_PATTERN.exec(ln.text);
      if (!m) continue;
      ctx.report({
        message: `Inline style value "${m[0]}" matches a known islands/ui primitive's dimensions — reuse the component instead of rebuilding it via inline style.`,
        span: ln.spanFor(m.index, m.index + m[0].length),
      });
    }
```

- [ ] **Step 2: Add rule-4 fixture cases**

Replace the `// ---- Rule 4 ----` section with:

```tsx
// ---- Rule 4: inline style with token-shaped values ---------------------
export function InlineStylePositive() {
	return (
		<div style={{ borderRadius: "4px", padding: "0.375rem 0.75rem" }}> {/* FLAG inline style value "border-radius: 4px" (borderRadius normalizes; regex targets literal CSS-text usage — see note below) */}
			reimplemented button shape
		</div>
	);
}

export function InlineStyleNegative() {
	return <div style={{ borderRadius: "12px" }}>unrelated radius, not flagged</div>; // OK
}
```

Note: Preact's `style={{ borderRadius: ... }}` (camelCase JS object key) does not literally contain the text `border-radius:` — the regex targets the *string-form* CSS text (`style="border-radius: 4px"` or a template-literal style string), matching how `HeaderRow.tsx`-style overrides and any CSS-in-JS in this codebase are actually written. Adjust the fixture's positive case to use the string form so the rule under test actually fires:

```tsx
export function InlineStylePositive() {
	return (
		<div style="border-radius: 4px; padding: 0.375rem 0.75rem;"> {/* FLAG inline style value "border-radius: 4px" */}
			reimplemented button shape
		</div>
	);
}
```

- [ ] **Step 3: Rebuild, run against the fixture, observe output**

Run: `npm run build && npx --no-install cofferdam check fixtures/apps/web/src/islands/fixture.tsx --config ./cofferdam.toml --format json`

Expect 5 findings total (rule 4 matches once — the `4px` alternative fires first on that line; confirm from actual output whether both `4px` and the padding pattern each fire since both appear on one line, and adjust `expected.json` to match reality exactly, not the assumed count).

- [ ] **Step 4: Append to `expected.json`**, matching the real observed output exactly (this is the authoritative source, not the count guessed in Step 3).

- [ ] **Step 5: Run `npm test`** — expect a matching `OK` line with the real count.

- [ ] **Step 6: Commit**

```bash
git add plugins/design-system/src/index.ts plugins/design-system/fixtures plugins/design-system/expected.json
git commit -m "feat(design-system): implement DesignSystemConvention rule 4 (inline token-shaped style)"
```

---

## Task 19: Register the plugin, ignore the canvas exception, verify a clean repo-wide check

**Files:**
- Modify: `cofferdam.toml` (repo root)
- Modify: `apps/web/src/islands/MetricsDashboard.tsx`
- Modify: `apps/web/src/islands/metrics/flow-charts.tsx`

- [ ] **Step 1: Register the plugin in the repo-root `cofferdam.toml`**

Change:

```toml
plugins = ["./plugins/island-api"]
```

to:

```toml
plugins = ["./plugins/island-api", "./plugins/design-system"]
```

- [ ] **Step 2: Build the plugin for real use**

Run: `cd plugins/design-system && npm run build`

- [ ] **Step 3: Run the full repo-wide check and inspect `DesignSystemConvention` findings**

Run: `cofferdam check apps/web/src --format json | jq '[.findings[] | select(.id == "Warning.DesignSystemConvention")]'` (or the repo's standard `cofferdam check` invocation if `jq` isn't available — filter the JSON output manually)

- [ ] **Step 4: Add `cofferdam-ignore` comments to the legitimate canvas exception**

In `apps/web/src/islands/MetricsDashboard.tsx`, find every line the Step 3 output flags that is a `readThemeColor()` hex *fallback* value (not a genuine violation), and add an inline `// cofferdam-ignore: DesignSystemConvention` comment on that line, following the exact comment format `plugins/island-api/src/index.ts` uses for its own ignore examples. Do the same in `apps/web/src/islands/metrics/flow-charts.tsx`.

Any finding in these two files that is *not* a `readThemeColor()` fallback (e.g. an unrelated raw hex slipped in elsewhere in the file) is a real violation — fix it with a token per Task 13's procedure, do not ignore it.

- [ ] **Step 5: Re-run the repo-wide check**

Run: `cofferdam check apps/web/src --format json` and confirm zero `Warning.DesignSystemConvention` findings remain.

If any remain outside `MetricsDashboard.tsx`/`flow-charts.tsx`, that means Tasks 6–13's migration missed a call site — go back, apply the same mapping-table/token-replacement procedure to that specific file, and re-run this step until clean.

- [ ] **Step 6: Run the full web test suite one more time**

Run: `pnpm --filter web test`
Expected: PASS, same pass count as the pre-migration baseline (capture the baseline count before Task 1 if not already known, to compare against here).

- [ ] **Step 7: Commit**

```bash
git add cofferdam.toml apps/web/src/islands/MetricsDashboard.tsx apps/web/src/islands/metrics/flow-charts.tsx
git commit -m "chore(design-system): register plugins/design-system; ignore canvas readThemeColor fallbacks"
```

- [ ] **Step 8: Update PROJ-527**

Mark all acceptance criteria checked via `update_issue` (MCP) once every task above is verified green, and move the issue to `in_review` with a completion report summarizing the migration (files touched, findings count before/after, test pass count) and the exact verification commands run (`pnpm --filter web test`, `cofferdam check apps/web/src`).
