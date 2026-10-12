/**
 * livekit — LiveKit server SDK integration.
 *
 * The API secret lives ONLY here (server-side, from .env) and is never exposed
 * to the browser. We mint short-lived, room-scoped access tokens using the
 * official SDK (`livekit-server-sdk`) — no custom crypto.
 *
 * Networking note: this only *signs* tokens. The browser then connects directly
 * to the LiveKit server over WSS. The API key/secret never leave the backend.
 */
const { AccessToken } = require('livekit-server-sdk');

const {
  LIVEKIT_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
} = process.env;

const TOKEN_TTL = '15m'; // short-lived; the client reconnects/refreshes as needed

/** True when the backend is configured to talk to a LiveKit server. */
function isConfigured() {
  return Boolean(LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET);
}

/** Masked config summary — safe to log (never includes the secret). */
function describeConfig() {
  return {
    configured: isConfigured(),
    url: LIVEKIT_URL || null,
    apiKeySet: Boolean(LIVEKIT_API_KEY),
    apiSecretSet: Boolean(LIVEKIT_API_SECRET),
  };
}

/**
 * Mint a room-scoped access token for one authenticated user.
 *
 * @param {object} opts
 * @param {string} opts.roomName  LiveKit room (from the DB row, never the client)
 * @param {string} opts.identity  stable, authenticated user id
 * @param {string} [opts.name]    display name
 * @param {string} [opts.metadata]
 * @returns {Promise<string>} the JWT
 */
async function createVoiceToken({ roomName, identity, name, metadata }) {
  if (!isConfigured()) {
    const err = new Error('Voice service is not configured on the server');
    err.code = 'LIVEKIT_NOT_CONFIGURED';
    throw err;
  }
  if (!roomName || !identity) {
    const err = new Error('roomName and identity are required');
    err.code = 'BAD_TOKEN_REQUEST';
    throw err;
  }

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: String(identity),
    name: name || undefined,
    metadata: metadata ? JSON.stringify(metadata) : undefined,
    ttl: TOKEN_TTL,
  });

  // Scope tightly to the one authorized room: publish/subscribe audio only.
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true, // used for speaking/attribute signals
    canUpdateOwnMetadata: true,
  });

  return at.toJwt();
}

/**
 * Generate a stable, collision-resistant LiveKit room name for a DB room id.
 * Keeping it derived means the name can never be supplied by the client.
 */
function roomNameFor(roomId) {
  return `voice_room_${Number(roomId)}`;
}

module.exports = { createVoiceToken, isConfigured, describeConfig, roomNameFor, TOKEN_TTL };
