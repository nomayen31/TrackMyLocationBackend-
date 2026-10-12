module.exports = function locationSocket(io, socket) {
  // The user's identity comes from the verified session, not the client.
  socket.on('update-location', ({ groupId, lat, lng }) => {
    if (!groupId || lat == null || lng == null) return;

    socket.to(`group_${groupId}`).emit('user-moved', {
      userId: socket.user.id,
      lat,
      lng,
      name: socket.user.name,
      avatarUrl: socket.user.image || socket.user.avatarUrl,
    });
  });
};