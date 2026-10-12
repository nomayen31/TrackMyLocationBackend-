# Trip Tracker backend — long-running Express + Socket.IO server.
# A persistent container is required because the API holds WebSocket
# connections and keeps in-memory voice presence. Serverless is not suitable.
FROM node:20-alpine

ENV NODE_ENV=production

WORKDIR /app

# Install dependencies first so Docker can cache this layer.
COPY package*.json ./
RUN npm ci --omit=dev

# Application code.
COPY . .

# Railway/Render/Fly inject PORT; the app also defaults to 5000.
EXPOSE 5000

# Node's built-in fetch is used as the health check so no extra tools are needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
