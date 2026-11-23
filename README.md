# IIT Delhi Library Management System

An RFID-based entry/exit and seat-management system for the IIT Delhi Central Library. Students tap their library card at a gate kiosk, pick a table on a live floor map, can step out with a temporary seat hold, and leave through an exit kiosk. Library staff run everything from a web/desktop console. Students also get a portal with their current visit, the live map and a community board.

> **Just want to run it?** Follow **[SETUP.md](SETUP.md)**: a step-by-step local setup (MongoDB, server, all apps) with an end-to-end smoke-test checklist.

## Contents

1. [Components](#1-components)
2. [Architecture](#2-architecture)
3. [Current deployment](#3-current-deployment)
4. [Tech stack](#4-tech-stack)
5. [Repository layout](#5-repository-layout)
6. [Features](#6-features)
7. [Quick start (local development)](#7-quick-start-local-development)
8. [Configuration](#8-configuration)
9. [Deploying](#9-deploying)
10. [Business rules](#10-business-rules)
11. [Data model](#11-data-model)
12. [REST API](#12-rest-api)
13. [Socket.IO events](#13-socketio-events)
14. [ESP32 / RFID reader integration](#14-esp32--rfid-reader-integration)
15. [Security](#15-security)
16. [Testing](#16-testing)
17. [Troubleshooting](#17-troubleshooting)
18. [Assumptions and design decisions](#18-assumptions-and-design-decisions)

---

## 1. Components

| Folder | What it is | Who uses it | Runs as |
| --- | --- | --- | --- |
| `server/` | REST API + Socket.IO + hold-expiry worker. Node.js, Express 5, MongoDB (Mongoose) | everything | Render web service |
| `entrygate-app/` | **Entry-gate kiosk**: idle antenna → table map + seat confirmation (10 s) → result | entry gate (`ENTRY-1`) | Electron desktop app on the gate PC |
| `exitgate-app/` | **Exit-gate kiosk**: idle antenna → "Leave now" / hold for N minutes (10 s) → result | exit gate (`EXIT-1`) | Electron desktop app on the gate PC |
| `commonapp/` | **Student + staff app**: landing page, student registration/sign-in/portal, live map, community board, staff/admin console | students, library staff | Electron desktop app **and** a plain website (same React code) |
| `shared/libraryStates.mjs` | Single source of truth for seat/session states, hold policy, community categories, socket event names and error messages | server + all apps | — |
| `shared/libraryLayout.mjs` | The physical floor plan recreated from `librarymap.png` (table grid, IDs, stairs/entry gate) | seed script, maps | — |
| `shared/ui/` | Shared frontend code: API client, Socket.IO client, hash router, hooks, `TableMap`, kiosk graphics, `theme.css` (black-and-white design system) | all three apps | — |

The apps import shared code through the `@shared` alias (see each app's `electron.vite.config.mjs`, and `commonapp/vite.web.config.mjs`). Vite bundles it into each app, so packaging is unaffected. `resolve.dedupe` makes `../shared` use each app's own `react` and `socket.io-client`.

## 2. Architecture

```
 ESP32 RFID reader (planned) ── HTTPS POST /api/gate/scan (terminal key) ──┐
                                                                          ▼
 ┌──────────────────────┐   REST + Socket.IO    ┌─────────────────────────────────────┐
 │ Entry Gate (Electron)│ ───────────────────►  │  Render: iitd-library-backend        │      ┌──────────┐
 │ Exit Gate  (Electron)│ ◄── gate:result ────  │  Express 5 API  (server/src)         │ ───► │ MongoDB  │
 └──────────────────────┘                       │  Socket.IO (same port, same auth)    │      │ (replica │
 ┌──────────────────────┐                       │  hold-expiry worker + reconciler     │      │  set)    │
 │ CommonApp (Electron) │ ── REST + sockets ──► │                                      │      └──────────┘
 │ CommonApp (web,      │ ◄─ map:updated,       │  Email OTP ──► Brevo HTTPS API       │
 │  Vercel)             │    occupancy:updated, │               (or SMTP fallback)     │
 └──────────────────────┘    session:updated    └─────────────────────────────────────┘
```

- **One backend, one database.** MongoDB is the single source of truth; every client renders what the server returns and never derives state locally.
- **Kiosks never hold the device key in the UI.** The Electron main process exchanges the terminal key for a short-lived token; only the token reaches React.
- **Live updates** are pushed over Socket.IO only after the database write commits; clients re-fetch the map after any reconnect.

## 3. Current deployment

| Part | Where | Notes |
| --- | --- | --- |
| Backend | **Render** web service: `https://iitd-library-backend.onrender.com` | Deploys from the `main` branch on GitHub (`origin`). MongoDB with transactions enabled (`/api/ready` reports `transactions: true`) |
| CommonApp web | **Vercel**: root directory `commonapp`, build `npm run build:web`, output `dist-web` | Static site; hash routing, so no rewrites needed |
| CommonApp desktop | Windows installer from `commonapp` (`npm run build:win`) | |
| Entry/Exit gates | Electron apps on the gate PCs | Talk to the Render backend |
| Registration email | **Brevo** transactional email over HTTPS | Render Free blocks outbound SMTP ports, so SMTP is only a local fallback |

**All apps default to the Render backend.** Nothing points at `localhost` unless you configure it (see [Configuration](#8-configuration)).

## 4. Tech stack

| Layer | Technology |
| --- | --- |
| Backend | Node.js ≥ 20.19 (tested on 24), Express 5, Mongoose 9, Socket.IO 4, zod 4 (validation), jsonwebtoken, bcryptjs, helmet, express-rate-limit, nodemailer (SMTP fallback) |
| Database | MongoDB ≥ 6, replica set or Atlas recommended (transactions); standalone also works |
| Frontends | React 19, Vite 8, electron-vite 6, Electron 44, electron-builder, socket.io-client |
| Tests | Node's built-in test runner, supertest, mongodb-memory-server (real `mongod`, in memory) |

## 5. Repository layout

```
iitdlibapp/
├── README.md, SETUP.md           this file, step-by-step local setup
├── librarymap.png, iitd.webp     floor-plan reference, IIT Delhi logo (bundled via @iitd-logo)
├── server/
│   ├── src/
│   │   ├── index.js              entry point: config check → DB → app → sockets → worker
│   │   ├── app.js                Express app: helmet, CORS, rate limit, routes, health/ready
│   │   ├── config/env.js         all environment variables and defaults
│   │   ├── db/connect.js         MongoDB connection, transaction detection, syncIndexes
│   │   ├── routes/               auth, admin, gate, library, community
│   │   ├── controllers/          thin HTTP layer
│   │   ├── services/             business logic (visit, gate, map, occupancy, otp, mail, community, …)
│   │   ├── models/               Mongoose schemas
│   │   ├── middleware/           auth (JWT + terminal key), rateLimit, validate (zod), errorHandler
│   │   ├── realtime/             Socket.IO server and publisher
│   │   └── workers/              hold-expiry worker + reconciler
│   ├── scripts/                  seed, create-admin, create-terminal, register-card
│   └── test/                     node:test suites
├── shared/                       libraryStates.mjs, libraryLayout.mjs, ui/
├── entrygate-app/                src/main (gateConfig.js), src/preload, src/renderer
├── exitgate-app/                 same structure
└── commonapp/
    ├── src/main/appConfig.js     Electron: backend URL
    ├── src/renderer/src/         React app (pages: Landing, StudentAuth, StudentPortal, StaffPortal, CommunityPortal)
    ├── web/                      plain-web entry (index.html, main.jsx)
    ├── electron.vite.config.mjs  Electron build (renderer dev server :5175)
    └── vite.web.config.mjs       web build (dev server :5176, output dist-web/)
```

## 6. Features

### 6.1 Gate kiosks

| | Entry Gate | Exit Gate |
| --- | --- | --- |
| Idle | Antenna animation, "Tap your IIT Delhi library card" | Antenna animation, "Tap your library card to exit" |
| After a valid scan | Table map + confirmation bar (table, optional seat, Cancel / Confirm) with a **10 s** countdown. Re-entry during a hold shows "Resume my seat" | "Leave now" or a seat hold. The hold durations offered depend on how full the library is ([crowd-aware holds](#64-crowd-aware-seat-holds)). **10 s** countdown |
| Countdown expires | Back to idle; nothing is submitted (the scan token simply lapses) | Back to idle; no exit or hold |
| Success | Green tick + table and seat, **3 s** | Green tick + exit or hold details (until when), **3 s** |
| Rejection / failure | The server's message, centred, **2 s** | Same |

- Each kiosk is an explicit state machine (`idle → scanning → selecting/choosing → submitting → success | error → idle`). Every timer and response is tagged with the scan's sequence number, so a late response from an earlier scan can never reset a newer one.
- Confirm buttons are guarded against double submission. A request with no response after 15 s shows an error. Gate windows disable background throttling so timers stay accurate.
- The 10-second windows are `SELECT_SECONDS` (`entrygate-app/src/renderer/src/App.jsx`) and `CHOOSE_SECONDS` (`exitgate-app/src/renderer/src/App.jsx`).
- **Development only:** a small **Manual scan** button (bottom-right) lets you type a card UID (e.g. `04A1B2C301`) without hardware. It sends the same authenticated `POST /api/gate/scan` as the reader and is compiled out of production builds.
- `GATE_KIOSK=1` runs a gate full-screen without window chrome.

### 6.2 CommonApp: students

- **Landing page** with Student, Staff / Admin and Community entry points, and a Light/Dark theme switch (saved in `localStorage` as `iitdlib.theme`; first visit follows the OS).
- **Registration with email OTP** ([details](#105-student-registration-with-email-otp)): IIT Delhi email → 6-digit code → account.
- **Sign-in** with email or entry number + password.
- **Portal:** profile, current state (*outside / inside / hold*), table and seat, hold countdown, and the live table map.
- Students only ever see their own data. There is no student-facing visit history (staff can see history).

### 6.3 CommonApp: staff / admin console

Sections: **Live map**, **Visits**, **Audit logs**, **Students**, **RFID cards**, **Gate terminals**, **Tables**, **Community**.

- `staff` (library desk) can read everything, issue/revoke cards, moderate the community board, and do staff-assisted admission.
- `admin` can additionally change students, terminals (create, enable/disable, rotate keys) and tables.
- There is no public staff sign-up; accounts are created with `npm run create-admin`.

### 6.4 Crowd-aware seat holds

When leaving through the exit gate, a student can keep their seat for a while. The longest allowed hold depends on how full the library is: ratio = (occupied + reserved seats) / capacity.

| Library occupancy | Crowd level | Hold options offered |
| --- | --- | --- |
| ≥ 90 % | high | 15 min |
| 70–90 % | moderate | 15, 30 min |
| 40–70 % | low | 15, 30, 45 min |
| < 40 % | very low | 15, 30, 45, 60 min |

- Defined once in `shared/libraryStates.mjs` (`HOLD_POLICY_TIERS`, `holdPolicyForOccupancy`).
- The server is the only authority: it re-checks occupancy at exit time and clamps whatever the kiosk requests. A request with no duration gets 15 minutes.
- Older exit-kiosk builds that don't send a duration keep working with 15-minute holds.

### 6.5 Community board

A student help board inside CommonApp (`#/community`).

- **Categories:** Academic Help, Collaborate, Resource Exchange, Campus Help, Opportunities, Knowledge Hub.
- **Posts:** title (3–140 chars), body (≤ 4000), up to 10 tags, optional contact info the student chooses to publish. Status *open* or *resolved*.
- **Interactions:** comments (≤ 2000 chars), "interested" toggle (not on your own post), search, filters by category/status, and "my posts".
- **Ownership:** authors can edit, resolve and delete their posts. Staff can pin, resolve and remove any post. Removal deletes its comments and is audit-logged.
- **Limits:** 10 new posts per student per hour (`RATE_LIMIT_COMMUNITY_POST_MAX`).

### 6.6 Library floor plan and map

- The map is recreated from `librarymap.png` on a 22 × 29 grid (`shared/libraryLayout.mjs`): the top wall row, both side walls with the stairs (left) and entry gate (right), the four-across 8-seat rows, five vertical columns of 8-seat tables, and the bottom row.
- Tables are numbered left→right, top→bottom: **E01–E47** (8-seat) and **P01–P61** (2-seat). **108 tables, 498 seats** in total.
- `npm run seed` writes this layout to MongoDB. It creates missing tables, updates changed ones, and deactivates tables not in the layout (with their free seats). Nothing is deleted, and a table with someone seated or on hold is skipped and reported.
- Each table shows its ID and **seats taken / capacity** (taken = occupied + on hold).

**Availability colours** (`shared/ui/TableMap.jsx`):
- **Green:** seats available (`capacity − (occupied + reserved) > 0`, also capped by the server's count of allocatable seats).
- **Red:** full. Held seats count as unavailable.
- **Grey:** availability data missing or invalid; never guessed.

Colours update live through `map:updated` / `occupancy:updated`; there is no polling. Selection adds an outline without hiding the colour. The exit gate shows no map by design.

## 7. Quick start (local development)

Full walkthrough with expected output and a test checklist: **[SETUP.md](SETUP.md)**. In short:

```bash
# 0. Windows only, once: npm scripts in server/ need a POSIX shell
npm config set script-shell "C:\Program Files\Git\bin\bash.exe"

# 1. MongoDB: single-node replica set (or Atlas / a plain local service)
mongod --dbpath <data-dir> --replSet rs0 --port 27017
mongosh --eval "rs.initiate()"

# 2. Server  (http://localhost:5001)
cd server
npm install
cp .env.example .env          # set MONGODB_URI, JWT_SECRET, CARD_UID_PEPPER
npm run seed -- --with-test-data   # floor plan + 3 test students/cards + ENTRY-1/EXIT-1 (prints keys once)
npm run create-admin -- --email librarian@iitd.ac.in --name "Head Librarian"
npm run dev

# 3. Point the apps at the local server (all default to Render), then in separate terminals:
cd entrygate-app && npm install && npm run dev     # needs gate.config.json with the ENTRY-1 key
cd exitgate-app  && npm install && npm run dev     # needs gate.config.json with the EXIT-1 key
cd commonapp     && npm install && npm run dev     # Electron  (app.config.json → localhost)
cd commonapp     && npm run dev:web                # browser   http://localhost:5176 (.env.local → localhost)
```

Generate secrets with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.

| Local address | What |
| --- | --- |
| `http://localhost:5001` | API |
| `:5173` / `:5174` / `:5175` | Renderer dev servers of entry gate / exit gate / CommonApp Electron |
| `http://localhost:5176` | CommonApp web dev server (also reachable from your LAN) |

## 8. Configuration

### 8.1 Server (`server/.env` locally, Environment tab on Render)

See `server/.env.example` for a commented template.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `MONGODB_URI` | **yes** | — | MongoDB connection string |
| `JWT_SECRET` | **yes** (≥ 32 chars) | — | Signs student/staff/terminal tokens |
| `CARD_UID_PEPPER` | **yes** (≥ 32 chars) | — | HMAC key for RFID UIDs. **Changing it invalidates every registered card.** |
| `NODE_ENV` | | `development` | Set `production` on Render |
| `PORT` | | `5001` | Render sets it automatically. Port 5000 conflicts with macOS AirPlay |
| `TRUST_PROXY` | recommended on Render | — | Set `1` behind a proxy so rate limits see real client IPs |
| `CORS_ORIGINS` | | `http://localhost:5173,…:5174,…:5175,…:5176` | Exact browser origins allowed to call the API and Socket.IO. **Must include the deployed web origin** (e.g. `https://<project>.vercel.app`, no trailing slash) |
| `CORS_ALLOW_NULL_ORIGIN` | | `true` | Packaged Electron apps load from `file://` (`Origin: null`) |
| `STUDENT_EMAIL_DOMAINS` | | `iitd.ac.in` | Allowed registration email domains (comma-separated) |
| `STUDENT_EMAIL_ALLOW_SUBDOMAINS` | | `true` | Also allow e.g. `cse.iitd.ac.in` |
| `BREVO_API_KEY` | for registration (or SMTP) | — | Sends OTP emails via Brevo's HTTPS API. When set, the SMTP settings below except `SMTP_FROM` are ignored |
| `SMTP_FROM` | for registration | — | Sender for Brevo and SMTP, e.g. `"IIT Delhi Central Library <library@iitd.ac.in>"`. With Brevo it must be a verified sender |
| `SMTP_HOST` / `SMTP_PORT` | if no Brevo key | — / `587` | SMTP fallback |
| `SMTP_SECURE` | | from port | `true` = implicit TLS (465); otherwise STARTTLS |
| `SMTP_USER` / `SMTP_PASS` | if SMTP needs auth | — | e.g. a Gmail App Password |
| `STUDENT_TOKEN_TTL` / `STAFF_TOKEN_TTL` / `TERMINAL_TOKEN_TTL` | | `12h` / `8h` / `12h` | Token lifetimes |
| `SCAN_TOKEN_TTL_SECONDS` | | `120` | How long a scan stays valid at the kiosk |
| `HOLD_SWEEP_INTERVAL_MS` | | `15000` | Hold-expiry worker interval |
| `BCRYPT_ROUNDS` | | `12` | Password hashing cost |
| `RATE_LIMIT_ENABLED` | | `true` | Master switch |
| `RATE_LIMIT_LOGIN_MAX` / `RATE_LIMIT_LOGIN_WINDOW_MS` | | `10` / 15 min | Login attempts |
| `RATE_LIMIT_REGISTER_MAX` | | `20` | Registrations |
| `RATE_LIMIT_OTP_REQUEST_MAX` / `RATE_LIMIT_OTP_VERIFY_MAX` | | `10` / `30` | OTP requests / checks per IP per 15 min |
| `RATE_LIMIT_GATE_MAX` / `RATE_LIMIT_API_MAX` | | `120` / `600` | Per terminal / per IP per minute |
| `RATE_LIMIT_COMMUNITY_POST_MAX` | | `10` | Community posts per student per hour |
| `ADMIN_BOOTSTRAP_PASSWORD` | | — | Only for non-interactive `create-admin` |
| `SEED_STUDENT_PASSWORD` | | random | Only for `seed --with-test-data` |

### 8.2 Gate kiosks (`entrygate-app`, `exitgate-app`)

Read at runtime by the Electron main process (`src/main/gateConfig.js`), never bundled into the renderer. There is **no `.env` file**. The first source that sets a value wins:

1. Environment variables: `API_BASE_URL`, `GATE_TERMINAL_CODE`, `GATE_TERMINAL_KEY`
2. Installed app: `%APPDATA%\entrygate-app\gate-config.json` (or `exitgate-app`); on macOS `~/Library/Application Support/<app>/`
3. Development only: `gate.config.json` in the app folder (gitignored; start the app from that folder)
4. Default backend: `https://iitd-library-backend.onrender.com`

```json
{ "apiBaseUrl": "https://iitd-library-backend.onrender.com", "terminalCode": "ENTRY-1", "terminalKey": "<key>" }
```

**Terminal keys are shown only once** (when a terminal is created or its key rotated) and stored on the server only as a hash, so they can't be read back. To get a key: CommonApp → Staff / Admin → **Gate terminals** → *Rotate key* (admin), or `npm run create-terminal -- --code ENTRY-1 --rotate` against the right database. Rotating immediately disables the old key.

### 8.3 CommonApp

| Build | Backend URL comes from |
| --- | --- |
| Electron | `API_BASE_URL` env → `%APPDATA%\commonapp\app-config.json` → dev-only `commonapp/app.config.json` → Render default (`src/main/appConfig.js`). Holds no terminal credentials |
| Web | `VITE_API_BASE_URL` (fixed **at build time**; set in `commonapp/.env.local` or the hosting provider) → Render default (`shared/ui/usePortalSession.js`) |

- Socket.IO always uses the same base URL as REST.
- The session token is kept in `sessionStorage` (per browser tab); there are no cookies.
- The logo comes from the project root `iitd.webp` through the `@iitd-logo` alias, so there's no copy to keep in sync.
- CSP: the Electron renderer allows plain HTTP only to `localhost`/`127.0.0.1` and HTTPS/WSS anywhere. The web build allows any `http(s)`/`ws(s)` origin, because its backend is fixed at build time. Deployed servers must use TLS.

## 9. Deploying

### 9.1 Backend (Render)

1. Web service from this GitHub repo, branch `main`. The server loads `../shared`, so the whole repo must be checked out (the default).
2. Build `npm install`, start `npm start` (= `node src/index.js`), from the `server` directory.
3. Environment: at least `MONGODB_URI`, `JWT_SECRET`, `CARD_UID_PEPPER`, `NODE_ENV=production`, `TRUST_PROXY=1`, `CORS_ORIGINS` (including the web frontend's origin), `BREVO_API_KEY` + `SMTP_FROM`.
4. Push to `main` → Render deploys. Check the log for `MongoDB connected (transactions enabled)`, `Email delivery: Brevo HTTPS API` and `Server running at …`.
5. Verify: `GET /api/health` → 200, `GET /api/ready` → `ready: true`, `GET /api/community/posts` → 401 (route exists, needs sign-in).

**Database safety:**
- Deploying runs no migrations or seeds. On start-up the server creates any missing indexes with `syncIndexes()`, which also drops indexes not declared in the schemas.
- **Never run `npm run seed -- --with-test-data` against production.** Its production guard checks the `NODE_ENV` of the shell you run it from, not the database. Plain `npm run seed` rewrites the table layout, and `create-terminal --rotate` breaks the running kiosk until it gets the new key.
- Render Free sleeps after inactivity: the first request can take 30–60 s, which may time out the first kiosk tap. Holds still expire correctly (lazy expiry).

### 9.2 CommonApp web (Vercel, or any static host)

| Setting | Value |
| --- | --- |
| Root directory | `commonapp` (the build also reads `../shared` and `../iitd.webp`; keep Vercel's "include files outside root directory" on) |
| Install command | `npm install --ignore-scripts` (recommended; skips downloading Electron) |
| Build command | `npm run build:web` |
| Output directory | `dist-web` |
| Environment | `VITE_API_BASE_URL=https://iitd-library-backend.onrender.com` (optional, it's the default). Node 20.19+ or 22.12+ |
| Rewrites | None. Routing is hash-based (`#/community/...`) |

Then add the site's exact origin (e.g. `https://<project>.vercel.app`) to `CORS_ORIGINS` on Render. **Without it, login shows "Cannot reach the library server"**, because the browser blocks the response. Vercel preview URLs differ per deploy and need adding separately if you want them to work.

### 9.3 Desktop apps

```bash
npm run build:win     # or build:mac / build:linux, in entrygate-app, exitgate-app or commonapp
```

Installers go to each app's `dist/`. Put the gate config in `%APPDATA%\<app>\gate-config.json` on each kiosk PC. **Use packaged builds on real gates:** the dev build shows the Manual scan button, which lets anyone at the kiosk type any card UID.

## 10. Business rules

Implemented in `server/src/services/visitService.js` and `gateService.js`.

### 10.1 Session ↔ seat ↔ colour

| `LibrarySession.status` | `Seat.status` | Meaning |
| --- | --- | --- |
| *(no open session)* | `available` | Free |
| `inside` | `occupied` | Admitted and currently inside |
| `hold` | `reserved` | Left with a seat hold; kept until `holdUntil` (= `seat.reservedUntil`) |
| `completed` | `available` | Visit over (exit, or hold expired) |

Clients render the `status` the server sends and never derive state from a colour or a local timer. Countdown timers are display-only and corrected by the server's clock (`serverTime`).

### 10.2 Entry

Scan → card lookup (hash) → card active → student active → expire this student's due holds → then:
- **inside** → `DUPLICATE_ENTRY` (audited, no new session)
- **valid hold** → `resume_hold`: the same session goes back to `inside` and the same seat to `occupied`
- **otherwise** → `select_seat`. Confirming atomically creates the session and claims the seat (`SEAT_UNAVAILABLE` / `TABLE_FULL` if lost; the same scan can then pick again). Without a seat choice the server takes the lowest-numbered free seat at the table.

### 10.3 Exit and hold

The session must be `inside`.
- `exit`: session → `completed` and the seat is released, **conditional on `seat.sessionId` = this session**, so a seat is never released twice.
- `hold`: session → `hold`, `holdUntil = now + N min` (server time, N from the [crowd-aware policy](#64-crowd-aware-seat-holds)); seat → `reserved`.
- A student on hold who scans at an exit gate is refused (`ALREADY_ON_HOLD`). A revoked card does not block exit.

### 10.4 Expiry, duplicates and retries

- **Expiry:** the worker (`server/src/workers/holdExpiryWorker.js`) sweeps on start-up and every `HOLD_SWEEP_INTERVAL_MS`. Due holds are also expired **lazily** before every scan, entry, exit, status read and map read, so a late worker never blocks a seat. Expiry completes the session (`endReason: hold_expired`) and frees the seat.
- **Scan tokens** are single-use, bound to one terminal and gate type, and expire after `SCAN_TOKEN_TTL_SECONDS`. A newer scan at the same terminal supersedes older pending ones.
- A token is claimed atomically (`pending → processing`). A retried request with a consumed token **replays the stored result** instead of acting again.
- Devices may send `requestId`; a retried scan with the same id replays the stored response.
- Every transition is a conditional update on the current state, backed by unique indexes.

### 10.5 Student registration with email OTP

1. `POST /api/auth/register/request-otp {email}`: checks the domain policy and that the email isn't registered, then emails a 6-digit code (`crypto.randomInt`).
2. `POST /api/auth/register/verify-otp {email, otp}`: returns a **registration token** valid for 15 minutes, bound to that email.
3. `POST /api/auth/register {…details, registrationToken}`: creates the account. Without a valid token for the same email it returns 403 `EMAIL_NOT_VERIFIED`.

Rules (`server/src/services/otpService.js`):
- Codes expire after 5 minutes and allow 5 attempts (reserved atomically, so parallel guesses can't exceed the limit).
- 60 s resend cooldown, at most 5 codes per email per hour, plus per-IP limits.
- A new code replaces the previous one; codes and tokens are single-use and stored only as keyed hashes.
- Email not configured → 503 `EMAIL_NOT_CONFIGURED`. Delivery failure → 502 `EMAIL_DELIVERY_FAILED` ("We could not send the verification email"), and the cause is logged as `[mail] delivery failed: <code> <reason>`. No usable code is left behind and success is never faked.

### 10.6 Consistency: transactions and crash recovery

On a replica set or Atlas (`/api/ready` → `transactions: true`), the session and seat writes of each operation run in one MongoDB transaction. On a standalone server the same code runs without transactions: each step is still conditional, failures are compensated inline, and a **reconciler** (run by the worker) repairs anything a crash leaves half-done:
- seats held by a closed or missing session are released
- open sessions without a seat are linked to their seat, or closed
- seat status is realigned with session status

It only touches records idle for 60 s, so it never races an in-flight request. The full test suite runs in both modes.

## 11. Data model

All models are in `server/src/models/` and have timestamps.

| Model | Key fields / indexes |
| --- | --- |
| `Student` | unique `entryNumber`, unique lower-cased `email`, `passwordHash` (bcrypt, never returned), `department`, `programme`, `isActive` |
| `Staff` | unique `email`, `passwordHash`, `role: admin \| staff`, `isActive` |
| `LibrarySession` | `studentId`, `entryTime`, `exitTime`, `entryGateId`, `exitGateId`, `status`, `holdUntil`, `seatId`, `tableId`, `isOpen`, `endReason`, `resumeCount`. Unique partial indexes: one `inside` session per student, one open session per student |
| `LibraryTable` | unique `tableCode`, `name`, `capacity`, `location {x, y, width, height, zone}`, `isActive` |
| `Seat` | unique `seatCode`, `tableId`, `seatNumber` (unique per table), `status`, `studentId`, `sessionId`, `reservedUntil`. Unique partial indexes on `sessionId` and `studentId` |
| `RFIDCard` | unique `cardUidHash`, `cardUidHint` (last 4 hex), `studentId`, `isActive`, `issuedAt`, `revokedAt`. At most one active card per student |
| `GateTerminal` | unique `terminalCode`, `gateType: entry \| exit`, `name`, `isActive`, `credentialHash` (SHA-256 of a 256-bit key), `credentialVersion`, `lastSeenAt` |
| `GateScan` | single-use scan token (hash only), terminal, student, `status`, `expiresAt`, idempotency `requestId`, stored result for replays. TTL 24 h |
| `EmailVerification` | hashed OTP / registration token per email, attempts, cooldowns, expiry |
| `CommunityPost` | `authorId`, `category`, `title`, `body`, `tags`, `contactInfo`, `status`, `interestedStudentIds`, `interestedCount`, `commentCount`, `isPinned`. Text index on title/body/tags |
| `CommunityComment` | `postId`, `authorId`, `body` |
| `AuditLog` | `actorType`, `actorId`, `action`, `outcome`, `studentId`, `sessionId`, `terminalCode`, `reason`, `details` (secrets redacted) |
| `RevokedToken` | logged-out JWT ids, TTL-expired |

**Why separate `Seat` documents:** allocation is one atomic conditional update (`Seat.findOneAndUpdate({ …, status: 'available' }, { status: 'occupied', … })`), so two students racing for the same seat can't both win, and different seats at one table don't contend on a shared document. A table has exactly `capacity` seat documents, so capacity can't be exceeded.

## 12. REST API

All responses are `{ "success": true, "data": … }` or `{ "success": false, "error": { "code", "message", "details"? } }`. Paginated lists return `{ items, page, limit, total, totalPages }` (`?page=&limit=`, max 100). Error codes and their user-facing messages are in `shared/libraryStates.mjs` (`ERROR_MESSAGES`).

Auth: `Authorization: Bearer <token>`. Gate endpoints also accept `X-Terminal-Code` + `X-Terminal-Key`.

| Method & path | Auth | Description |
| --- | --- | --- |
| `GET /` | — | Welcome message |
| `GET /api/health` | — | Process liveness |
| `GET /api/ready` | — | 200 when MongoDB answers a ping (503 otherwise); reports transaction support |
| `POST /api/auth/register/request-otp` | — | `{email}` → `{email, emailMasked, expiresAt, resendAvailableAt}` |
| `POST /api/auth/register/verify-otp` | — | `{email, otp}` → `{registrationToken, expiresAt}` |
| `POST /api/auth/register` | registration token | `{registrationToken, entryNumber, name, email, password, department, programme}` → `{student, token, expiresAt}` |
| `POST /api/auth/login` | — | `{identifier (email or entry number), password}` |
| `POST /api/auth/logout` | student/staff | Revokes the token |
| `GET /api/auth/me` | student | Current student |
| `POST /api/admin/login` | — | `{email, password}` → `{staff, token}` |
| `POST /api/admin/logout`, `GET /api/admin/me` | staff | |
| `GET /api/admin/logs` | staff | Filters: `action` (exact, or prefix with trailing `*`), `outcome`, `actorType`, `terminalCode`, `studentId`, `entryNumber`, `from`, `to` |
| `GET /api/admin/students` | staff | `q`, `isActive` |
| `PATCH /api/admin/students/:studentId` | admin | `{isActive?, name?, department?, programme?}` |
| `GET /api/admin/sessions` | staff | `status`, `studentId`, `entryNumber`, `from`, `to` |
| `GET /api/admin/terminals` | staff | |
| `POST /api/admin/terminals` | admin | `{terminalCode, gateType, name}` → key returned **once** |
| `PATCH /api/admin/terminals/:terminalId` | admin | `{name?, isActive?}` |
| `POST /api/admin/terminals/:terminalId/rotate-key` | admin | New key once; the old key and its tokens stop working |
| `GET /api/admin/cards`, `POST /api/admin/cards`, `PATCH /api/admin/cards/:cardId/revoke` | staff | Issue `{entryNumber, cardUid, replaceExisting?}` / revoke `{reason?}` |
| `POST /api/admin/tables`, `PATCH /api/admin/tables/:tableId` | admin | Create (seats generated) / update. Capacity can shrink only by removing free seats |
| `POST /api/gate/terminal/token` | terminal key | Short-lived terminal token for kiosks |
| `GET /api/gate/terminal/me` | terminal | |
| `POST /api/gate/scan` | terminal | `{cardUid, requestId?}` → `{accepted, nextAction, scanToken, expiresAt, student:{displayName, entryNumberMasked}, visit, exitOptions?, holdPolicy?}`; rejections use 403/409 with the gate payload in `error.details` |
| `POST /api/gate/entry` | entry terminal | `{scanToken, tableId?, seatId?}` (only `scanToken` for a hold resume) |
| `POST /api/gate/exit` | exit terminal | `{scanToken, mode: "exit" \| "hold", holdMinutes?}`. `holdMinutes` is clamped by the server |
| `GET /api/gate/status/:entryNumber` | the student themselves, or staff | `{state: outside \| inside \| hold, visit}` |
| `GET /api/library/map` | student/staff/terminal | Canvas, legend, tables with seats, occupancy, `serverTime` |
| `GET /api/library/occupancy` | student/staff/terminal | Counts, capacity, `studentsInside`, `studentsOnHold`, `holdPolicy` |
| `GET /api/library/tables` | student/staff/terminal | Active tables with counts |
| `GET /api/library/tables/:tableId/seats` | student/staff/terminal | Seats of one table |
| `POST /api/library/seats/allocate` | staff | Staff-assisted admission `{entryNumber, terminalCode, tableId?, seatId?}`; same rules as gate entry |
| `GET /api/community/posts` | student/staff | `category`, `status`, `q` (text search), `mine`, pagination |
| `POST /api/community/posts` | student | `{category, title, body, tags?, contactInfo?}` (rate-limited) |
| `GET /api/community/posts/:postId` | student/staff | One post |
| `PATCH /api/community/posts/:postId` | author or staff | Author: content and status. Staff: `status`, `isPinned` |
| `DELETE /api/community/posts/:postId` | author or staff | Deletes the post and its comments |
| `POST /api/community/posts/:postId/interest` | student | Toggle "interested" (not on own posts) |
| `GET /api/community/posts/:postId/comments` | student/staff | Paginated |
| `POST /api/community/posts/:postId/comments` | student | `{body}` |

Public scan/map responses never include who sits where, emails, full entry numbers or card data.

## 13. Socket.IO events

Connect with `io(API_BASE_URL, { auth: { token } })` using a student, staff or terminal token. Invalid tokens are refused at the handshake, and sockets are disconnected when the token expires. Client events are rate-limited (20 per 10 s per socket) and acknowledged with `{ ok, error? }`. The same CORS origin list as REST applies.

| Direction | Event | Who | Payload |
| --- | --- | --- | --- |
| client → server | `map:subscribe` | any authenticated | joins the live-map room |
| client → server | `gate:subscribe` | terminal (own gate only) | `{terminalCode?}` |
| client → server | `admin:subscribe` | staff | — |
| server → client | `gate:result` | the scanning terminal | Scan result (`stage: "scan"`, includes `scanToken`) or completion (`stage: "completed"`) |
| server → client | `map:updated` | map + admin rooms | `{seats: [seat…], serverTime}`, or `{reload: true}` after layout changes |
| server → client | `occupancy:updated` | map + admin rooms | Same shape as `GET /api/library/occupancy` |
| server → client | `session:updated` | that student's private room + admin | Session summary |
| server → client | `admin:log` | admin room | New audit-log entry |

## 14. ESP32 / RFID reader integration

The backend side is built and tested; the firmware is still to do (reader driver, Wi-Fi/TLS client, `requestId` generation, LED/buzzer feedback).

1. Register the gate: `npm run create-terminal -- --code ENTRY-2 --type entry --name "North entrance"` (or in the staff console). Store the printed key in the device's secure storage (NVS/encrypted flash), never in an app frontend.
2. On each card tap:
   ```http
   POST /api/gate/scan HTTP/1.1
   Host: iitd-library-backend.onrender.com
   Content-Type: application/json
   X-Terminal-Code: ENTRY-2
   X-Terminal-Key: <terminal key>

   {"cardUid": "04A31B22", "requestId": "<unique per physical tap, 8–64 [A-Za-z0-9_-]>"}
   ```
   On a timeout, resend with the **same** `requestId`; the server replays its first answer.
3. Response: 200 `{"success": true, "data": {"accepted": true, "nextAction": "select_seat" | "resume_hold" | "choose_exit", …}}` → e.g. green LED. 403 (`UNKNOWN_CARD`, `CARD_REVOKED`, `STUDENT_INACTIVE`) or 409 (`DUPLICATE_ENTRY`, `NOT_INSIDE`, `ALREADY_ON_HOLD`, `LIBRARY_FULL`) → red LED. 401 means wrong or disabled terminal credentials.
4. The kiosk at the same gate receives the result instantly (`gate:result`) and the student completes the choice on screen.

Always use **HTTPS**: the key travels in a header. Test with curl:

```bash
curl -X POST https://iitd-library-backend.onrender.com/api/gate/scan \
  -H "X-Terminal-Code: ENTRY-1" -H "X-Terminal-Key: $KEY" \
  -H "Content-Type: application/json" -d '{"cardUid":"04A1B2C301","requestId":"test-000001"}'
```

## 15. Security

- **Secrets** live only in environment variables (`server/.env` locally, Render's Environment tab in production) and in per-machine gate config files. All of these are gitignored; nothing secret is committed or bundled into a frontend.
- **Passwords:** bcrypt (`BCRYPT_ROUNDS`). **Tokens:** short-lived JWTs; logout revokes them server-side.
- **Cards:** the card stores nothing about the student. The server keeps only `HMAC-SHA256(CARD_UID_PEPPER, UID)`. A UID is **not** a secret (anyone with a reader can read or clone it), so a scan only identifies a student; the trust boundary is the authenticated terminal. Stronger guarantees would need cryptographic cards (e.g. MIFARE DESFire).
- **Terminal keys:** 256-bit, stored as SHA-256 hashes, shown once, rotatable. The kiosk UI only ever sees a short-lived token.
- **Authorization:** role checks on every route (student / staff / admin / terminal, entry vs exit gate). Students can only read their own status.
- **Validation and limits:** zod schemas on every input, 32 KB JSON limit, per-IP/per-terminal/per-student rate limits, helmet headers.
- **CORS:** exact-match origin list. Auth uses bearer tokens, not cookies, so CORS is defence in depth rather than the main boundary.
- **Audit log** for every gate decision, admin change and community moderation action, with secrets redacted.
- **Known caveats:** the dev-only Manual scan button must not be used on real gates (use packaged builds); tokens in `sessionStorage` would be exposed by an XSS bug (mitigated by a strict `script-src 'self'` CSP); community contact info is visible to every signed-in user.

## 16. Testing

```bash
cd server
npm test                  # all suites against an in-memory MongoDB replica set (transactions)
npm run test:standalone   # the same suites against a standalone mongod (no transactions)
npm run lint              # syntax check of server sources
cd ../entrygate-app && npm run lint && npm run build
cd ../exitgate-app  && npm run lint && npm run build
cd ../commonapp     && npm run lint && npm run lint:shared && npm run build && npm run build:web
```

On Windows, run these with npm's script shell set to Git Bash (see [Quick start](#7-quick-start-local-development)); under `cmd.exe`, `npm test` silently reports `tests 0`.

The tests use `mongodb-memory-server` (a real `mongod`, downloaded on first run) and a controllable clock (`server/src/services/clock.js`), so holds are tested instantly. They never touch your dev database or send real email. Coverage includes:

- registration and login, duplicate identifiers, email policy
- email OTP: delivery, hashing, correct/incorrect/expired codes, attempt limits (including concurrent guesses), cooldown and hourly cap, single-use tokens, delivery failure, missing email configuration
- Brevo HTTPS transport: request shape, error mapping, timeouts, no key in errors
- entry/double entry, invalid, inactive and revoked cards
- capacity, exit, duplicate exit, crowd-aware holds, resume, worker and lazy expiry, new visit after expiry
- concurrent seat, table, student and exit races
- admin/terminal authorization, key rotation, no secret leakage
- community posts, comments, interest, ownership and moderation
- CORS: unlisted origins refused, listed origins and Electron (`Origin: null`) allowed
- socket emissions only after commits (including a simulated transaction failure), Socket.IO auth and subscriptions
- restart recovery and reconciliation

## 17. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Web app: "Cannot reach the library server" on login | The page's origin isn't in `CORS_ORIGINS` on Render (the browser blocks the 403). Add the exact origin, e.g. `https://<project>.vercel.app`. Also check `VITE_API_BASE_URL` if set |
| Registration: "We could not send the verification email" | Delivery failed. Render's log shows `[mail] delivery failed: …`. `ETIMEDOUT` with SMTP → Render Free blocks SMTP ports; set `BREVO_API_KEY`. `unauthorized` → wrong key or Brevo IP restriction (Brevo → Security → Authorised IPs). Sender errors → `SMTP_FROM` isn't a verified Brevo sender |
| Registration: "not configured" | `SMTP_FROM` plus either `BREVO_API_KEY` or `SMTP_HOST` is missing |
| Kiosk: terminal not configured / 401 | No or wrong gate config, the key was rotated, or the kiosk points at a different backend than the one that issued the key ([8.2](#82-gate-kiosks-entrygate-app-exitgate-app)) |
| First request after a while is very slow or times out | Render Free instance waking up; retry |
| Server exits mentioning `JWT_SECRET` / `CARD_UID_PEPPER` | Missing or shorter than 32 characters |
| `MongoServerSelectionError` / `/api/ready` 503 | MongoDB not reachable, or wrong `MONGODB_URI` (did you run `rs.initiate()`?) |
| `npm test` prints `tests 0` | Windows: npm is using `cmd.exe`; set `script-shell` to Git Bash |
| `Port 517x is already in use` | Dev ports are fixed (`strictPort`); close the other process |
| Manual scan button missing | It exists only in `npm run dev`, never in packaged builds |

More local-setup troubleshooting is in [SETUP.md](SETUP.md#8-troubleshooting).

## 18. Assumptions and design decisions

- **Student email policy** is configurable (`STUDENT_EMAIL_DOMAINS`). The default, `iitd.ac.in` plus subdomains, is an assumption to confirm with the library.
- **Entry numbers** are validated as 6–15 letters/digits and stored upper-case (e.g. `2021CS10123`), deliberately lenient since the exact format rule wasn't specified.
- **Table first, then seat:** the student taps a table and may tap a specific free seat; otherwise the server picks the lowest-numbered free seat (deterministic).
- **Holds** are unlimited in number per visit; their maximum length follows the crowd-aware policy.
- **Exit from a hold** is refused (`ALREADY_ON_HOLD`), since the student is already outside. A revoked card can still exit but can't enter.
- **The ESP32 uses REST only** (no Socket.IO), which is simpler for firmware and supports idempotent retries.
- **No student visit history:** the backend only exposes history to staff (`GET /api/admin/sessions`); a student endpoint would need to be added.
- **The reference floor plan has no washrooms**, so none are drawn; the exit gate shows no map by design.
