const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const { toNodeHandler } = require('better-auth/node');
require('dotenv').config();

const { auth } = require('./auth');
const swaggerDocument = require('./swagger');
const { corsOrigin } = require('./config/origins');
const handleSockets = require('./sockets/index');
const chatRoutes = require('./routes/chatRoutes'); // 👈 Import Chat Routes
const authRoutes = require('./routes/authRoutes'); // 👈 Import Auth Routes
const groupRoutes = require('./routes/groupRoutes'); // 👈 Import Group Routes
const expenseRoutes = require('./routes/expenseRoutes'); // 👈 Import Expense Routes
const storyRoutes = require('./routes/storyRoutes'); // 👈 Trip stories Routes
const dmRoutes = require('./routes/dmRoutes'); // 👈 Direct messages Routes
const safeZoneRoutes = require('./routes/safeZoneRoutes'); // 👈 Safe zone Routes
const profileRoutes = require('./routes/profileRoutes'); // 👈 Profile Routes
const voiceRoutes = require('./routes/voiceRoutes'); // 👈 Voice rooms Routes

const app = express();

// Behind Render/Railway/Fly there is a proxy in front of us. Trusting it is
// required for `secure` cookies and for correct client IPs.
app.set('trust proxy', 1);

// CORS for cookie-based auth across the dev server, Vercel previews and the
// deployed frontend. Any loopback port is trusted; CLIENT_URL / CORS_ORIGINS
// cover production.
app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  })
);
// Stories carry base64 image data URLs, so allow a larger JSON body.
app.use(express.json({ limit: '8mb' }));

// API Routes
app.use('/api/auth', authRoutes); // 👈 Custom Auth API Endpoint (signup / login / logout / me)
app.use('/api/groups', groupRoutes); // 👈 Groups API Endpoint (create / members)
app.use('/api/chats', chatRoutes); // 👈 Chat API Endpoint
app.use('/api/expenses', expenseRoutes); // 👈 Expenses API Endpoint (add / balance)
app.use('/api/stories', storyRoutes); // 👈 Trip stories API Endpoint
app.use('/api/dm', dmRoutes); // 👈 Direct messages API Endpoint
app.use('/api/safezone', safeZoneRoutes); // 👈 Safe zone API Endpoint
app.use('/api/profile', profileRoutes); // 👈 Profile API Endpoint
app.use('/api/voice', voiceRoutes); // 👈 Voice rooms API Endpoint

// Better Auth's own endpoints (/api/auth/sign-up/email, /sign-in/email, /get-session, ...)
app.all('/api/auth/*splat', toNodeHandler(auth.handler));

// Swagger API documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    // Same local-dev allow-list as the REST API.
    origin: corsOrigin,
    credentials: true,
  },
  // Story images travel as base64 data URLs, so the default 1 MB is too small.
  maxHttpBufferSize: 8 * 1024 * 1024,
});

// Expose the Socket.IO server to REST handlers (e.g. broadcast a new story
// posted through POST /api/stories).
app.set('io', io);

handleSockets(io);

app.get('/', (req, res) => {
  res.send('Trip Tracker Backend is running smoothly!');
});

// Health check for the host's readiness probe (Render/Railway/Fly).
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), env: process.env.NODE_ENV || 'development' });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});