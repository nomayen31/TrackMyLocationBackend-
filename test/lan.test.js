/**
 * LAN / hotspot voice tests — pure logic, no database and no Pi required.
 * Run: npm test
 */

// Keep presence TTL short so expiry is testable.
process.env.LAN_PRESENCE_TTL_MS = '80';
process.env.LAN_SECRET = 'test-secret-for-signing';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeIp, subnetOf, sameNetwork, isPrivate, isLoopback } = require('../src/lan/network');
const { issueToken, verifyToken } = require('../src/lan/token');
const presence = require('../src/lan/presence');
const mesh = require('../src/lan/mesh');

/* ------------------------------------------------------------------ network */

test('normalizeIp strips IPv4-mapped IPv6 and ports', () => {
  assert.equal(normalizeIp('::ffff:192.168.4.7'), '192.168.4.7');
  assert.equal(normalizeIp('192.168.4.7:51820'), '192.168.4.7');
  assert.equal(normalizeIp('[::1]'), '::1');
  assert.equal(normalizeIp(''), '');
});

test('subnetOf groups hotspot clients onto one /24', () => {
  assert.equal(subnetOf('192.168.4.7'), '192.168.4');
  assert.equal(subnetOf('192.168.4.99'), '192.168.4');
  assert.equal(subnetOf('::ffff:192.168.4.12'), '192.168.4');
  assert.equal(subnetOf('10.0.0.5'), '10.0.0');
  assert.equal(subnetOf('::1'), 'loopback');
});

test('sameNetwork: same AP = same group, different network = not', () => {
  assert.equal(sameNetwork('192.168.4.7', '192.168.4.8'), true);
  assert.equal(sameNetwork('192.168.4.7', '192.168.5.7'), false);
  assert.equal(sameNetwork('10.1.2.3', '10.1.2.99'), true);
});

test('isPrivate / isLoopback classification', () => {
  assert.equal(isPrivate('192.168.4.2'), true);
  assert.equal(isPrivate('10.9.9.9'), true);
  assert.equal(isPrivate('172.16.0.1'), true);
  assert.equal(isPrivate('172.32.0.1'), false);
  assert.equal(isPrivate('8.8.8.8'), false);
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::1'), true);
});

/* -------------------------------------------------------------------- token */

test('LAN token round-trips the claims', () => {
  const token = issueToken({ deviceId: 'device-abc123', name: 'Maya' });
  const claims = verifyToken(token);
  assert.ok(claims);
  assert.equal(claims.deviceId, 'device-abc123');
  assert.equal(claims.name, 'Maya');
  assert.ok(claims.exp > Date.now());
});

test('LAN token rejects tampering and garbage', () => {
  const token = issueToken({ deviceId: 'device-abc123', name: 'Maya' });
  const [body] = token.split('.');

  // Forge a payload with a different name but keep the old signature.
  const forged = Buffer.from(
    JSON.stringify({ deviceId: 'device-abc123', name: 'Imposter', iat: Date.now(), exp: Date.now() + 10000 })
  ).toString('base64url');

  assert.equal(verifyToken(`${forged}.${token.split('.')[1]}`), null, 'forged payload rejected');
  assert.equal(verifyToken(`${body}.deadbeef`), null, 'bad signature rejected');
  assert.equal(verifyToken('not-a-token'), null);
  assert.equal(verifyToken(null), null);
  assert.equal(verifyToken(undefined), null);
});

test('LAN token expires', () => {
  const realNow = Date.now;
  const token = issueToken({ deviceId: 'device-abc123', name: 'Maya' });
  Date.now = () => realNow() + 25 * 60 * 60 * 1000; // +25h
  try {
    assert.equal(verifyToken(token), null, 'expired token rejected');
  } finally {
    Date.now = realNow;
  }
});

/* ----------------------------------------------------------------- presence */

test('presence lists devices on the same network only', () => {
  presence.reset();
  presence.upsert({ deviceId: 'a', name: 'Maya', ip: '192.168.4.5', network: '192.168.4' });
  presence.upsert({ deviceId: 'b', name: 'Arif', ip: '192.168.4.6', network: '192.168.4' });
  presence.upsert({ deviceId: 'c', name: 'Sam', ip: '10.0.0.9', network: '10.0.0' });

  const here = presence.listByNetwork('192.168.4');
  assert.equal(here.length, 2);
  assert.deepEqual(here.map((d) => d.name).sort(), ['Arif', 'Maya']);
  assert.equal(presence.listByNetwork('10.0.0').length, 1);
});

test('presence upsert is idempotent and refreshes instead of duplicating', () => {
  presence.reset();
  const first = presence.upsert({ deviceId: 'a', name: 'Maya', network: '192.168.4' });
  const second = presence.upsert({ deviceId: 'a', name: 'Maya', network: '192.168.4' });
  assert.equal(first, true, 'first sighting is new');
  assert.equal(second, false, 'second sighting is not new');
  assert.equal(presence.listByNetwork('192.168.4').length, 1);
});

test('presence entries expire after the TTL', async () => {
  presence.reset();
  presence.upsert({ deviceId: 'a', name: 'Maya', network: '192.168.4' });
  assert.equal(presence.listByNetwork('192.168.4').length, 1);

  await new Promise((r) => setTimeout(r, 120)); // TTL is 80ms in this file

  assert.equal(presence.listByNetwork('192.168.4').length, 0, 'stale device disappears');
});

test('heartbeat keeps a device alive', async () => {
  presence.reset();
  presence.upsert({ deviceId: 'a', name: 'Maya', network: '192.168.4' });
  await new Promise((r) => setTimeout(r, 50));
  presence.touch('a');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(presence.listByNetwork('192.168.4').length, 1, 'touch refreshed lastSeen');
});

/* --------------------------------------------------------------------- mesh */

test('mesh join/leave maintains an ordered roster', () => {
  mesh.reset();
  assert.equal(mesh.join({ deviceId: 'a', name: 'Maya', socketId: 's1' }).ok, true);
  assert.equal(mesh.join({ deviceId: 'b', name: 'Arif', socketId: 's2' }).ok, true);

  assert.deepEqual(mesh.list().map((m) => m.name), ['Maya', 'Arif']);

  mesh.leave('a');
  assert.deepEqual(mesh.list().map((m) => m.name), ['Arif']);
  assert.equal(mesh.size(), 1);
});

test('mesh re-join updates the socket instead of duplicating the participant', () => {
  mesh.reset();
  mesh.join({ deviceId: 'a', name: 'Maya', socketId: 's1' });
  const again = mesh.join({ deviceId: 'a', name: 'Maya', socketId: 's9' });
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
  assert.equal(mesh.size(), 1, 'no duplicate after a reconnect');
  assert.equal(mesh.get('a').socketId, 's9', 'socket id refreshed');
});

test('mesh enforces the participant cap', () => {
  mesh.reset();
  const limit = mesh.LAN_MAX_PEERS;
  for (let i = 0; i < limit; i += 1) {
    assert.equal(mesh.join({ deviceId: `d${i}`, name: `P${i}`, socketId: `s${i}` }).ok, true);
  }
  const overflow = mesh.join({ deviceId: 'extra', name: 'TooMany', socketId: 'sx' });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.reason, 'full');
  assert.equal(mesh.size(), limit);
});
