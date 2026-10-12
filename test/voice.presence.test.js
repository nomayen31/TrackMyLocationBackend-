/**
 * Presence store unit tests — pure in-memory logic, no database needed.
 * Run: node --test test/
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const presence = require('../src/voice/presence');

test.beforeEach(() => presence.reset());

test('add returns true only for the first tab of a user', () => {
  assert.equal(presence.add(1, 'alice', 'sock-a'), true);
  assert.equal(presence.add(1, 'alice', 'sock-b'), false, 'second tab is not a new participant');
  assert.equal(presence.count(1), 1, 'one user, not two');
  assert.equal(presence.socketIdsFor(1, 'alice').length, 2);
});

test('remove only reports "left" when the last tab goes', () => {
  presence.add(1, 'alice', 'sock-a');
  presence.add(1, 'alice', 'sock-b');

  assert.equal(presence.remove(1, 'alice', 'sock-a'), false, 'still one tab left');
  assert.equal(presence.count(1), 1);

  assert.equal(presence.remove(1, 'alice', 'sock-b'), true, 'last tab left');
  assert.equal(presence.count(1), 0);
});

test('mute state is shared across a user\'s tabs and never overwritten by a second tab', () => {
  presence.add(1, 'alice', 'sock-a', { muted: true });
  assert.equal(presence.isMuted(1, 'alice'), true);

  presence.add(1, 'alice', 'sock-b', { muted: false });
  assert.equal(presence.isMuted(1, 'alice'), true, 'joining in a new tab must not unmute you');

  presence.setMuted(1, 'alice', false);
  assert.equal(presence.isMuted(1, 'alice'), false);
});

test('roomsForSocket finds every room a socket belongs to', () => {
  presence.add(7, 'alice', 'sock-a');
  presence.add(9, 'bob', 'sock-b');
  presence.add(7, 'carol', 'sock-a');

  const found = presence.roomsForSocket('sock-a').map((r) => r.roomId).sort();
  assert.deepEqual(found, [7, 7]);
  assert.equal(presence.roomsForSocket('sock-b').length, 1);
});

test('rooms are cleaned up entirely when empty', () => {
  presence.add(3, 'alice', 'sock-a');
  presence.remove(3, 'alice', 'sock-a');
  assert.deepEqual(presence.userIds(3), []);
  assert.equal(presence.snapshot()[3], undefined, 'empty room dropped from the store');
});

test('a user cannot be double-counted across tabs in different rooms', () => {
  presence.add(1, 'alice', 'sock-a');
  presence.add(2, 'alice', 'sock-a');
  assert.equal(presence.count(1), 1);
  assert.equal(presence.count(2), 1);
  assert.equal(presence.roomsForSocket('sock-a').length, 2);
});
