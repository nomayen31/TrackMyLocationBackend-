/**
 * Entry point.
 *
 * `package.json` declares "main": "index.js", and platforms that use the native
 * Node runtime (Render, Railway, Heroku-style) default their start command to
 * `node index.js` when no start command is configured. This file simply boots
 * the real server so that default works.
 *
 * The canonical implementation lives in `src/server.js`
 * (`npm start` runs it directly when you prefer an explicit start command).
 */
require('./src/server');
