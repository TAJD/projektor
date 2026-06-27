// Vite ?raw query — inlined as string literals at bundle time.
declare module "*?raw" {
	const content: string;
	export default content;
}
