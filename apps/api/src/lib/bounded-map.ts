export const ISOLATE_CACHE_MAX_ENTRIES = 1000;

export function setBounded<K, V>(
	map: Map<K, V>,
	key: K,
	value: V,
	max: number = ISOLATE_CACHE_MAX_ENTRIES
): void {
	map.delete(key);
	while (map.size >= max) {
		const oldest = map.keys().next();
		if (oldest.done) break;
		map.delete(oldest.value);
	}
	map.set(key, value);
}
