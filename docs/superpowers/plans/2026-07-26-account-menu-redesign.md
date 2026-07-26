# Account menu redesign (PROJ-428) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the emoji-only Log in / Log out links in the sidebar footer with an accessible, labeled account menu in a new persistent (scroll-hiding) top bar, showing the signed-in user and offering "Refresh session" / "Log out".

**Architecture:** A new `AccountMenu` Preact island (mirrors the existing `GlossaryHelp` portal-popover pattern and `MyIssues` `/auth/me`-fetch pattern) renders in a top bar that now appears on every breakpoint (previously mobile-only). The sidebar's own brand row is dropped in favor of the top bar's. A small inline script hides/shows the top bar on scroll direction, consistent with the existing drawer/theme-toggle inline-script pattern already in `Base.astro`.

**Tech Stack:** Astro, Preact islands, vitest + @testing-library/preact, existing `apiFetch`/`resolveWorkspaceSlug` utilities. No backend changes — reuses the existing `GET /auth/me` and `GET /auth/login` routes.

## Global Constraints

- No emojis in the login/logout controls (existing 🔑/🚪 must be removed). The unrelated 🌙/☀️ theme toggle is out of scope and stays as-is.
- No backend/API changes — `apps/api/**` is not touched.
- Match existing code style: tabs in `.tsx` files, 2-space indentation inside `Base.astro`'s `<style>`/HTML blocks (follow what's already there).
- Every interactive element needs an accessible name/label; the account menu popover uses `role="menu"`/`role="menuitem"` semantics.

---

## File Structure

- **Create** `apps/web/src/islands/AccountMenu.tsx` — the account menu island (fetch signed-in user, render trigger + dropdown, error fallback).
- **Create** `apps/web/src/islands/AccountMenu.test.tsx` — unit tests for the above.
- **Modify** `apps/web/src/layouts/Base.astro` — import and render `AccountMenu`; restructure the top bar to appear on all breakpoints; drop the sidebar's own brand row and the old login/logout links; add CSS for the top bar, account menu, and scroll-hide behavior; add the scroll-hide inline script.

---

### Task 1: `AccountMenu` island

**Files:**
- Create: `apps/web/src/islands/AccountMenu.tsx`
- Create: `apps/web/src/islands/AccountMenu.test.tsx`

**Interfaces:**
- Consumes: `apiFetch<T>(path: string, opts?: { workspaceSlug?: string }): Promise<T>` from `apps/web/src/utils/api-client.ts`; `resolveWorkspaceSlug(propSlug?: string): string` from `apps/web/src/utils/workspace.ts`.
- Produces: `export function AccountMenu(props: { workspaceSlug?: string }): JSX.Element` — a self-contained island with no required props. Task 2 renders it as `<AccountMenu client:load />`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/islands/AccountMenu.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountMenu } from "./AccountMenu";

function stubMeFetch(outcome: { ok: true; name: string; email: string } | { ok: false }) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation((url: string) => {
			if (String(url).includes("/auth/me")) {
				if (!outcome.ok) return Promise.reject(new Error("network down"));
				return Promise.resolve({
					ok: true,
					json: () =>
						Promise.resolve({ user: { id: "u1", name: outcome.name, email: outcome.email } }),
				});
			}
			return Promise.reject(new Error(`unexpected fetch: ${url}`));
		})
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("AccountMenu — loading and error states", () => {
	it("shows a disabled, labeled placeholder while /auth/me is loading", () => {
		vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
		render(<AccountMenu />);
		const trigger = screen.getByRole("button", { name: "Loading account" });
		expect(trigger).toBeTruthy();
		expect(trigger.hasAttribute("disabled")).toBe(true);
	});

	it("falls back to a plain Log in link when /auth/me fails", async () => {
		stubMeFetch({ ok: false });
		render(<AccountMenu />);
		const link = await screen.findByRole("link", { name: "Log in" });
		expect(link.getAttribute("href")).toBe("/auth/login");
		expect(screen.queryByRole("button")).toBeNull();
	});
});

