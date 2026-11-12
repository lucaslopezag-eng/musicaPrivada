'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isPrivateAddress, assertPublicUrl, guardedLookup } = require('../src/net/ssrf');

test('IPv4 privadas, loopback, CGNAT/Tailscale y reservadas', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '100.114.1.64', '100.127.255.255', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
});

test('IPv4 públicas', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '151.101.1.1']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('IPv6', () => {
  for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd7a:115c:a1e0::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'ff02::1', '64:ff9b::a00:1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('assertPublicUrl rechaza destinos internos y protocolos no http', () => {
  for (const u of ['http://127.0.0.1/x', 'http://[::1]/', 'http://localhost:3001/api/logs', 'file:///etc/passwd',
    'http://user:pw@example.com/', 'http://100.114.1.64/', 'gopher://x', 'http://host.ts.net/']) {
    assert.throws(() => assertPublicUrl(u), u);
  }
  assert.equal(assertPublicUrl('https://i.scdn.co/image/abc').hostname, 'i.scdn.co');
});

test('guardedLookup bloquea resoluciones a IP privada', async () => {
  await new Promise((resolve) => {
    guardedLookup('localhost', {}, (err) => {
      assert.ok(err, 'debía fallar');
      resolve();
    });
  });
});
