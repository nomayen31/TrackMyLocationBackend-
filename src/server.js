const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { Server } = require('socket.io');
require('dotenv').config();

const { LAN_MODE, LAN_NETWORK_NAME, LAN_MAX_PEERS, FRONTEND_DIST } = require('./lan/config');
const { corsOrigin } = require('./config/origins');
const socketAuth = require('./middleware/socketAuth');

const app = express();

// Assigned in cloud mode, invoked once the Socket.IO server exists.
let startCloudSockets = null;

// Behind Render / the Pi's reverse proxy. Required for correct client IPs
// (which LAN discovery relies on) and secure cookies.
app.set('trust proxy', 1);

// CORS for cookie-based auth. In LAN mode the app is served from this same
// origin, so we reflect whatever origin the device used.
app.use(
  cors({
    origin: LAN_MODE ? true : corsOrigin,
    credentials: true,
  })
);
app.use(express.json({ limit: '8mb' }));

// Health check — registered BEFORE the LAN static fallback so it is never
// swallowed by the SPA catch-all.
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    mode: LAN_MODE ? 'lan' : 'cloud',
    network: LAN_MODE ? LAN_NETWORK_NAME : undefined,
    maxPeers: LAN_MODE ? LAN_MAX_PEERS : undefined,
    uptime: Math.round(process.uptime()),
    env: process.env.NODE_ENV || 'development',
  });
});

/* ------------------------------------------------------------------------- */
/* Cloud mode: the original application                                      */
/* ------------------------------------------------------------------------- */
if (!LAN_MODE) {
  const { toNodeHandler } = require('better-auth/node');
  const { auth } = require('./auth');
  const swaggerUi = require('swagger-ui-express');
  const swaggerDocument = require('./swagger');

  const handleSockets = require('./sockets/index');
  const chatRoutes = require('./routes/chatRoutes');
  const authRoutes = require('./routes/authRoutes');
  const groupRoutes = require('./routes/groupRoutes');
  const expenseRoutes = require('./routes/expenseRoutes');
  const storyRoutes = require('./routes/storyRoutes');
  const dmRoutes = require('./routes/dmRoutes');
  const safeZoneRoutes = require('./routes/safeZoneRoutes');
  const profileRoutes = require('./routes/profileRoutes');
  const voiceRoutes = require('./routes/voiceRoutes');
  const pushRoutes = require('./routes/pushRoutes');

  app.use('/api/auth', authRoutes);
  app.use('/api/groups', groupRoutes);
  app.use('/api/chats', chatRoutes);
  app.use('/api/expenses', expenseRoutes);
  app.use('/api/stories', storyRoutes);
  app.use('/api/dm', dmRoutes);
  app.use('/api/safezone', safeZoneRoutes);
  app.use('/api/profile', profileRoutes);
  app.use('/api/voice', voiceRoutes);
  app.use('/api/push', pushRoutes);

  // Better Auth's own endpoints
  app.all('/api/auth/*splat', toNodeHandler(auth.handler));

  // Swagger
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

  app.get('/', (req, res) => {
    res.send('Trip Tracker Backend is running smoothly!');
  });

  startCloudSockets = handleSockets;
}

/* ------------------------------------------------------------------------- */
/* LAN / hotspot mode: offline identity, discovery, group voice              */
/* ------------------------------------------------------------------------- */
if (LAN_MODE) {
  const lanRoutes = require('./routes/lanRoutes');
  app.use('/api/lan', lanRoutes);

  // Serve the built React app from the same origin (no CORS, works offline).
  const dist = FRONTEND_DIST || path.resolve(__dirname, '../../Frontend/dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false }));
    // SPA fallback for anything that isn't an API or socket request.
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
      res.sendFile(path.join(dist, 'index.html'));
    });
    console.log(`📱 Serving the app from ${dist}`);
  } else {
    console.warn(
      `⚠️  LAN mode: no frontend build found at ${dist}. ` +
        `Run "npm run build" in the Frontend folder, or set FRONTEND_DIST.`
    );
  }
}

/* ------------------------------------------------------------------------- */

const server = (() => {
  // Browsers only allow microphone access on secure origins. In LAN mode the
  // app is served from http://192.168.x.x, which is NOT secure — so serving the
  // Pi over HTTPS is required for voice. Provide a cert/key to enable it.
  const certPath = process.env.LAN_HTTPS_CERT;
  const keyPath = process.env.LAN_HTTPS_KEY;
  if (LAN_MODE && certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const https = require('https');
    console.log('🔒 HTTPS enabled for LAN mode');
    return https.createServer(
      { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) },
      app
    );
  }
  return http.createServer(app);
})();
const io = new Server(server, {
  cors: {
    origin: LAN_MODE ? true : corsOrigin,
    credentials: true,
  },
  maxHttpBufferSize: 8 * 1024 * 1024,
});

app.set('io', io);

if (LAN_MODE) {
  const lanSocket = require('./sockets/lanSocket');
  io.use(socketAuth);
  io.on('connection', (socket) => {
    console.log(`📶 LAN device connected: ${socket.user?.name} (${socket.id})`);
    lanSocket(io, socket);
  });
} else {
  startCloudSockets(io);
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  if (LAN_MODE) {
    console.log(`🚀 Hotspot mode — "${LAN_NETWORK_NAME}" on port ${PORT} (max ${LAN_MAX_PEERS} in a voice call)`);
    if (!process.env.LAN_HTTPS_CERT) {
      console.warn(
        '⚠️  Serving over HTTP. Browsers BLOCK microphone access on non-localhost HTTP, ' +
          'so voice calls will not work until you enable HTTPS (set LAN_HTTPS_CERT / LAN_HTTPS_KEY).'
      );
    }
  } else {
    console.log(`🚀 Server is running on port ${PORT}`);
  }
});
