// Test helper for islands that branch on `window.innerWidth` directly in JS
// (e.g. BoardView disabling HTML5 drag below 640px). jsdom doesn't evaluate CSS,
// so this can't prove a `max-sm:` class actually hides/shows anything at
// runtime — it only fakes the JS-visible viewport signal. For CSS-only
// responsive behavior there's nothing to assert here beyond the class names
// themselves.
import { afterEach } from "vitest";

export const MOBILE_WIDTH = 375;
// cofferdam-ignore: Design.OrphanExport: exported alongside MOBILE_WIDTH for symmetry; used internally for the afterEach reset today
export const DESKTOP_WIDTH = 1024;

export function setViewportWidth(width: number): void {
	Object.defineProperty(window, "innerWidth", {
		writable: true,
		configurable: true,
		value: width,
	});
	window.dispatchEvent(new Event("resize"));
}

// Reset to a desktop width after every test so viewport state never leaks
// between test files.
afterEach(() => {
	setViewportWidth(DESKTOP_WIDTH);
});
