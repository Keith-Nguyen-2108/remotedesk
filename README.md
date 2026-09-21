# remotedesk-relay

The public rendezvous server that lets two RemoteDesk installs connect from
different networks (different countries, different NATs) with no port
forwarding on either side - the same trick every "connect from anywhere"
remote-desktop tool relies on.

It does two things only:
1. Matches a machine that registered under a key with a later request for
   that same key.
2. Once matched, blindly forwards bytes between the two connections until
   either side disconnects.

It never sees a real machine ID (only its SHA-256), never understands the
PIN/token proof exchanged through it, and cannot decode screen video, input,
or file transfers - all of that is negotiated directly between the two apps
once paired (WebRTC, encrypted with DTLS-SRTP). See the doc comment at the
top of `src/relay-server.ts` for the exact security contract.

This is a small, cheap, mostly-idle process. A $5/month VPS or a free tier on
Fly.io/Render is enough for personal use - the actual video/control traffic
does **not** flow through it (that part is still direct peer-to-peer via
WebRTC, using the STUN servers already built into the app).

## Deploy with Docker (any VPS)

```bash
cd server
docker build -t remotedesk-relay .
docker run -d --name remotedesk-relay --restart unless-stopped -p 8080:8080 remotedesk-relay
```

That's the whole server. Point a domain at the VPS and put a reverse proxy in
front of it for TLS (`wss://`) - anything that already terminates TLS works:

```nginx
# /etc/nginx/sites-enabled/remotedesk-relay
server {
    listen 443 ssl;
    server_name relay.example.com;

    ssl_certificate     /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s; # long-lived WebSocket, not a normal HTTP request
    }
}
```

(`certbot --nginx -d relay.example.com` gets the certificate.) `wss://` matters:
a plain `ws://` relay reachable from the internet works too, but is
unencrypted between each app and the relay - use TLS for anything beyond a
quick test.

## Deploy for $0

**GitHub Pages and Vercel do not work for this** - not a pricing limit, an
architecture mismatch. GitHub Pages only serves static files, no backend
process at all. Vercel's functions are serverless: short-lived, stateless,
torn down between requests - this relay needs the opposite, one process that
stays alive and holds an in-memory map of who is currently reachable. Neither
can hold a WebSocket connection open indefinitely for many clients at once.

What actually works for free:

**Oracle Cloud "Always Free" (recommended - free forever, a real VPS):**
Oracle's free tier includes a small ARM VM (4 OCPU / 24GB RAM on the Ampere
shape) that never expires as long as you stay within it - no trial period, no
"free for 12 months then billed." Sign up, launch an "Always Free" Ampere
instance, open port 8080 (or 443) in its security list, then follow "Deploy
with Docker" above exactly as written. A card is required at signup for
identity verification, but the Always Free resources are never billed. This
is the closest thing to "deploy once, forget about it, pay nothing" for a
tiny always-on process like this one.

**Fly.io / Render (simpler setup, smaller free allowance):**

```bash
cd server
fly launch --no-deploy   # creates fly.toml, pick any region
fly deploy
```

Both give you a `wss://` URL with TLS already handled, no nginx/certbot
needed. Caveat worth knowing: Render's free web services spin down after ~15
minutes with no incoming HTTP request, so a machine's "always reachable"
registration can get dropped and need to reconnect (the app already retries
automatically - worst case is a short delay on the next connection attempt,
not a permanent break). Check each platform's current free-tier terms before
relying on one; these change over time and I can't promise today's numbers
are still accurate whenever you read this.

**A spare Raspberry Pi / old machine you already own:** genuinely free (you
already paid for the hardware and electricity is negligible for a service
this small), but only works if your home router can forward a port to it AND
your ISP gives you a real public IP (many residential ISPs use CGNAT, which
makes this impossible no matter what you configure). A free dynamic-DNS
service like DuckDNS handles an IP that changes over time. More fragile than
a real VPS - fine to try, not what I'd rely on if the connection matters.

## Point the app at it

In RemoteDesk, on **both** machines: identity card -> relay/internet settings
-> paste the `wss://` URL. LAN connections keep working exactly as before and
are always tried first; the relay is only used when the two machines are not
on the same network.

## Run it locally without Docker

```bash
npm install
npm run build
PORT=8080 npm start
```

## Test it

```bash
npm install
npx vitest run ../tests/server/relay-server.test.ts ../tests/main/relay-connect-flow.test.ts
```

(Run from `server/`, or from the repo root with the paths as they appear in
that repo's `tests/` tree - both test files exercise this server directly
with real WebSocket connections, no mocks.)

## What this does not include

No TURN relay. STUN (built into the app, free, no server needed) gets most
home and mobile connections through directly once this relay has done the
signaling handshake. A minority of networks - symmetric NAT, some corporate
firewalls - need a TURN relay as a last resort, which does carry real
video/control bandwidth and therefore real hosting cost. If you hit that
case, add a TURN server (e.g. [coturn](https://github.com/coturn/coturn)) and
put its `turn:`/`turns:` URL into the app's ICE servers list
(`src/renderer/rtc/peer.ts`).
