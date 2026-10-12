const locationSocket = require('./locationSocket');
const chatSocket = require('./chatSocket'); // 👈 Import Chat Handler
const interactionSocket = require('./interactionSocket'); // 👈 DM / vibrate / ring
const storySocket = require('./storySocket'); // 👈 Trip stories
const callSocket = require('./callSocket'); // 👈 WebRTC voice-call signalling
const sosSocket = require('./sosSocket'); // 👈 Expedition SOS signal
const socketAuth = require('../middleware/socketAuth'); // 👈 Import Socket Auth

module.exports = function handleSockets(io) {
  // Protect every socket connection with JWT before any handler runs
  io.use(socketAuth);

  io.on('connection', (socket) => {
    const userId = socket.user.id;
    console.log(`⚡ User Connected: ${socket.id} (user ${userId})`);

    // Personal room: lets any handler reach every device/tab this user has
    // open (used for direct messages, vibration, ringing and call signalling).
    socket.join(`user_${userId}`);

    // Join Group Room (userId comes from the verified token, not the client)
    socket.on('join-group', ({ groupId } = {}) => {
      if (!groupId) return;
      socket.join(`group_${groupId}`);
      console.log(`User ${userId} joined room: group_${groupId}`);
    });

    // Leave a group room (e.g. when the user is removed from a trip).
    socket.on('leave-group', ({ groupId } = {}) => {
      if (!groupId) return;
      socket.leave(`group_${groupId}`);
    });

    // Register Handlers
    locationSocket(io, socket);
    chatSocket(io, socket); // 👈 Active Chat Socket Handler
    interactionSocket(io, socket); // 👈 DM / vibrate / ring
    storySocket(io, socket); // 👈 Trip stories
    callSocket(io, socket); // 👈 Voice-call signalling
    sosSocket(io, socket); // 👈 Expedition SOS signal

    socket.on('disconnect', () => {
      console.log(`❌ User Disconnected: ${socket.id}`);
    });
  });
};
