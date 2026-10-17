const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const push = require('../notifications/push');

router.use(authMiddleware);

// GET /api/push/public-key  -> VAPID public key for the browser subscription
router.get('/public-key', (req, res) => {
  res.json({ configured: push.configured, publicKey: push.publicKey });
});

// POST /api/push/subscribe  { subscription }
router.post('/subscribe', async (req, res) => {
  try {
    if (!push.configured) {
      return res.status(503).json({ error: 'Push is not configured on the server' });
    }
    await push.saveSubscription(req.user.id, req.body?.subscription, req.headers['user-agent']);
    const devices = await push.countForUser(req.user.id);
    res.status(201).json({ ok: true, devices });
  } catch (err) {
    if (err.code === 'INVALID_SUBSCRIPTION') return res.status(400).json({ error: err.message });
    console.error('Push subscribe error:', err);
    res.status(500).json({ error: 'Failed to save the subscription' });
  }
});

// DELETE /api/push/subscribe  { endpoint }
router.delete('/subscribe', async (req, res) => {
  try {
    const removed = await push.removeSubscription(req.user.id, req.body?.endpoint);
    res.json({ ok: true, removed });
  } catch (err) {
    console.error('Push unsubscribe error:', err);
    res.status(500).json({ error: 'Failed to remove the subscription' });
  }
});

// POST /api/push/test  -> send yourself a test notification
router.post('/test', async (req, res) => {
  try {
    const result = await push.sendToUser(req.user.id, {
      type: 'test',
      title: 'Trip Tracker',
      body: 'Push notifications are working ✅',
      url: '/',
      tag: 'test',
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Push test error:', err);
    res.status(500).json({ error: 'Failed to send the test notification' });
  }
});

module.exports = router;
