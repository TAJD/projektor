# PROJ-428: Login/logout button placement and styling redesign

## Problem

PR #133 added manual "Log in" / "Log out" controls as an escape hatch for
refreshing or ending the Cloudflare Access session. They shipped as two
unlabeled emoji links (🔑 / 🚪) tucked into the sidebar footer, always shown
regardless of session state, with the "Log in" link pointing at `/` instead
of a real re-auth endpoint. PROJ-428 asks for a design pass: remove the
emojis, give the controls a standard placement, and show a clear signed-in
state.

## Current state (relevant code)

- `apps/web/src/layouts/Base.astro` — the only layout; renders the sidebar
  (desktop, always visible) and a separate `.mobile-topbar` (hamburger +
  brand, `<=640px` only). Sidebar footer holds Help, Log in, Log out, theme
  toggle, as flat `.theme-toggle`-styled icon buttons/links.
- `apps/api/src/routes/auth.ts` — already exposes `GET /auth/login` (proper
  CF Access login redirect, accepts `redirect_url`) and `GET /auth/me`
  (returns `{ user: { id, email, name }, workspaces }` for the authenticated
  caller). Neither is used by the current login link.
- `apps/web/src/islands/MyIssues.tsx` — existing example of calling
  `apiFetch('/auth/me', { workspaceSlug })` from a Preact island.

## Design

### Components

- **`.app-topbar`** (replaces `.mobile-topbar`): now renders on all
  breakpoints, not just mobile. Left side: `P Projektor` brand link (moved
  here from the sidebar). Right side: the new `AccountMenu` island.
  Hamburger button stays in the topbar but is only visible under the
  existing 640px breakpoint (desktop sidebar nav needs no toggle).
- **Sidebar**: drops its own brand row (now redundant with the topbar's).
  Nav starts at the top. Footer keeps Help + theme toggle only — login/
  logout move out entirely.
- **`AccountMenu`** (new Preact island, `client:load`, same shape as
  `GlossaryHelp`/`MyIssues`): on mount, calls
  `apiFetch('/auth/me', { workspaceSlug })`. Renders a trigger button —
  avatar (initials, derived from `user.name`/`user.email`) plus the name
  (hidden below a width threshold, chip-only) plus a caret. Clicking opens
  an accessible dropdown:
  - **Refresh session** → navigates to `/auth/login?redirect_url=<current
    path>` (real CF Access re-auth, replacing today's dead `href="/"`).
  - **Log out** → `/cdn-cgi/access/logout` (unchanged target).

  Menu semantics: `aria-haspopup="menu"` + `aria-expanded` on the trigger,
  `role="menu"` / `role="menuitem"` on the popover/items, closes on
  Escape or a click outside, focus returns to the trigger on close.

  **Error/loading state**: while loading, the trigger shows a neutral
  placeholder (no name/avatar yet). If `/auth/me` fails, the component
  falls back to a plain "Log in" link to `/auth/login` — no dropdown, and
  never blocks access to the rest of the app.

### Scroll-to-hide

A small `is:inline` script (same style as the existing drawer/theme-toggle
scripts already in `Base.astro`) adds scroll-direction tracking:

- Passive, `requestAnimationFrame`-throttled scroll listener.
- Scrolling down past a small threshold (~8px of cumulative delta) adds
  `.topbar-hidden` to `.app-topbar`, which slides it up via
  `transform: translateY(-100%)` with a transition.
- Scrolling up, or being near the top of the page, removes the class.
- Suppressed (topbar forced visible, listener effectively a no-op) while
  the mobile drawer or the account menu popover is open, so the bar can't
  disappear mid-interaction.
- Applies uniformly on desktop and mobile.

Because the topbar is `position: fixed`, hiding it doesn't reflow content —
`--topbar-height` (existing CSS var) continues to reserve the same space
in `.app-main` and `.sidebar` regardless of hidden state.

### Layout changes

- `.app-main` gets `padding-top: var(--topbar-height)` at all breakpoints
  (today this is mobile-only).
- `.sidebar` gets `top: var(--topbar-height)` and its height is reduced by
  the same amount, on desktop too (today the desktop sidebar spans full
  viewport height with no topbar to account for).
- `.mobile-topbar` styles are renamed/generalized to `.app-topbar` and its
  `display: none` default (desktop-hidden) is removed; the hamburger button
  alone remains breakpoint-gated.

### Data flow

No backend changes. `AccountMenu` reuses `/auth/me` and `/auth/login`
exactly as they exist today, following the `apiFetch` + `resolveWorkspaceSlug`
pattern already used in `MyIssues.tsx`.

### Error handling

- `/auth/me` network/API failure → fallback "Log in" link, described above.
- The existing 401-triggers-reload logic in `api-client.ts` (PR #133) is
  unaffected and orthogonal to this change.

## Testing

- **Unit** (vitest + testing-library, mirroring `MyIssues.test.tsx`): new
  `AccountMenu.test.tsx` covering loading → loaded (name/avatar shown),
  dropdown open/close (click + Escape + click-outside), and the `/auth/me`
  failure → login-link fallback.
- **Manual** (dev server, desktop + mobile viewport): topbar renders with
  brand + account menu on both; scroll down hides it, scroll up (or menu
  open) shows it; account menu keyboard nav (Tab to trigger, Enter to
  open, Escape to close); Refresh session and Log out links resolve to the
  right URLs; no emojis anywhere in the control; no console errors.

## Out of scope

- Any change to how CF Access itself authenticates or issues sessions.
- Showing workspace-switching or other `/auth/me` fields beyond name/email
  for the avatar/label.
