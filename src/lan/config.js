/**
 * LAN mode configuration.
 *
 * When the backend runs on the Raspberry Pi hotspot, `LAN_MODE=true` switches
 * the server into an offline-friendly mode:
 *   • no cloud auth (Better Auth/Neon) and no cloud routes
 *   • a lightweight signed LAN identity instead
 *   • discovery of everyone connected to the Pi's access point
 *   • group voice over a WebRTC mesh, signalled through Socket.IO
 *   • the built React app is served from the same origin
 *
 * Cloud behaviour is untouched when the flag is off.
 */
const LAN_MODE = String(process.env.LAN_MODE).toLowerCase() === 'true';

module.exports = {
  LAN_MODE,
  /** Secret used to sign LAN identity tokens (ephemeral if unset). */
  LAN_SECRET: process.env.LAN_SECRET || null,
  /** Max people in one voice mesh (Pi Zero 2 W: 4 · Pi 4/5: 6-8). */
  LAN_MAX_PEERS: Number(process.env.LAN_MAX_PEERS || 6),
  /** Shown in the UI, e.g. "Trailhead Camp". */
  LAN_NETWORK_NAME: process.env.LAN_NETWORK_NAME || 'Hotspot',
  /** How long a device stays "nearby" without a heartbeat. */
  LAN_PRESENCE_TTL_MS: Number(process.env.LAN_PRESENCE_TTL_MS || 45_000),
  /** Where the built frontend lives; served when LAN mode is on. */
  FRONTEND_DIST: process.env.FRONTEND_DIST || null,
};
