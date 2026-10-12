const pool = require('../config/db');

module.exports = function chatSocket(io, socket) {
  // Listen for new messages from users.
  // The sender is taken from the verified session, never from the client.
  socket.on('send-message', async ({ groupId, message }) => {
    try {
      if (!groupId || !message) return;

      // 1. Save message to PostgreSQL Database
      const result = await pool.query(
        `INSERT INTO messages (group_id, user_id, message) VALUES ($1, $2, $3) RETURNING *`,
        [groupId, socket.user.id, message]
      );

      // 2. Broadcast the message to all members in the group room.
      //    `user_name` is attached so the client can label the bubble without
      //    a second round-trip.
      const newMessage = { ...result.rows[0], user_name: socket.user.name };
      io.to(`group_${groupId}`).emit('receive-message', newMessage);
    } catch (err) {
      console.error('Error saving chat message:', err);
    }
  });
};