describe("AccountMenu — signed-in state", () => {
	it("shows the signed-in user's name on the trigger once loaded", async () => {
		stubMeFetch({ ok: true, name: "Jane Doe", email: "jane@example.com" });
		render(<AccountMenu />);
		expect(await screen.findByRole("button", { name: /Jane Doe/ })).toBeTruthy();
	});

	it("opens an accessible menu with Refresh session and Log out", async () => {
		stubMeFetch({ ok: true, name: "Jane Doe", email: "jane@example.com" });
		render(<AccountMenu />);
		const trigger = await screen.findByRole("button", { name: /Jane Doe/ });

		fireEvent.click(trigger);

		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		const menu = screen.getByRole("menu", { name: "Account" });
		expect(menu).toBeTruthy();

		const refresh = screen.getByRole("menuitem", { name: "Refresh session" });
		expect(refresh.getAttribute("href")).toBe("/auth/login?redirect_url=%2F");

		const logout = screen.getByRole("menuitem", { name: "Log out" });
		expect(logout.getAttribute("href")).toBe("/cdn-cgi/access/logout");
	});

	it("portals the menu onto document.body with fixed positioning", async () => {
		stubMeFetch({ ok: true, name: "Jane Doe", email: "jane@example.com" });
		render(<AccountMenu />);
		fireEvent.click(await screen.findByRole("button", { name: /Jane Doe/ }));

		const menu = screen.getByRole("menu", { name: "Account" });
		expect(menu.closest("[style]")?.parentElement).toBe(document.body);
		const popover = menu.parentElement as HTMLElement;
		expect(popover.style.position).toBe("fixed");
	});

	it("closes on Escape and returns focus to the trigger", async () => {
		stubMeFetch({ ok: true, name: "Jane Doe", email: "jane@example.com" });
		render(<AccountMenu />);
		const trigger = await screen.findByRole("button", { name: /Jane Doe/ });
		fireEvent.click(trigger);
		expect(screen.getByRole("menu", { name: "Account" })).toBeTruthy();

		fireEvent.keyDown(document, { key: "Escape" });

		expect(screen.queryByRole("menu")).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});

	it("closes on an outside click", async () => {
		stubMeFetch({ ok: true, name: "Jane Doe", email: "jane@example.com" });
		render(<AccountMenu />);
		fireEvent.click(await screen.findByRole("button", { name: /Jane Doe/ }));
		expect(screen.getByRole("menu", { name: "Account" })).toBeTruthy();

		fireEvent.mouseDown(document.body);

		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("does not close on a click inside the menu itself", async () => {
		stubMeFetch({ ok: true, name: "Jane Doe", email: "jane@example.com" });
		render(<AccountMenu />);
		fireEvent.click(await screen.findByRole("button", { name: /Jane Doe/ }));
		const menu = screen.getByRole("menu", { name: "Account" });

		fireEvent.mouseDown(menu);

		expect(screen.getByRole("menu", { name: "Account" })).toBeTruthy();
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @projektor/web exec vitest run src/islands/AccountMenu.test.tsx`
Expected: FAIL — `Failed to resolve import "./AccountMenu"` (the component doesn't exist yet).

- [ ] **Step 3: Implement `AccountMenu`**

Create `apps/web/src/islands/AccountMenu.tsx`:

```tsx
import { createPortal } from "preact/compat";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";
import { resolveWorkspaceSlug } from "../utils/workspace";

interface Props {
	workspaceSlug?: string;
}

interface MeResponse {
	user: { id: string; email: string; name: string };
}

const POPOVER_MARGIN = 8;

function initials(name: string, email: string): string {
	const source = name.trim() || email;
	const parts = source.split(/\s+/).filter(Boolean);
	if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
	return source.slice(0, 2).toUpperCase();
}

// PROJ-428: replaces the old unlabeled Log in/Log out emoji links. The app is
// entirely behind Cloudflare Access, so there's no true logged-out state to
// render here — "Refresh session" and "Log out" are manual escape hatches for
// re-challenging or ending the CF Access session (see apps/api/src/routes/auth.ts).
export function AccountMenu({ workspaceSlug }: Props) {
	const [user, setUser] = useState<{ email: string; name: string } | null>(null);
	const [failed, setFailed] = useState(false);
	const [open, setOpen] = useState(false);
	const [popoverPos, setPopoverPos] = useState<{ top: number; right: number } | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);
	const menuId = useId();

	useEffect(() => {
		let cancelled = false;
		apiFetch<MeResponse>("/auth/me", { workspaceSlug: resolveWorkspaceSlug(workspaceSlug) })
			.then((data) => {
				if (!cancelled) setUser({ email: data.user.email, name: data.user.name });
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, [workspaceSlug]);

	function isInside(node: Node) {
		return !!(rootRef.current?.contains(node) || popoverRef.current?.contains(node));
	}

	function openMenu() {
		const rect = triggerRef.current?.getBoundingClientRect();
		if (rect) {
			setPopoverPos({
				top: rect.bottom + 4,
				right: Math.max(POPOVER_MARGIN, window.innerWidth - rect.right),
			});
		}
		setOpen(true);
	}

	// PROJ-419-style portal: the top bar this menu lives in gets a CSS
	// `transform` when hidden on scroll (see Base.astro's .topbar-hidden),
	// which would otherwise become the containing block for a `position:
	// fixed` popover and break its positioning. Portalling to document.body
	// sidesteps that, same as GlossaryHelp's popover.
	useEffect(() => {
		if (!open) return;
		function onPointerDown(e: MouseEvent) {
			if (!(e.target instanceof Node) || !isInside(e.target)) setOpen(false);
		}
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape") {
				setOpen(false);
				triggerRef.current?.focus();
			}
		}
		document.addEventListener("mousedown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	if (failed) {
		return (
			<a href="/auth/login" class="account-menu-login">
				Log in
			</a>
		);
	}

	if (!user) {
		return (
			<button type="button" class="account-menu-trigger" disabled aria-label="Loading account">
				<span class="account-menu-avatar" aria-hidden="true">
					···
				</span>
			</button>
		);
	}

	const redirectTarget = typeof location !== "undefined" ? location.pathname + location.search : "/";

	return (
		<div class="account-menu" ref={rootRef}>
			<button
				ref={triggerRef}
				type="button"
				class="account-menu-trigger"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? menuId : undefined}
				onClick={() => (open ? setOpen(false) : openMenu())}
			>
				<span class="account-menu-avatar" aria-hidden="true">
					{initials(user.name, user.email)}
				</span>
				<span class="account-menu-name">{user.name || user.email}</span>
				<span class="account-menu-caret" aria-hidden="true">
					▾
				</span>
			</button>
			{open &&
				popoverPos &&
				createPortal(
					<div
						id={menuId}
						ref={popoverRef}
						class="account-menu-popover"
						style={{
							position: "fixed",
							top: `${popoverPos.top}px`,
							right: `${popoverPos.right}px`,
						}}
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
							<a role="menuitem" class="account-menu-item" href="/cdn-cgi/access/logout">
								Log out
							</a>
						</div>
					</div>,
					document.body
				)}
		</div>
	);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @projektor/web exec vitest run src/islands/AccountMenu.test.tsx`
Expected: PASS (all 8 tests).

- [ ] **Step 5: Type-check**

Run: `pnpm --filter @projektor/web run type-check`
Expected: no new errors attributable to `AccountMenu.tsx`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/islands/AccountMenu.tsx apps/web/src/islands/AccountMenu.test.tsx
git commit -m "PROJ-428: add AccountMenu island for signed-in state + session controls"
```

---

### Task 2: Wire `AccountMenu` into a top bar shown on every breakpoint

**Files:**
- Modify: `apps/web/src/layouts/Base.astro`

**Interfaces:**
- Consumes: `AccountMenu` from Task 1 (`../islands/AccountMenu`), rendered as `<AccountMenu client:load />` (no props — it resolves its own workspace slug).
- Produces: `#app-topbar` element and `.topbar-hidden` CSS class, which Task 3's scroll script targets.

- [ ] **Step 1: Import `AccountMenu`**

In `apps/web/src/layouts/Base.astro`, in the frontmatter imports:

```diff
 import { ClientRouter } from 'astro:transitions';
+import { AccountMenu } from '../islands/AccountMenu';
 import { GlossaryHelp } from '../islands/GlossaryHelp';
 import { OfflineBanner } from '../islands/OfflineBanner';
```

- [ ] **Step 2: Drop the sidebar's own brand row, keep only `.topbar-brand`'s styling**

Find this CSS (around line 310):

```css
      .sidebar-brand {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.25rem 0.5rem 0.75rem;
        color: var(--text);
        text-decoration: none;
        font-weight: 700;
        font-size: 1.0625rem;
        letter-spacing: -0.02em;
      }
      .sidebar-brand .brand-mark,
      .topbar-brand .brand-mark {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.75rem;
        height: 1.75rem;
        flex-shrink: 0;
        border-radius: 6px;
        background: var(--accent);
        color: var(--on-accent);
        font-size: 0.95rem;
        font-weight: 700;
      }
```

Replace it with:

```css
      .topbar-brand {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        text-decoration: none;
        color: var(--text);
        font-weight: 700;
        font-size: 1.0625rem;
        letter-spacing: -0.02em;
      }
      .topbar-brand .brand-mark {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.75rem;
        height: 1.75rem;
        flex-shrink: 0;
        border-radius: 6px;
        background: var(--accent);
        color: var(--on-accent);
        font-size: 0.95rem;
        font-weight: 700;
      }
```

- [ ] **Step 3: Offset the sidebar and main content by the top bar height on every breakpoint**

Find (around line 291):

```css
      .sidebar {
        position: fixed;
        top: 0;
        left: 0;
        bottom: 0;
        width: var(--sidebar-width);
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        padding: 1rem 0.75rem;
        background: var(--nav-bg);
        border-right: 1px solid var(--border);
        z-index: 100;
        overflow-y: auto;
      }
      .app-main {
        margin-left: var(--sidebar-width);
        min-width: 0;
      }
```

Replace with:

```css
      .sidebar {
        position: fixed;
        top: var(--topbar-height);
        left: 0;
        bottom: 0;
        width: var(--sidebar-width);
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        padding: 1rem 0.75rem;
        background: var(--nav-bg);
        border-right: 1px solid var(--border);
        z-index: 100;
        overflow-y: auto;
      }
      .app-main {
        margin-left: var(--sidebar-width);
        min-width: 0;
        padding-top: var(--topbar-height);
      }
```

- [ ] **Step 4: Replace the mobile-only top bar CSS with an always-on top bar**

Find this whole block (starts around line 399, `/* ── Mobile top bar...`, ends right before the `/* ── Custom Select` comment — i.e. everything from `.mobile-topbar { display: none; }` through the `.theme-toggle { padding: 0.5rem 0.625rem; min-height: 44px; }` line, but keep everything from `/* iOS Safari auto-zooms...` onward untouched):

```css
      /* ── Mobile top bar + hamburger (hidden on desktop) ───────────────── */
      .mobile-topbar { display: none; }
      .drawer-overlay { display: none; }

      @media (max-width: 640px) {
        /* Top app bar holds the hamburger + brand; fixed above content */
        .mobile-topbar {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          height: var(--topbar-height);
          padding: 0 0.5rem;
          background: var(--nav-bg);
          border-bottom: 1px solid var(--border);
          z-index: 90;
        }
        .hamburger {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 44px;
          height: 44px;
          flex-shrink: 0;
          border: none;
          background: none;
          color: var(--text);
          cursor: pointer;
          border-radius: 8px;
        }
        .hamburger:hover { background: var(--surface); }
        .hamburger:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
        .mobile-topbar .topbar-brand {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          text-decoration: none;
          color: var(--text);
          font-weight: 700;
          font-size: 1.0625rem;
          letter-spacing: -0.02em;
        }

        /* Sidebar becomes an off-canvas drawer */
        .sidebar {
          width: min(82vw, 280px);
          transform: translateX(-100%);
          transition: transform 0.22s ease;
          padding: 1rem 0.875rem;
          box-shadow: none;
        }
        .app-shell.drawer-open .sidebar {
          transform: translateX(0);
          box-shadow: 0 0 40px rgba(0, 0, 0, 0.35);
        }

        /* Dim + capture taps behind the drawer */
        .drawer-overlay {
          display: block;
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.45);
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.22s ease;
          z-index: 99;
        }
        .app-shell.drawer-open .drawer-overlay {
          opacity: 1;
          pointer-events: auto;
        }

        /* Content fills the width; offset only for the top bar */
        .app-main {
          margin-left: 0;
          padding-top: var(--topbar-height);
        }

        /* Roomier tap targets inside the drawer */
        .sidebar-link { padding: 0.6875rem 0.75rem; }
        .theme-toggle { padding: 0.5rem 0.625rem; min-height: 44px; }
```

Replace with:

```css
      /* ── App top bar: brand, hamburger (mobile only), account menu ────── */
      .app-topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: var(--topbar-height);
        padding: 0 0.75rem;
        background: var(--nav-bg);
        border-bottom: 1px solid var(--border);
        z-index: 110;
        transition: transform 0.2s ease;
      }
      .app-topbar.topbar-hidden { transform: translateY(-100%); }
      .app-topbar-start {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        min-width: 0;
      }
      .hamburger {
        display: none;
        align-items: center;
        justify-content: center;
        width: 44px;
        height: 44px;
        flex-shrink: 0;
        border: none;
        background: none;
        color: var(--text);
        cursor: pointer;
        border-radius: 8px;
      }
      .hamburger:hover { background: var(--surface); }
      .hamburger:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .drawer-overlay { display: none; }

      @media (max-width: 640px) {
        .hamburger { display: inline-flex; }

        /* Sidebar becomes an off-canvas drawer */
        .sidebar {
          width: min(82vw, 280px);
          transform: translateX(-100%);
          transition: transform 0.22s ease;
          padding: 1rem 0.875rem;
          box-shadow: none;
        }
        .app-shell.drawer-open .sidebar {
          transform: translateX(0);
          box-shadow: 0 0 40px rgba(0, 0, 0, 0.35);
        }

        /* Dim + capture taps behind the drawer */
        .drawer-overlay {
          display: block;
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.45);
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.22s ease;
          z-index: 99;
        }
        .app-shell.drawer-open .drawer-overlay {
          opacity: 1;
          pointer-events: auto;
        }

        /* Content fills the width; sidebar's own margin collapses too */
        .app-main { margin-left: 0; }

        /* Roomier tap targets inside the drawer */
        .sidebar-link { padding: 0.6875rem 0.75rem; }
        .theme-toggle { padding: 0.5rem 0.625rem; min-height: 44px; }
```

(Everything after this point — the iOS zoom-prevention rule, the PROJ-397 Select rule, and the closing `}` of the media query — is unchanged.)

- [ ] **Step 5: Add the `AccountMenu` CSS**

Find (around line 590, immediately before `</style>`):

```css
      .metric-help-popover {
        position: absolute;
        z-index: 200;
        top: calc(100% + 4px);
        left: 0;
        width: 16rem;
        max-width: min(16rem, 80vw);
        padding: 0.625rem 0.75rem;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: var(--shadow-sm);
        font-weight: normal;
        text-transform: none;
        letter-spacing: normal;
      }
    </style>
```

Replace with:

```css
      .metric-help-popover {
        position: absolute;
        z-index: 200;
        top: calc(100% + 4px);
        left: 0;
        width: 16rem;
        max-width: min(16rem, 80vw);
        padding: 0.625rem 0.75rem;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: var(--shadow-sm);
        font-weight: normal;
        text-transform: none;
        letter-spacing: normal;
      }

      /* ── Account menu (island) ─────────────────────────────────────── */
      .account-menu { position: relative; display: inline-flex; }
      .account-menu-trigger {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.25rem 0.625rem 0.25rem 0.25rem;
        border: 1px solid var(--border);
        border-radius: 999px;
        background: none;
        color: var(--text);
        font: inherit;
        font-size: 0.8125rem;
        font-weight: 500;
        cursor: pointer;
        line-height: 1;
      }
      .account-menu-trigger:hover { background: var(--surface); }
      .account-menu-trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .account-menu-trigger:disabled { cursor: default; opacity: 0.6; }
      .account-menu-avatar {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.5rem;
        height: 1.5rem;
        border-radius: 50%;
        background: var(--accent);
        color: var(--on-accent);
        font-size: 0.6875rem;
        font-weight: 700;
        flex-shrink: 0;
      }
      .account-menu-name {
        white-space: nowrap;
        max-width: 9rem;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .account-menu-caret { font-size: 0.625rem; opacity: 0.6; }
      .account-menu-login {
        display: inline-flex;
        align-items: center;
        padding: 0.375rem 0.75rem;
        border: 1px solid var(--border);
        border-radius: 6px;
        color: var(--text-muted);
        text-decoration: none;
        font-size: 0.8125rem;
      }
      .account-menu-login:hover { color: var(--text); }
      .account-menu-popover {
        z-index: 200;
        width: 14rem;
        max-width: min(14rem, 85vw);
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 8px;
        box-shadow: var(--shadow-sm);
        padding: 0.375rem;
        font-size: 0.875rem;
      }
      .account-menu-identity {
        padding: 0.375rem 0.5rem 0.5rem;
        border-bottom: 1px solid var(--border);
        margin-bottom: 0.25rem;
      }
      .account-menu-identity-name { font-weight: 600; color: var(--text); }
      .account-menu-identity-email {
        font-size: 0.75rem;
        color: var(--text-muted);
        overflow-wrap: break-word;
      }
      .account-menu-item {
        display: block;
        padding: 0.5rem 0.5rem;
        border-radius: 6px;
        color: var(--text);
        text-decoration: none;
        font-size: 0.8125rem;
      }
      .account-menu-item:hover { background: var(--surface); }
      .account-menu-item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

      @media (max-width: 640px) {
        .account-menu-name { display: none; }
      }
    </style>
```

- [ ] **Step 6: Replace the `<header class="mobile-topbar">` markup**

Find (around line 596):

```astro
      <header class="mobile-topbar">
        <button
          class="hamburger"
          type="button"
          aria-label="Open navigation menu"
          aria-controls="app-sidebar"
          aria-expanded="false"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </button>
        <a href="/" class="topbar-brand">
          <span class="brand-mark">P</span>
          <span>Projektor</span>
        </a>
      </header>
```

Replace with:

```astro
      <header class="app-topbar" id="app-topbar">
        <div class="app-topbar-start">
          <button
            class="hamburger"
            type="button"
            aria-label="Open navigation menu"
            aria-controls="app-sidebar"
            aria-expanded="false"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          <a href="/" class="topbar-brand">
            <span class="brand-mark">P</span>
            <span>Projektor</span>
          </a>
        </div>
        <AccountMenu client:load />
      </header>
```

- [ ] **Step 7: Drop the sidebar's own brand row**

Find (around line 614):

```astro
      <aside class="sidebar" id="app-sidebar">
        <a href="/" class="sidebar-brand">
          <span class="brand-mark">P</span>
          <span class="brand-text">Projektor</span>
        </a>

        <nav class="sidebar-nav" aria-label="Primary">
```

Replace with:

```astro
      <aside class="sidebar" id="app-sidebar">
        <nav class="sidebar-nav" aria-label="Primary">
```

- [ ] **Step 8: Remove the old Log in / Log out links from the sidebar footer**

Find (around line 649):

```astro
        <div class="sidebar-footer">
          <a href="/help" class="theme-toggle" aria-label="Help — glossary of terms" title="Help">?</a>
          <a href="/" class="theme-toggle" aria-label="Log in — refresh your session" title="Log in">🔑</a>
          <a href="/cdn-cgi/access/logout" class="theme-toggle" aria-label="Log out" title="Log out">🚪</a>
          <button class="theme-toggle" aria-label="Toggle colour scheme">🌙</button>
        </div>
```

Replace with:

```astro
        <div class="sidebar-footer">
          <a href="/help" class="theme-toggle" aria-label="Help — glossary of terms" title="Help">?</a>
          <button class="theme-toggle" aria-label="Toggle colour scheme">🌙</button>
        </div>
```

- [ ] **Step 9: Run the full web test suite and type-check**

Run: `pnpm --filter @projektor/web run test`
Expected: PASS — no test references `.mobile-topbar`, `.sidebar-brand`, or the removed login/logout links (confirmed earlier via grep across `apps/web`).

Run: `pnpm --filter @projektor/web run type-check`
Expected: no new errors.

- [ ] **Step 10: Manual verification (dev server)**

Run: `pnpm --filter @projektor/web run dev`

Desktop (viewport ≥ 641px):
- A top bar spans the full width above the sidebar and content, showing the "P Projektor" brand on the left and the account chip (avatar + name + caret) on the right.
- The sidebar no longer shows its own "P Projektor" row — nav starts at the top.
- Sidebar footer shows only "?" (Help) and the theme toggle — no key/door emoji.
- Clicking the account chip opens a menu with "Refresh session" and "Log out"; clicking outside or pressing Escape closes it.

Mobile (resize to ≤ 640px, or use browser device toolbar):
- Top bar shows hamburger + brand + account chip (name text hidden, avatar-only).
- Hamburger still opens/closes the off-canvas drawer as before.
- Drawer footer shows only Help + theme toggle.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/layouts/Base.astro
git commit -m "PROJ-428: render AccountMenu in a top bar shown on every breakpoint"
```

---

### Task 3: Scroll-to-hide the top bar

**Files:**
- Modify: `apps/web/src/layouts/Base.astro`

**Interfaces:**
- Consumes: `#app-topbar` and `.topbar-hidden` from Task 2; `.app-shell.drawer-open` (existing) and `.account-menu-popover` (from Task 1, present in the DOM only while the account menu is open) as signals to suppress hiding.
- Produces: none consumed elsewhere.

- [ ] **Step 1: Add the scroll-hide inline script**

Find the end of the existing theme-toggle script, right before `</body>` (around line 737):

```astro
    </script>
  </body>
</html>
```

Replace with:

```astro
    </script>
    <!-- PROJ-428: hide the top bar on scroll-down, reveal on scroll-up, so it
         doesn't permanently eat vertical space on long pages. Suppressed while
         the mobile drawer or the account menu popover is open so the bar can't
         disappear mid-interaction. rAF-throttled since scroll fires far more
         often than a frame renders. -->
    <script is:inline>
      (function () {
        var lastY = 0;
        var accumulatedDown = 0;
        var HIDE_THRESHOLD = 8;
        var ticking = false;

        function shouldStayVisible() {
          var shell = document.querySelector('.app-shell');
          var menuOpen = document.querySelector('.account-menu-popover');
          return !!(shell && shell.classList.contains('drawer-open')) || !!menuOpen;
        }

        function onScroll() {
          if (ticking) return;
          ticking = true;
          requestAnimationFrame(function () {
            ticking = false;
            var topbar = document.getElementById('app-topbar');
            if (!topbar) return;
            var y = window.scrollY;
            if (shouldStayVisible() || y <= 0) {
              topbar.classList.remove('topbar-hidden');
              accumulatedDown = 0;
              lastY = y;
              return;
            }
            var delta = y - lastY;
            if (delta > 0) {
              accumulatedDown += delta;
              if (accumulatedDown > HIDE_THRESHOLD) topbar.classList.add('topbar-hidden');
            } else {
              accumulatedDown = 0;
              topbar.classList.remove('topbar-hidden');
            }
            lastY = y;
          });
        }

        window.addEventListener('scroll', onScroll, { passive: true });
        document.addEventListener('astro:after-swap', function () {
          var topbar = document.getElementById('app-topbar');
          if (topbar) topbar.classList.remove('topbar-hidden');
          lastY = window.scrollY;
          accumulatedDown = 0;
        });
      })();
    </script>
  </body>
</html>
```

- [ ] **Step 2: Manual verification (dev server)**

Run: `pnpm --filter @projektor/web run dev` (if not already running) and open a page with enough content to scroll (e.g. an issues list with several items, or resize the window short).

Desktop and mobile, each:
- Scrolling down past ~8px hides the top bar (slides up, content underneath is unaffected since the bar was `position: fixed`).
- Scrolling back up immediately reveals it again.
- At the very top of the page, the bar is always visible.
- Opening the account menu (or, on mobile, the drawer) keeps the bar visible even while scrolling.
- No layout shift or flash when the bar hides/shows.

- [ ] **Step 3: Run the full web test suite once more**

Run: `pnpm --filter @projektor/web run test`
Expected: PASS (this step is a plain `<script is:inline>` addition with no new component, so no new automated coverage is expected beyond the manual check above).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/layouts/Base.astro
git commit -m "PROJ-428: hide the top bar on scroll-down, show on scroll-up"
```

---

## Post-implementation

- Comment progress on PROJ-428 (`mcp__projektor__add_comment`) summarizing the change, link the PR once opened.
- Submit the projektor completion report (`summary` + `verification`, `prLink`) before moving the issue to Done, per the workflow spec.
