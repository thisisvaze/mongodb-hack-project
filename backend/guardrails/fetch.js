// Guardrail 5: safe image downloads.
//
// The glasses send `image_url`, a signed link the server downloads straight
// away (docs/api-contract.md). Because the client chooses the URL, a careless
// download lets anyone make the server fetch internal addresses (SSRF), hang on
// a slow server, or fill memory with a huge file. This module:
//   - accepts https only, on the default port, with no user:password@ part
//   - optionally accepts only listed hosts (for example the Mentra storage host)
//   - resolves the host once, refuses private, loopback, link-local and other
//     internal addresses, and connects to that exact address (no DNS rebinding)
//   - follows at most 3 redirects, checking every hop the same way
//   - stops after a total time limit and a byte limit while downloading
//   - checks the reply is really a JPEG or PNG by its first bytes

import https from 'node:https';
import http from 'node:http';
import dns from 'node:dns';
import net from 'node:net';
import { GuardrailError } from './errors.js';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 5_000;
export const MAX_REDIRECTS = 3;

const bad = (message) => new GuardrailError(400, message);

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

const V4_BLOCKED = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including 255.255.255.255
];

const v4ToInt = (ip) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
const inRange = (ip, [base, bits]) => {
  const size = 2 ** (32 - bits);
  return Math.floor(v4ToInt(ip) / size) === Math.floor(v4ToInt(base) / size);
};

// True for any address the server must never connect to on a client's behalf.
export function isBlockedAddress(address) {
  if (net.isIPv4(address)) return V4_BLOCKED.some((range) => inRange(address, range));
  if (!net.isIPv6(address)) return true; // not an IP at all
  const a = address.toLowerCase();
  // IPv4 written inside IPv6 (::ffff:10.0.0.1, ::10.0.0.1): check the IPv4 part.
  const embedded = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (embedded) return isBlockedAddress(embedded[1]);
  if (a === '::' || a === '::1') return true;
  const first = parseInt(a.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (a.startsWith('64:ff9b:')) return true; // NAT64, maps to IPv4
  if (a.startsWith('2001:db8:')) return true; // documentation
  return false;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

// Checks the URL itself, before any network use. Returns the parsed URL.
//   allowedHosts: optional list such as ["mentra.glass", "s3.amazonaws.com"];
//                 a host matches itself or any subdomain of it.
//   allowHttp:    tests only.
export function checkImageUrl(raw, { allowedHosts = null, allowHttp = false } = {}) {
  if (typeof raw !== 'string' || raw.length > 4096) throw bad('image_url must be a URL string of at most 4096 characters');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw bad('image_url is not a valid URL');
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) throw bad('image_url must use https');
  if (url.username || url.password) throw bad('image_url must not contain a user name or password');
  if (url.port && !allowHttp) throw bad('image_url must use the default https port');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw bad('image_url has no host');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw bad('image_url must not point at a local or internal host');
  }
  if (allowedHosts && !allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw bad(`image_url host ${host} is not an allowed image host`);
  }
  return url;
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

// The image type from its first bytes, or null.
export function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

// Resolves the host and refuses blocked addresses. Every address the name
// resolves to must be allowed, so a name cannot mix a public and a private one.
async function resolveAllowed(host, { lookup, blockAddress }) {
  const literal = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : null;
  const addresses = literal ?? (await lookup(host, { all: true }));
  if (!addresses.length) throw bad(`image_url host ${host} did not resolve`);
  const blocked = addresses.find((a) => blockAddress(a.address));
  if (blocked) throw bad(`image_url host ${host} points at an internal address, which is not allowed`);
  return addresses[0];
}

function requestOnce(url, pinned, { deadline, maxBytes, allowHttp }) {
  const client = url.protocol === 'http:' && allowHttp ? http : https;
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(bad('image_url took too long to download'));
    const req = client.get(url, {
      // Connect to the address already checked, whatever DNS says now.
      lookup: (_host, options, cb) => (options?.all ? cb(null, [pinned]) : cb(null, pinned.address, pinned.family)),
      headers: { accept: 'image/jpeg, image/png' },
      timeout: remaining,
    });
    const timer = setTimeout(() => req.destroy(bad('image_url took too long to download')), remaining);
    const finish = (fn, value) => {
      clearTimeout(timer);
      fn(value);
    };
    req.on('timeout', () => req.destroy(bad('image_url took too long to download')));
    req.on('error', (err) => finish(reject, err instanceof GuardrailError ? err : bad(`image_url could not be downloaded: ${err.message}`)));
    req.on('response', (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        return finish(resolve, { redirect: res.headers.location ?? null });
      }
      if (res.statusCode !== 200) {
        res.resume();
        return finish(reject, bad(`image_url returned status ${res.statusCode}`));
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.destroy();
        return finish(reject, bad(`image_url is larger than ${maxBytes} bytes`));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        // Stop as soon as the limit is passed, instead of reading it all first.
        if (size > maxBytes) return req.destroy(bad(`image_url is larger than ${maxBytes} bytes`));
        chunks.push(chunk);
      });
      res.on('end', () => finish(resolve, { body: Buffer.concat(chunks) }));
      res.on('error', (err) => finish(reject, err instanceof GuardrailError ? err : bad(`image_url download failed: ${err.message}`)));
    });
  });
}

// Downloads an image the client pointed at. Returns { buf, type, url }.
// Throws GuardrailError(400) for anything refused, with a message safe to show.
export async function fetchImage(raw, options = {}) {
  const {
    allowedHosts = null,
    maxBytes = MAX_IMAGE_BYTES,
    timeoutMs = FETCH_TIMEOUT_MS,
    maxRedirects = MAX_REDIRECTS,
    lookup = dns.promises.lookup,
    blockAddress = isBlockedAddress,
    allowHttp = false, // tests only
  } = options;
  const deadline = Date.now() + timeoutMs;
  let url = checkImageUrl(raw, { allowedHosts, allowHttp });

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const pinned = await resolveAllowed(host, { lookup, blockAddress });
    const out = await requestOnce(url, pinned, { deadline, maxBytes, allowHttp });
    if (out.body) {
      const type = sniffImage(out.body);
      if (!type) throw bad('image_url did not return a JPEG or PNG image');
      return { buf: out.body, type, url: url.href };
    }
    if (!out.redirect) throw bad('image_url redirected without a location');
    // Every hop gets the same checks as the first URL.
    url = checkImageUrl(new URL(out.redirect, url).href, { allowedHosts, allowHttp });
  }
  throw bad(`image_url redirected more than ${maxRedirects} times`);
}
