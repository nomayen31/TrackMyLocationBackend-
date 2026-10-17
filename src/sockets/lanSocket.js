/**
 * lanSocket — offline hotspot presence + group voice signalling.
 *
 * Audio never passes through Socket.IO. This layer only:
 *   • keeps the "who is in the signal" list fresh
 *   • relays WebRTC offers/answers/ICE between mesh peers
 *   • relays a tiny `speaking` flag (metadata, not audio)
 *
 * On a LAN, WebRTC connects over host ICE candidates — no STUN/TURN and no
 * internet needed.
 *
 * Events (client -> server):
 *   lan:ping | lan:nearby | mesh:join | mesh:leave | mesh:signal | mesh:speaking
 * Events (server -> client):
 *   lan:presence | mesh:roster | mesh:signal | mesh:speaking
 */
const presence = require('../lan/presence');
const mesh = require('../lan/mesh');
const { LAN_MAX_PEERS, LAN_NETWORK_NAME } = require('../lan/config');

const ok = (data = {}) => ({ ok: true, ...data });
const fail = (code, message, extra = {}) => ({ ok: false, error: { code, message }, ...extra });

module.exports = function lanSocket(io, socket) {
  const deviceId = socket.lan?.deviceId;
  const name = socket.user?.name || 'Guest';
  const ip = socket.lan?.ip || socket.handshake.address;
  const network = socket.lan?.network;

  if (!deviceId) {
    // Should never happen (socketAuth rejects earlier), but be defensive.
    socket.disconnect(true);
    return;
  }

  /** Broadcast the current nearby list for this network. */
  function broadcastPresence() {
    const nearby = presence.listByNetwork(network);
    io.to(`lan_net_${network}`).emit('lan:presence', {
      network: LAN_NETWORK_NAME,
      nearby,
      count: nearby.length,
    });
    return nearby;
  }

  // Join the network room so presence updates reach only this hotspot.
  socket.join(`lan_net_${network}`);
  presence.upsert({ deviceId, name, ip, network, socketId: socket.id });
  broadcastPresence();

  socket.on('lan:ping', (_p, ack) => {
    presence.touch(deviceId);
    if (typeof ack === 'function') ack(ok({ nearby: presence.listByNetwork(network) }));
  });

  socket.on('lan:nearby', (_p, ack) => {
    presence.touch(deviceId);
    const nearby = presence.listByNetwork(network);
    if (typeof ack === 'function') ack(ok({ nearby, count: nearby.length, maxPeers: LAN_MAX_PEERS }));
  });

  /* ------------------------------------------------------------ mesh voice */
  socket.on('mesh:join', (_p, ack) => {
    const result = mesh.join({ deviceId, name, socketId: socket.id });
    if (!result.ok) {
      if (typeof ack === 'function') {
        ack(fail('MESH_FULL', `This call is full (${result.limit} people max)`, { limit: result.limit }));
      }
      return;
    }

    const roster = mesh.list();

    // Tell existing peers a new participant arrived (they will negotiate).
    for (const peer of mesh.others(deviceId)) {
      io.to(peer.socketId).emit('mesh:roster', { participants: roster, joined: { deviceId, name } });
    }

    if (typeof ack === 'function') ack(ok({ participants: roster, self: { deviceId, name }, maxPeers: LAN_MAX_PEERS }));
  });

  socket.on('mesh:leave', (_p, ack) => {
    const gone = mesh.leave(deviceId);
    if (gone) {
      const roster = mesh.list();
      for (const peer of mesh.others(deviceId)) {
        io.to(peer.socketId).emit('mesh:roster', { participants: roster, left: { deviceId } });
      }
    }
    if (typeof ack === 'function') ack(ok({ left: true }));
  });

  // Relay an opaque WebRTC signal (offer / answer / ICE) to one peer.
  socket.on('mesh:signal', ({ to, data } = {}, ack) => {
    const target = mesh.get(to);
    if (!target) {
      if (typeof ack === 'function') ack(fail('PEER_NOT_FOUND', 'That participant has left'));
      return;
    }
    // Only relay between participants of the same mesh.
    if (!mesh.get(deviceId)) {
      if (typeof ack === 'function') ack(fail('NOT_IN_MESH', 'Join the call first'));
      return;
    }
    io.to(target.socketId).emit('mesh:signal', { from: deviceId, data });
    if (typeof ack === 'function') ack(ok());
  });

  // Speaking indicator (computed client-side from the audio stream).
  socket.on('mesh:speaking', ({ speaking } = {}) => {
    for (const peer of mesh.others(deviceId)) {
      io.to(peer.socketId).emit('mesh:speaking', { deviceId, speaking: Boolean(speaking) });
    }
  });

  /* ------------------------------------------------------------- teardown */
  socket.on('disconnect', () => {
    presence.remove(deviceId);
    const wasInMesh = mesh.leave(deviceId);
    if (wasInMesh) {
      const roster = mesh.list();
      for (const peer of mesh.others(deviceId)) {
        io.to(peer.socketId).emit('mesh:roster', { participants: roster, left: { deviceId } });
      }
    }
    broadcastPresence();
  });
};
