import { useEffect, useRef } from "preact/hooks";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

interface Props {
	data: uPlot.AlignedData;
	buildOptions: (width: number, height: number) => uPlot.Options;
	height?: number;
}

// uPlot is vanilla JS/canvas, not Preact-aware — it must be manually created/destroyed
// against a ref'd container rather than rendered as JSX. `buildOptions` is re-invoked
// (and the chart rebuilt) whenever the theme flips, since uPlot bakes colors into the
// canvas at creation time rather than reading CSS live.
export default function UplotChart({ data, buildOptions, height = 220 }: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const chartRef = useRef<uPlot | null>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		function create(el: HTMLDivElement) {
			chartRef.current?.destroy();
			const width = el.clientWidth || 600;
			chartRef.current = new uPlot(buildOptions(width, height), data, el);
		}

		create(container);

		const themeObserver = new MutationObserver((mutations) => {
			if (mutations.some((m) => m.attributeName === "data-theme")) create(container);
		});
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme"],
		});

		const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
		const onSystemThemeChange = () => {
			// Only the system query matters when the user hasn't picked an explicit theme.
			if (!document.documentElement.getAttribute("data-theme")) create(container);
		};
		systemTheme.addEventListener("change", onSystemThemeChange);

		// Width is baked into series/axis options (e.g. tick-thinning reads u.width at
		// creation time), so a resize needs a full rebuild, not just uPlot's setSize —
		// otherwise a window resize or mobile orientation change leaves stale tick density.
		let lastWidth = container.clientWidth;
		const resizeObserver = new ResizeObserver((entries) => {
			const newWidth = entries[0]?.contentRect.width;
			if (newWidth && Math.abs(newWidth - lastWidth) > 1) {
				lastWidth = newWidth;
				create(container);
			}
		});
		resizeObserver.observe(container);

		return () => {
			themeObserver.disconnect();
			systemTheme.removeEventListener("change", onSystemThemeChange);
			resizeObserver.disconnect();
			chartRef.current?.destroy();
			chartRef.current = null;
		};
	}, [data, buildOptions, height]);

	return <div ref={containerRef} class="w-full" />;
}

interface TooltipPluginOpts {
	formatX: (xVal: number) => string;
	formatY: (yVal: number) => string;
}

// Single-series charts don't need uPlot's default cursor-sync legend (swatches/toggles
// are pointless with one series); this replaces it with a small hover tooltip instead.
export function createTooltipPlugin({ formatX, formatY }: TooltipPluginOpts): uPlot.Plugin {
	let tooltip: HTMLDivElement;

	return {
		hooks: {
			init: (u) => {
				tooltip = document.createElement("div");
				Object.assign(tooltip.style, {
					position: "absolute",
					pointerEvents: "none",
					padding: "4px 8px",
					borderRadius: "4px",
					fontSize: "0.75rem",
					fontWeight: "500",
					whiteSpace: "nowrap",
					background: "var(--surface)",
					border: "1px solid var(--border)",
					color: "var(--text)",
					boxShadow: "var(--elevation-sm)",
					zIndex: "10",
					display: "none",
				});
				u.over.appendChild(tooltip);
			},
			setCursor: (u) => {
				const idx = u.cursor.idx;
				const yVal = idx == null ? null : (u.data[1][idx] as number | null | undefined);
				if (idx == null || yVal == null) {
					tooltip.style.display = "none";
					return;
				}
				const xVal = u.data[0][idx] as number;
				tooltip.textContent = `${formatX(xVal)}: ${formatY(yVal)}`;
				const left = u.cursor.left ?? 0;
				const top = u.cursor.top ?? 0;
				tooltip.style.left = `${left + 12}px`;
				tooltip.style.top = `${Math.max(0, top - 8)}px`;
				tooltip.style.display = "block";
			},
		},
	};
}
