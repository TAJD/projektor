import { createPortal } from "preact/compat";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";
import { clearAllDrafts } from "../utils/drafts";
import { resolveWorkspaceSlug } from "../utils/workspace";

interface Props {
	workspaceSlug?: string;
}

interface MeResponse {
	user: { id: string; email: string; name: string };
}

const POPOVER_MARGIN = 8;
// PROJ-373 anonymous fallback — apps/api/src/middleware/auth.ts
const PUBLIC_VIEWER_EMAIL = "public-viewer@projektor.local";

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
		apiFetch<MeResponse>("/auth/me", {
			workspaceSlug: resolveWorkspaceSlug(workspaceSlug),
			on401: "throw",
		})
			.then((data) => {
				if (cancelled) return;
				if (data.user.email === PUBLIC_VIEWER_EMAIL) {
					setFailed(true);
					return;
				}
				setUser({ email: data.user.email, name: data.user.name });
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

	const redirectTarget = typeof location !== "undefined" ? location.href : "/";

	return (
		<div class="account-menu" ref={rootRef}>
			<button
				ref={triggerRef}
				type="button"
				class="account-menu-trigger"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? menuId : undefined}
				aria-label={`Account: ${user.name || user.email}`}
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
							<a
								role="menuitem"
								class="account-menu-item"
								href="/cdn-cgi/access/logout"
								// PROJ-431: don't leave one user's unsent drafts on a shared device.
								onClick={() => clearAllDrafts()}
							>
								Log out
							</a>
						</div>
					</div>,
					document.body
				)}
		</div>
	);
}
