import { useEffect, useId, useRef, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";
import { clearAllDrafts } from "../utils/drafts";
import { PUBLIC_VIEWER_EMAIL } from "../utils/public-viewer";
import { resolveWorkspaceSlug } from "../utils/workspace";
import { Popover } from "./ui/Popover";

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

function AccountMenuPopover({
	menuId,
	popoverRef,
	pos,
	user,
	redirectTarget,
}: {
	menuId: string;
	popoverRef: { current: HTMLDivElement | null };
	pos: { top: number; right: number };
	user: { email: string; name: string };
	redirectTarget: string;
}) {
	return (
		<Popover
			id={menuId}
			strategy="portal-fixed"
			class="popover-account-menu"
			elementRef={popoverRef}
			position={pos}
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
		</Popover>
	);
}

function useAccountUser(workspaceSlug: string | undefined) {
	const [user, setUser] = useState<{ email: string; name: string } | null>(null);
	const [failed, setFailed] = useState(false);

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

	return { user, failed };
}

// PROJ-419-style portal: the top bar this menu lives in gets a CSS
// `transform` when hidden on scroll (see Base.astro's .topbar-hidden),
// which would otherwise become the containing block for a `position:
// fixed` popover and break its positioning. Portalling to document.body
// sidesteps that, same as GlossaryHelp's popover.
function useCloseOnOutsideOrEscape(
	open: boolean,
	isInside: (node: Node) => boolean,
	onOutsideClick: () => void,
	onEscape: () => void
) {
	useEffect(() => {
		if (!open) return;
		function onPointerDown(e: MouseEvent) {
			if (!(e.target instanceof Node) || !isInside(e.target)) onOutsideClick();
		}
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape") onEscape();
		}
		document.addEventListener("mousedown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);
}

// PROJ-428: replaces the old unlabeled Log in/Log out emoji links. The app is
// entirely behind Cloudflare Access, so there's no true logged-out state to
// render here — "Refresh session" and "Log out" are manual escape hatches for
// re-challenging or ending the CF Access session (see apps/api/src/routes/auth.ts).
export function AccountMenu({ workspaceSlug }: Props) {
	const { user, failed } = useAccountUser(workspaceSlug);
	const [open, setOpen] = useState(false);
	const [popoverPos, setPopoverPos] = useState<{ top: number; right: number } | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);
	const menuId = useId();

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

	useCloseOnOutsideOrEscape(
		open,
		isInside,
		() => setOpen(false),
		() => {
			setOpen(false);
			triggerRef.current?.focus();
		}
	);

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
			{open && popoverPos && (
				<AccountMenuPopover
					menuId={menuId}
					popoverRef={popoverRef}
					pos={popoverPos}
					user={user}
					redirectTarget={redirectTarget}
				/>
			)}
		</div>
	);
}
