import { useEffect, useRef } from "preact/hooks";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

interface Props {
	data: uPlot.AlignedData;
	options: uPlot.Options;
	height?: number;
}

// uPlot is vanilla JS/canvas, not Preact-aware — it must be manually created/destroyed
// against a ref'd container rather than rendered as JSX.
export default function UplotChart({ data, options, height = 220 }: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const chartRef = useRef<uPlot | null>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const width = container.clientWidth || 600;
		const chart = new uPlot({ ...options, width, height }, data, container);
		chartRef.current = chart;

		return () => {
			chart.destroy();
			chartRef.current = null;
		};
	}, [data, options, height]);

	return <div ref={containerRef} class="w-full" />;
}
