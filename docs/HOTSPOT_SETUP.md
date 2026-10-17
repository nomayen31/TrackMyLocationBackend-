# Hotspot (LAN) Voice Mode — Raspberry Pi Setup

Turn the Pi into an **offline Wi-Fi hotspot** that serves Trip Tracker and lets
everyone connected to it talk in a **group voice call** — no internet, no cloud
account, no database.

This builds on the approach from
[TomHumphries/RaspberryPiHotspot](https://github.com/TomHumphries/RaspberryPiHotspot)
(`hostapd` + `dnsmasq` + a Node server), extended here with LAN presence and a
WebRTC voice mesh.

---

## How it works (and one hard browser limit)

| Concern | Reality |
| --- | --- |
| "Who is in the signal?" | A browser **cannot** list Wi-Fi devices. The Pi's server groups clients by the **/24 subnet** it sees them on (`192.168.4.x`). Everyone on the AP therefore shares one "network". |
| Voice transport | A **WebRTC mesh**: each participant connects directly to every other. On a LAN this uses host ICE candidates only — **no STUN, no TURN, no internet**. |
| Signalling | Socket.IO on the Pi relays offers/answers/ICE. **Audio never passes through Socket.IO.** |
| Identity | No cloud login (Better Auth needs Neon). A display name + a **signed LAN token** is issued by the Pi. |
| Audio limit | **Browsers block `getUserMedia` on plain HTTP** except on `localhost`. On `http://192.168.4.1` phones will refuse the mic — **you must serve HTTPS**. |
| Capacity | Mesh cost grows quadratically. Default cap is **6** (`LAN_MAX_PEERS`); use 4 on a Pi Zero 2 W. |

---

## 1. Hotspot

```bash
sudo apt update && sudo apt install -y dnsmasq hostapd
sudo systemctl stop dnsmasq hostapd
```

### Static IP for `wlan0`
`/etc/dhcpcd.conf`:
```
interface wlan0
    static ip_address=192.168.4.1/24
    nohook wpa_supplicant
```

### DHCP + DNS redirect (captive portal)
`/etc/dnsmasq.conf`:
```
interface=wlan0
dhcp-range=192.168.4.2,192.168.4.50,255.255.255.0,12h
address=/#/192.168.4.1
```

### Access point
`/etc/hostapd/hostapd.conf` (WPA2 — do **not** leave it open):
```
interface=wlan0
driver=nl80211
ssid=Trailhead Camp
hw_mode=g
channel=7
wmm_enabled=1
auth_algs=1
wpa=2
wpa_passphrase=choose-a-strong-password
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
```

`/etc/default/hostapd`:
```
DAEMON_CONF="/etc/hostapd/hostapd.conf"
```

```bash
sudo systemctl unmask hostapd
sudo systemctl enable --now hostapd dnsmasq
```

> A password-protected AP is strongly recommended: an open hotspot lets anyone
> in range see participant names and join the call.

---

## 2. Install the app on the Pi

```bash
# Backend
git clone https://github.com/nomayen31/TrackMyLocationBackend-.git
cd TrackMyLocationBackend-
npm ci

# Frontend (built once; the backend serves the static files)
git clone https://github.com/nomayen31/TrackMyLocation.git ../TrackMyLocation
cd ../TrackMyLocation
npm ci --include=dev
npm run build          # produces ../TrackMyLocation/dist
```

No `npm run migrate` is needed — LAN mode never touches PostgreSQL.

---

## 3. HTTPS (required for the microphone)

**Why it's needed:** browsers only expose `getUserMedia` on a *secure context*.
`http://localhost` counts as secure, but `http://192.168.4.1` does **not** — so on
the hotspot every phone would refuse the mic. TLS fixes that.

**How it works here:** the Pi serves the app itself over HTTPS with a
**self-signed certificate**. There is no internet on the hotspot, so
Let's Encrypt is not an option. The browser validates the certificate against
the address bar: it must list the exact IP/DNS you typed, or it refuses to treat
the origin as secure. That list is the **Subject Alternative Name (SAN)**.

Generate one (works on Windows/macOS/Linux — no openssl required):

```bash
cd Backend
npm run cert -- --ip 192.168.4.1        # add --ip for each address you use
# or simply:
node scripts/make-cert.js
```

It auto-detects your machine's LAN IPs and adds `127.0.0.1`, `192.168.4.1`,
`localhost`, `pi.wifi`, `triptracker.local`. Output:

```
certs/cert.pem   certs/key.pem          (both gitignored)
```

Then start the server pointing at them:

```bash
LAN_MODE=true PORT=3000 \
LAN_HTTPS_CERT=./certs/cert.pem \
LAN_HTTPS_KEY=./certs/key.pem \
node src/server.js
```

Look for `🔒 HTTPS enabled for LAN mode` in the log. Verify from another device:

```bash
curl -k https://192.168.4.1:3000/health
# {"ok":true,"mode":"lan",...}
```

> Re-run `npm run cert` whenever the Pi's IP changes — a certificate whose SAN
> doesn't match the URL is rejected even if you installed it.

**Trust it on each phone** (otherwise the mic stays blocked):

- **Android**: Settings → Security → Encryption & credentials → Install a
  certificate → *CA certificate* → pick `cert.pem` (rename to `cert.crt`).
- **iOS**: open/airdrop the `.pem`, install the profile, then
  Settings → General → About → Certificate Trust Settings → enable full trust.
- **Desktop**: import into the OS trust store, or accept the warning (Chrome may
  still withhold the mic until the cert is trusted).

<details>
<summary>Alternative: openssl (preinstalled on Raspberry Pi OS)</summary>

```bash
sudo mkdir -p /etc/triptracker
sudo openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout /etc/triptracker/key.pem \
  -out  /etc/triptracker/cert.pem \
  -subj "/CN=192.168.4.1" \
  -addext "subjectAltName=IP:192.168.4.1,DNS:pi.wifi,DNS:localhost"
sudo chmod 600 /etc/triptracker/key.pem
```
</details>

---

## 4. Run it as a service

`/etc/systemd/system/triptracker.service`:
```ini
[Unit]
Description=Trip Tracker hotspot app
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/TrackmyLocation/Backend
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=3

Environment=LAN_MODE=true
Environment=PORT=3000
Environment=LAN_NETWORK_NAME=Trailhead Camp
Environment=LAN_SECRET=replace-with-a-long-random-string
Environment=LAN_MAX_PEERS=6
Environment=FRONTEND_DIST=/home/pi/TrackmyLocation/Frontend/dist
Environment=LAN_HTTPS_CERT=/etc/triptracker/cert.pem
Environment=LAN_HTTPS_KEY=/etc/triptracker/key.pem

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now triptracker
sudo systemctl status triptracker
```

Open **`https://192.168.4.1:3000`** on a connected phone.

Optional — drop the port with a DNAT rule:
```bash
sudo iptables -t nat -A PREROUTING -p tcp --dport 443 -j DNAT --to-destination 192.168.4.1:3000
sudo sh -c "iptables-save > /etc/iptables.ipv4.nat"
```
(add `iptables-restore < /etc/iptables.ipv4.nat` to `/etc/rc.local` so it
survives reboots).

---

## 5. Using it

1. Join the Wi-Fi, open `https://192.168.4.1:3000`.
2. Enter a display name → **Join the hotspot**.
3. Everyone on the Wi-Fi appears under **"In the signal"**.
4. Tap **Join group voice** and allow the microphone.
5. Green rings + waveforms show who is speaking; use the mic button to mute.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Page won't load | `systemctl status triptracker`; confirm `FRONTEND_DIST` points at `Frontend/dist`. |
| "Microphone blocked" | You're on `http://`. Use `https://` and trust the cert. |
| Certificate warning | The cert's SAN must contain `192.168.4.1`; re-create per step 3. |
| Nobody appears "in the signal" | Devices must be on the Pi's AP. If you changed the subnet, restart the app (presence keys on the /24). |
| Call drops with 4+ people | Lower `LAN_MAX_PEERS`; mesh upload grows with each peer. |
| Works on the Pi, not on phones | Firewall on `wlan0`, or the phones are on a different network. |

---

## Security notes

LAN mode is a **trusted-network** design: anyone on the Wi-Fi can join and see
names. That is the point of a hotspot companion app, but:

- Use a **WPA2 password** on the AP.
- Treat the LAN token as a device label, not as authentication.
- The hotspot has **no internet**, so the cloud app (accounts, trips, LiveKit,
  database) is intentionally unavailable in this mode.
