// Viewer address for the per-IP rate limit. Nothing here is stored: the address only feeds a salted hash that changes
// every minute (app.mjs), and the hash lives in DynamoDB for about two minutes (TTL).
//
// CloudFront passes the viewer as `CloudFront-Viewer-Address: <ip>:<port>` (origin request policy); viewers cannot set it.
// Production sits behind the Cloudflare proxy, so there the viewer is a Cloudflare address and the player is in
// `CF-Connecting-IP`. That header is trusted only when the CloudFront viewer really is Cloudflare: anyone calling the
// CloudFront host directly could otherwise rotate a fake header to escape the limit.

// https://www.cloudflare.com/ips/ (2026-09); a stale list only means Cloudflare traffic is limited per Cloudflare node
const CLOUDFLARE_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];
const CLOUDFLARE_V6 = ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'];

function v4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.some((x) => x > 255) ? null : ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

/** IPv6 text → 8 numbers (null if invalid). Accepts "::" compression and a trailing dotted IPv4. */
export function v6(ip) {
  let s = ip.toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(s) || !s.includes(':')) return null;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const n = v4(tail[1]);
    if (n === null) return null;
    s = s.slice(0, -tail[1].length) + ((n >>> 16).toString(16)) + ':' + ((n & 0xffff).toString(16));
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const parts = [...head, ...Array(fill).fill('0'), ...rest];
  if (parts.length !== 8 || parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.map((p) => parseInt(p, 16));
}

const V4_NETS = CLOUDFLARE_V4.map((c) => { const [a, b] = c.split('/'); return [v4(a), Number(b)]; });
const V6_NETS = CLOUDFLARE_V6.map((c) => { const [a, b] = c.split('/'); return [v6(a), Number(b)]; });

export function isCloudflare(ip) {
  const a = v4(ip);
  if (a !== null) return V4_NETS.some(([net, bits]) => (bits === 0 || ((a ^ net) >>> (32 - bits)) === 0));
  const b = v6(ip);
  if (!b) return false;
  return V6_NETS.some(([net, bits]) => {
    for (let i = 0, left = bits; left > 0; i++, left -= 16) {
      const k = Math.min(16, left);
      if ((b[i] >>> (16 - k)) !== (net[i] >>> (16 - k))) return false;
    }
    return true;
  });
}

/** The player's address from the forwarded headers ('' when absent: then everyone without it shares one bucket). */
export function viewerIp(headers) {
  const raw = String(headers['cloudfront-viewer-address'] || '').trim();
  let ip = raw.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const cf = String(headers['cf-connecting-ip'] || '').trim();
  if (ip && cf && isCloudflare(ip) && (v4(cf) !== null || v6(cf))) ip = cf;
  return ip;
}

/** Rate-limit bucket: an IPv4 address, or the /64 network of an IPv6 address (one subscriber usually has a whole /64). */
export function ipBucket(ip) {
  if (v4(ip) !== null) return ip;
  const b = v6(ip);
  return b ? b.slice(0, 4).map((x) => x.toString(16)).join(':') + '::/64' : 'unknown';
}
