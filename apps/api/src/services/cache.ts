export async function get<T>(kv: KVNamespace, key: string): Promise<T | null> {
	try {
		return await kv.get<T>(key, { type: "json" });
	} catch (err) {
		console.error(`[cache] get failed for key "${key}", treating as a cache miss:`, err);
		return null;
	}
}

export async function set<T>(
	kv: KVNamespace,
	key: string,
	value: T,
	ttlSeconds: number
): Promise<void> {
	try {
		await kv.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
	} catch (err) {
		console.error(`[cache] set failed for key "${key}", continuing without caching:`, err);
	}
}

export async function invalidate(kv: KVNamespace, key: string): Promise<void> {
	try {
		await kv.delete(key);
	} catch (err) {
		console.error(
			`[cache] invalidate failed for key "${key}", entry may be stale until TTL expiry:`,
			err
		);
	}
}

export interface LocalCache<T> {
	get(key: string): T | undefined;
	set(key: string, value: T): void;
	invalidate(key: string): void;
}

export function createLocalCache<T>(ttlMs: number): LocalCache<T> {
	const store = new Map<string, { value: T; expiresAt: number }>();
	return {
		get(key) {
			const hit = store.get(key);
			return hit && hit.expiresAt > Date.now() ? hit.value : undefined;
		},
		set(key, value) {
			store.set(key, { value, expiresAt: Date.now() + ttlMs });
		},
		invalidate(key) {
			store.delete(key);
		},
	};
}
