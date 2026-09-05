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
