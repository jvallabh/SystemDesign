/**
 * One-time helper: resolves lnkd.in shortlinks to their real destinations.
 * lnkd.in serves an interstitial HTML page (no HTTP redirect) containing the
 * target URL; some codes 301 to another lnkd.in code first.
 *
 * Usage: node scripts/resolve-links.mjs <code> [<code> ...]
 * Prints "<code> -> <url>" per line; failures print UNRESOLVED so they can
 * be filled into src/data/resources.json by hand.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

async function resolve(code, depth = 0) {
  if (depth > 3) return null;
  const res = await fetch(`https://lnkd.in/${code}`, {
    headers: { 'User-Agent': UA },
    redirect: 'manual',
  });

  const location = res.headers.get('location');
  if (location) {
    const next = location.match(/lnkd\.in\/([\w-]+)/);
    if (next) return resolve(next[1], depth + 1);
    return location;
  }

  const html = await res.text();
  const candidates = html.match(/https?:\/\/[^"<> ]+/g) ?? [];
  return (
    candidates.find((u) => !/lnkd\.in|linkedin\.com|licdn\.com/i.test(u)) ?? null
  );
}

const codes = process.argv.slice(2);
if (codes.length === 0) {
  console.error('usage: node scripts/resolve-links.mjs <lnkd.in code> ...');
  process.exit(1);
}

for (const code of codes) {
  try {
    const url = await resolve(code);
    console.log(`${code} -> ${url ?? 'UNRESOLVED'}`);
  } catch (err) {
    console.log(`${code} -> UNRESOLVED (${err.message})`);
  }
}
