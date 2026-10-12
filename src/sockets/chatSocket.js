const pool = require('../config/db');
const { normalizeAttachment } = require('../attachments');

module.exports = function chatSocket(io, socket) {
  // New group message — text and/or a media attachment (image, voice note).
  // The sender is taken from the verified session, never from the client.
  socket.on('send-message', async ({ groupId, message, attachment } = {}) => {
    try {
      if (!groupId) return;

      const text = String(message || '').trim();
      const att = normalizeAttachment(attachment);
      if (!text && !att) return; // nothing to send

      const result = await pool.query(
        `INSERT INTO messages
           (group_id, user_id, message, attachment_type, attachment_data,
            attachment_mime, attachment_name, duration_seconds)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          groupId,
          socket.user.id,
          text,
          att?.type || null,
          att?.data || null,
          att?.mime || null,
          att?.name || null,
          att?.duration || null,
        ]
      );

      const newMessage = {
        ...result.rows[0],
        user_name: socket.user.name,
        user_avatar: socket.user.image || socket.user.avatarUrl || null,
      };
      io.to(`group_${groupId}`).emit('receive-message', newMessage);
    } catch (err) {
      console.error('Error saving chat message:', err);
    }
  });
};
