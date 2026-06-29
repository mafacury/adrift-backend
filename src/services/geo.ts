// Country detection via ip-api.com (free, no key required, 45 req/min per IP)
// Only ever resolves to a 2-letter country code — no precise coordinates stored.

export async function countryFromIp(ip: string): Promise<string> {
  if (!ip || ip === '127.0.0.1' || ip === '::1') return 'XX';

  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=countryCode`);
    if (!res.ok) return 'XX';
    const data = (await res.json()) as { countryCode?: string };
    return data.countryCode ?? 'XX';
  } catch {
    return 'XX';
  }
}
