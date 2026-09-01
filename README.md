# GeoPing

A small, self-hosted location-sharing app for a private group of people who trust each other — think a lightweight "Find My Friends." Nobody sees anyone's location unless they've joined a **circle** using an invite code, and everyone can pause sharing at any time.

## What it does

- **Live map** — everyone in a circle shows up as a moving dot on a shared map (uses your phone's GPS via the browser, updated every few seconds while the tab/app is open).
- **Ping** — tap a circle-mate's name to send them an instant nudge (in-app toast + notification + vibration + sound).
- **Photo drops** — snap or upload a photo, optionally pinned to your current location, and send it to the whole circle or just one person.
- **Circles** — private groups joined only via a 6-character invite code. Anyone can leave, and a "Sharing my location" toggle lets you pause without leaving.
- **Installable** — it's a Progressive Web App, so "Add to Home Screen" gives it an app icon and full-screen feel on a phone, with no app store needed.

## Before you rely on this, please read

- **This runs entirely in the browser.** iOS Safari and most mobile browsers pause GPS updates when the browser is backgrounded or the phone is locked — this is an OS/browser restriction, not something any web app can override. For truly continuous background tracking (the phone reporting location while the app icon sits closed in a pocket for hours), you'd need a native iOS/Android app with a background-location permission grant, which is a different, much larger project.
- **It's designed around consent.** People only ever join a circle by typing an invite code they were given, and they can leave or pause sharing at any time. Please keep it that way — don't use invite codes or accounts to track someone who hasn't agreed to it.
- **This is a small-group tool, not production infrastructure.** Data is stored in a single JSON file on the server (fine for a handful of friends/family; not built for thousands of users or high write concurrency). There's no password-reset flow, no email verification, and uploaded photos are kept indefinitely — you may want to add cleanup later.
- **HTTPS is required for GPS in production.** Browsers only allow precise geolocation over `https://` (or `localhost` while testing). Any of the hosts below give you free HTTPS automatically.

## Running it locally

You'll need [Node.js](https://nodejs.org) 18 or newer.

```bash
cd geoping
npm install
cp .env.example .env      # then edit .env and set a real JWT_SECRET
npm start
```

Open `http://localhost:3000` on your computer, or on your phone if it's on the same Wi-Fi network as your computer (use your computer's local IP instead of localhost, e.g. `http://192.168.1.23:3000`) — location sharing itself will still work over plain HTTP on localhost/local IPs for quick testing, though some browsers are stricter, so deploying with real HTTPS (below) is the smoother path once you're testing with friends.

## Deploying so friends can actually use it

The easiest free option is **[Render](https://render.com)**:

1. Push this project to a GitHub repository (private is fine).
2. On Render: **New +** → **Web Service** → connect that repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Under **Environment**, add `JWT_SECRET` with a long random value (generate one with `openssl rand -hex 32`).
5. Deploy. Render gives you a free `https://your-app.onrender.com` URL with HTTPS already set up — exactly what the Geolocation API needs.
6. Share that URL with your circle, have everyone sign up, create or join a circle with an invite code, and allow location + notifications when the browser asks.

**Railway** or **Fly.io** work the same way if you prefer them — same three settings: `npm install`, `npm start`, and a `JWT_SECRET` environment variable.

One caveat with Render's free tier: the service "sleeps" after inactivity and takes ~30 seconds to wake up on the next visit — fine for casual use, but worth knowing.

### A note on data persistence

Uploaded photos live in the `uploads/` folder and the database is `data/store.json` — both are written to the server's local disk. On Render's free tier that disk is **not** persistent across deploys/restarts, so a redeploy can wipe your users and photos. For anything you want to keep, either upgrade to a Render plan with a persistent disk, or ask me to swap the storage layer for something like a hosted Postgres + S3-compatible bucket (both have generous free tiers) — that's a moderate follow-up change, not a rewrite.

## Project structure

```
geoping/
  server.js          Express + Socket.IO backend (auth, circles, drops, live location, pings)
  db.js              Tiny JSON-file "database" — no external database needed
  public/            The whole frontend: one HTML page, CSS, and app.js (vanilla JS + Leaflet map)
  data/store.json    Created automatically — users, circles, photo-drop metadata
  uploads/           Created automatically — the actual photo files
```

## Ideas for later

- Push notifications that work even when the browser tab is fully closed (needs a push service + service worker changes).
- Location history / a "where was everyone at noon" playback.
- A proper database (Postgres) and object storage (S3) for real persistence at scale.
- A native wrapper (e.g. with Capacitor) if you outgrow the browser's background-location limits.
