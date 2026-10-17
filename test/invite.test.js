/**
 * Invite-link base URL tests.
 *
 * Regression guard: a deployment that forgot CLIENT_URL used to hand out
 * `http://localhost:5173/join/...`, which is why "members can't join by link".
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { clientBase, DEFAULT_CLIENT_URL } = require('../src/config/clientUrl');

/** Temporarily set env vars and return a restore function. */
function withEnv(vars) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

test('uses CLIENT_URL when configured (trailing slash stripped)', () => {
  const restore = withEnv({
    CLIENT_URL: 'https://app.example.com/',
    CORS_ORIGINS: undefined,
  });
  try {
    const req = {
      headers: { origin: 'https://other.example.com', host: 'api.example.com' },
      protocol: 'https',
    };
    assert.equal(clientBase(req), 'https://app.example.com');
  } finally {
    restore();
  }
});

test('falls back to the request Origin when no allow-list is configured', () => {
  const restore = withEnv({ CLIENT_URL: undefined, CORS_ORIGINS: undefined });
  try {
    const req = {
      headers: { origin: 'https://trackmylocation-app.onrender.com', host: 'api.onrender.com' },
      protocol: 'https',
    };
    assert.equal(clientBase(req), 'https://trackmylocation-app.onrender.com');
  } finally {
    restore();
  }
});

test('ignores an untrusted Origin when an allow-list IS configured', () => {
  const restore = withEnv({
    CLIENT_URL: undefined,
    CORS_ORIGINS: 'https://trusted.example.com',
  });
  try {
    const req = {
      headers: {
        origin: 'https://evil.example.com',
        referer: 'http://localhost:5173/some/page',
        host: 'api.onrender.com',
      },
      protocol: 'https',
    };
    // localhost is always allowed (loopback); evil is not.
    assert.equal(clientBase(req), 'http://localhost:5173');
  } finally {
    restore();
  }
});

test('uses the Host for a same-origin deployment (no Origin/Referer)', () => {
  const restore = withEnv({ CLIENT_URL: undefined, CORS_ORIGINS: undefined });
  try {
    const req = { headers: { host: '192.168.4.1:3000' }, protocol: 'http' };
    assert.equal(clientBase(req), 'http://192.168.4.1:3000');
  } finally {
    restore();
  }
});

test('falls back to the localhost default when nothing is available', () => {
  const restore = withEnv({ CLIENT_URL: undefined, CORS_ORIGINS: undefined });
  try {
    assert.equal(clientBase({ headers: {} }), DEFAULT_CLIENT_URL);
    assert.equal(clientBase(undefined), DEFAULT_CLIENT_URL);
  } finally {
    restore();
  }
});

test('never emits a double slash before /join', () => {
  const restore = withEnv({ CLIENT_URL: 'https://app.example.com///', CORS_ORIGINS: undefined });
  try {
    const base = clientBase({ headers: {} });
    assert.equal(`${base}/join/token`, 'https://app.example.com/join/token');
  } finally {
    restore();
  }
});
