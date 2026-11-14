import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { checkImageUrl, isBlockedAddress, fetchImage, sniffImage } from '../guardrails/index.js';

// ---- Addresses and URLs (no network) ----

test('internal addresses are blocked, public ones are not', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.20', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', '64:ff9b::a00:1', 'not-an-ip']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test('only plain https URLs are accepted', () => {
  assert.equal(checkImageUrl('https://cdn.mentra.glass/p/1.jpg?sig=abc').hostname, 'cdn.mentra.glass');
  const refused = [
    ['http://cdn.example.com/a.jpg', /https/],
    ['ftp://cdn.example.com/a.jpg', /https/],
    ['file:///etc/passwd', /https/],
    ['https://user:pw@cdn.example.com/a.jpg', /user name or password/],
    ['https://cdn.example.com:8443/a.jpg', /default https port/],
    ['https://localhost/a.jpg', /local or internal/],
    ['https://metadata.google.internal/a', /local or internal/],
    ['not a url', /not a valid URL/],
    [42, /URL string/],
  ];
  for (const [url, message] of refused) assert.throws(() => checkImageUrl(url), (e) => e.status === 400 && message.test(e.message), String(url));
});

test('an allow-list of hosts can be enforced', () => {
  const allowedHosts = ['mentra.glass'];
  assert.ok(checkImageUrl('https://cdn.mentra.glass/1.jpg', { allowedHosts }));
  assert.ok(checkImageUrl('https://mentra.glass/1.jpg', { allowedHosts }));
  assert.throws(() => checkImageUrl('https://evilmentra.glass/1.jpg', { allowedHosts }), /not an allowed image host/);
  assert.throws(() => checkImageUrl('https://mentra.glass.evil.com/1.jpg', { allowedHosts }), /not an allowed image host/);
});

test('images are recognised by their first bytes', () => {
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  assert.equal(sniffImage(Buffer.from('<html>')), null);
});

// ---- Downloads against a local server ----

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
let server;
let port;

before(async () => {
  server = http.createServer((req, res) => {
    const go = (status, headers = {}, body) => {
      res.writeHead(status, headers);
      res.end(body);
    };
    switch (req.url) {
      case '/photo.jpg': return go(200, { 'content-type': 'image/jpeg' }, JPEG);
      case '/page.html': return go(200, { 'content-type': 'image/jpeg' }, '<html>not an image</html>');
      case '/declared-big': return go(200, { 'content-length': String(50 * 1024 * 1024) }, '');
      case '/streamed-big': {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        res.write(JPEG);
        const timer = setInterval(() => res.write(Buffer.alloc(16 * 1024)), 1);
        res.on('close', () => clearInterval(timer));
        return undefined;
      }
      case '/slow': return res.writeHead(200, { 'content-type': 'image/jpeg' }) && res.write(Buffer.from([0xff, 0xd8])); // never ends
      case '/to-photo': return go(302, { location: '/photo.jpg' });
      case '/to-metadata': return go(302, { location: 'http://metadata.test/latest/meta-data/' });
      case '/loop': return go(302, { location: '/loop' });
      case '/missing': return go(404);
      default: return go(404);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(() => {
  server.closeAllConnections?.();
  server.close();
});

// Fake DNS: test names resolve to the local server, except the "metadata" and
// "mixed" names. Only 169.254.x.x and 10.x.x.x count as internal here, so the
// local test server (127.0.0.1) can stand in for a public image host.
const lookup = async (host) =>
  host === 'metadata.test' ? [{ address: '169.254.169.254', family: 4 }]
  : host === 'mixed.test' ? [{ address: '127.0.0.1', family: 4 }, { address: '10.0.0.5', family: 4 }]
  : [{ address: '127.0.0.1', family: 4 }];
const blockAddress = (ip) => ip.startsWith('169.254.') || ip.startsWith('10.');
const get = (path, extra = {}) => fetchImage(`http://img.test:${port}${path}`, { lookup, blockAddress, allowHttp: true, ...extra });
const refusedWith = (re) => (e) => e.status === 400 && re.test(e.message);

test('a real image downloads', async () => {
  const out = await get('/photo.jpg');
  assert.equal(out.type, 'image/jpeg');
  assert.equal(out.buf.length, JPEG.length);
});

test('a redirect is followed, and checked like the first URL', async () => {
  assert.equal((await get('/to-photo')).type, 'image/jpeg');
  await assert.rejects(get('/to-metadata'), refusedWith(/internal address/));
});

test('a host that resolves to any internal address is refused', async () => {
  await assert.rejects(fetchImage(`http://mixed.test:${port}/photo.jpg`, { lookup, blockAddress, allowHttp: true }), refusedWith(/internal address/));
  await assert.rejects(fetchImage('http://169.254.169.254/latest/meta-data/', { allowHttp: true }), refusedWith(/internal address/));
  await assert.rejects(fetchImage('https://[::1]/a.jpg'), refusedWith(/internal address/));
});

test('redirect loops stop', async () => {
  await assert.rejects(get('/loop'), refusedWith(/redirected more than 3 times/));
});

test('files over the limit are refused, even without a declared size', async () => {
  await assert.rejects(get('/declared-big'), refusedWith(/larger than/));
  await assert.rejects(get('/streamed-big', { maxBytes: 64 * 1024 }), refusedWith(/larger than 65536 bytes/));
});

test('a server that never finishes is cut off', async () => {
  const started = Date.now();
  await assert.rejects(get('/slow', { timeoutMs: 300 }), refusedWith(/too long/));
  assert.ok(Date.now() - started < 2000);
});

test('something that is not an image, or an error status, is refused', async () => {
  await assert.rejects(get('/page.html'), refusedWith(/not return a JPEG or PNG/));
  await assert.rejects(get('/missing'), refusedWith(/status 404/));
});
