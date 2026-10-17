/**
 * make-cert — generate a self-signed HTTPS certificate for hotspot (LAN) mode.
 *
 * Browsers only allow microphone access on secure origins, so the Pi must serve
 * the app over HTTPS. A self-signed certificate is the right tool for an offline
 * access point (no internet => no Let's Encrypt).
 *
 * The certificate MUST include the exact address people type in the browser,
 * otherwise Chrome/Android/iOS reject it. We add the LAN IP, the Pi AP IP,
 * localhost and a couple of hostnames as Subject Alternative Names.
 *
 * Usage:
 *   node scripts/make-cert.js                       # auto-detect LAN IPs
 *   node scripts/make-cert.js --ip 192.168.4.1      # add a specific IP
 *   node scripts/make-cert.js --out /etc/triptracker
 *
 * Outputs cert.pem + key.pem (key is chmod 600 on POSIX).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const selfsigned = require('selfsigned');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Every non-internal IPv4 address on this machine. */
function localIPv4s() {
  const out = new Set();
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.add(net.address);
    }
  }
  return [...out];
}

const outDir = path.resolve(arg('out', path.join(__dirname, '..', 'certs')));
const extraIp = arg('ip');

const ips = new Set(['127.0.0.1', '192.168.4.1', ...localIPv4s()]);
if (extraIp) {
  for (const ip of extraIp.split(',')) ips.add(ip.trim());
}

const altNames = [
  ...['localhost', 'pi.wifi', 'triptracker.local'].map((value) => ({ type: 2, value })),
  ...[...ips].map((ip) => ({ type: 7, ip })),
];

const attrs = [{ name: 'commonName', value: '192.168.4.1' }];

async function main() {
  // selfsigned v5 returns a Promise.
  const pems = await selfsigned.generate(attrs, {
    keySize: 2048,
    days: 3650,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });

  fs.mkdirSync(outDir, { recursive: true });
  const certPath = path.join(outDir, 'cert.pem');
  const keyPath = path.join(outDir, 'key.pem');
  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(keyPath, pems.private);

  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    /* Windows: no-op */
  }

  // Report the real validity from the generated certificate rather than assuming.
  let validity = 'unknown';
  try {
    const { X509Certificate } = require('crypto');
    const cert = new X509Certificate(fs.readFileSync(certPath));
    validity = `${cert.validFrom} → ${cert.validTo}`;
  } catch {
    /* older node */
  }

  console.log('🔐 Certificate generated\n');
  console.log(`  certificate : ${certPath}`);
  console.log(`  private key : ${keyPath}`);
  console.log(`  validity    : ${validity}`);
  console.log(`  includes IPs: ${[...ips].join(', ')}`);
  console.log(`  includes DNS: localhost, pi.wifi, triptracker.local\n`);
  console.log('Start the hotspot server with:');
  console.log(`  LAN_MODE=true PORT=3000 \\`);
  console.log(`  LAN_HTTPS_CERT="${certPath}" \\`);
  console.log(`  LAN_HTTPS_KEY="${keyPath}" \\`);
  console.log(`  node src/server.js\n`);
  console.log('Then open https://<one-of-those-IPs>:3000 and trust the certificate on each device.');
  console.log('Re-run this script to renew it (e.g. when the IP changes).');
}

main().catch((err) => {
  console.error('❌ Certificate generation failed:', err.message);
  process.exitCode = 1;
});
