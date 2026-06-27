export async function get<T>(kv: KVNamespace, key: string): Promise<T | null> {
	return kv.get<T>(key, { type: "json" });
}

export async function set<T>(
	kv: KVNamespace,
	key: string,
	value: T,
	ttlSeconds: number
): Promise<void> {
	await kv.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
}

export async function invalidate(kv: KVNamespace, key: string): Promise<void> {
	await kv.delete(key);
}
