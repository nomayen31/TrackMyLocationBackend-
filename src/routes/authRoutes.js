const express = require('express');
const router = express.Router();
const { auth } = require('../auth');
const authMiddleware = require('../middleware/authMiddleware');
const pool = require('../config/db');

/**
 * Convert Node request headers into a Fetch `Headers` object.
 *
 * `better-auth/node` is an ES module in v1.7+, so it must be imported
 * dynamically — a static require() throws ERR_REQUIRE_ESM on runtimes without
 * require(ESM) (for example some serverless Node builds).
 */
async function toFetchHeaders(req) {
  const { fromNodeHeaders } = await import('better-auth/node');
  return fromNodeHeaders(req.headers);
}

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

// POST /api/auth/signup  ->  { name, email, password, image?, phone? }
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password, image, phone } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email and password are required' });
    }

    const result = await auth.api.signUpEmail({
      body: { name, email, password },
      headers: await toFetchHeaders(req),
      returnHeaders: true,
      returnStatus: true,
    });

    // Attach the optional profile photo / phone the signup form collected.
    const userId = result?.response?.user?.id;
    if (userId && (image || phone)) {
      try {
        const photo =
          image && /^data:image\//i.test(String(image)) && String(image).length <= 2 * 1024 * 1024
            ? String(image)
            : null;
        const tel = phone ? String(phone).trim().slice(0, 32) : null;

        await pool.query(
          `UPDATE "user"
             SET image      = COALESCE($1, image),
                 "avatarUrl" = COALESCE($1, "avatarUrl"),
                 phone      = COALESCE($2, phone)
           WHERE id = $3`,
          [photo, tel, userId]
        );

        const fresh = await pool.query(
          'SELECT id, name, email, image, "avatarUrl", phone, social FROM "user" WHERE id = $1',
          [userId]
        );
        if (fresh.rows.length > 0 && result.response.user) {
          result.response.user = { ...result.response.user, ...fresh.rows[0] };
        }
      } catch (profileErr) {
        // Never fail the signup because of an optional profile field.
        console.error('Signup profile enrichment failed:', profileErr.message);
      }
    }

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
      headers: await toFetchHeaders(req),
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
      headers: await toFetchHeaders(req),
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