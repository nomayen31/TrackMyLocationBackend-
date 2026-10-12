const express = require('express');
const router = express.Router();
const { auth } = require('../auth');
const { fromNodeHeaders } = require('better-auth/node');
const authMiddleware = require('../middleware/authMiddleware');

/**
 * Copy the headers (notably `set-cookie`) produced by a Better Auth server
 * API call onto the Express response, then send the JSON body.
 */
function sendAuthResult(res, result) {
  const { headers, response, status } = result || {};

  if (headers) {
    const setCookies = headers.getSetCookie ? headers.getSetCookie() : [];
    if (setCookies.length > 0) {
      res.setHeader('Set-Cookie', setCookies);
    }
    headers.forEach((value, key) => {
      if (key.toLowerCase() !== 'set-cookie') {
        res.setHeader(key, value);
      }
    });
  }

  return res.status(status || 200).json(response ?? {});
}

/** Translate a Better Auth APIError (or unknown error) into an HTTP response. */
function handleAuthError(res, err) {
  if (err && typeof err === 'object' && err.statusCode) {
    return res.status(err.statusCode).json({
      error: err.message || 'Authentication failed',
      ...(err.body && typeof err.body === 'object' ? { details: err.body } : {}),
    });
  }
  console.error('Auth error:', err);
  return res.status(500).json({ error: 'Internal server error' });
}

// POST /api/auth/signup  ->  { name, email, password }
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email and password are required' });
    }

    const result = await auth.api.signUpEmail({
      body: { name, email, password },
      headers: fromNodeHeaders(req.headers),
      returnHeaders: true,
      returnStatus: true,
    });

    return sendAuthResult(res, result);
  } catch (err) {
    return handleAuthError(res, err);
  }
});

// POST /api/auth/login  ->  { email, password }
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const result = await auth.api.signInEmail({
      body: { email, password },
      headers: fromNodeHeaders(req.headers),
      returnHeaders: true,
      returnStatus: true,
    });

    return sendAuthResult(res, result);
  } catch (err) {
    return handleAuthError(res, err);
  }
});

// POST /api/auth/logout  -> ends the current session
router.post('/logout', async (req, res) => {
  try {
    const result = await auth.api.signOut({
      headers: fromNodeHeaders(req.headers),
      returnHeaders: true,
      returnStatus: true,
    });

    return sendAuthResult(res, result);
  } catch (err) {
    return handleAuthError(res, err);
  }
});

// GET /api/auth/me  -> returns the currently authenticated user
router.get('/me', authMiddleware, async (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;