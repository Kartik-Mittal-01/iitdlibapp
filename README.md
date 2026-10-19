# IITD Library Management System

One Express + MongoDB backend shared by three Electron + React apps:

| Folder | What it is | Who uses it |
| --- | --- | --- |
| `server/` | Node.js + Express REST API, Socket.IO, MongoDB (Mongoose), hold-expiry worker | everything |
| `entrygate-app/` | **Entry-gate kiosk** only: idle antenna → table map + seat confirmation (10 s) → result | entry gate (`ENTRY-1`) |
| `exitgate-app/` | **Exit-gate kiosk** only: idle antenna → "Hold — 15 minutes" / "Leave now" (10 s) → result | exit gate (`EXIT-1`) |
| `commonapp/` | **Student and staff/admin app**: landing (Student / Staff-Admin), registration, sign-in, current visit, live map; staff console (map, visits, audit logs, students, RFID cards, terminals, tables) | students, library staff |
| `shared/libraryStates.mjs` | Seat/session states, socket event names, error messages: used by the server and all apps | — |
| `shared/libraryLayout.mjs` | The physical floor plan recreated from `librarymap.png` (table grid, IDs, stairs/entry gate) | seed script, map |
| `shared/ui/` | Shared frontend code: API client, Socket.IO client, hooks, `TableMap`, kiosk graphics, `theme.css` (black & white design system) | all three apps |

The apps import shared code through the `@shared` alias (`electron.vite.config.mjs`). Vite bundles it into each app, so packaging is unaffected. `resolve.dedupe` makes `../shared` use each app's own `react` and `socket.io-client`.

```
 ESP32 reader ──HTTPS: POST /api/gate/scan (terminal key)──┐
                                                           ▼
 Entry kiosk ◄── Socket.IO gate:result ──  Express API ──► MongoDB
 Exit kiosk  ──  POST /api/gate/entry|exit (scan token) ─► (single source of truth)
 Student/Staff UI ◄── REST + map:updated / occupancy:updated / session:updated / admin:log
```

## Quick start (development)

Prerequisites: Node.js ≥ 20.19 (tested on 24), npm, MongoDB ≥ 6. A replica set (or Atlas) is recommended because it enables transactions. A standalone server also works; see [Consistency](#consistency-transactions-and-crash-recovery).

```bash
# 1. MongoDB: single-node replica set (one-time setup, macOS/Homebrew example)
brew tap mongodb/brew && brew install mongodb-community
mongod --dbpath ~/data/iitdlib --replSet rs0 --port 27017 &
mongosh --eval 'rs.initiate()'

# 2. Server
cd server
npm install
cp .env.example .env        # then edit: MONGODB_URI, JWT_SECRET, CARD_UID_PEPPER
#   MONGODB_URI=mongodb://127.0.0.1:27017/iitd_library?replicaSet=rs0
#   generate secrets: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
npm run seed -- --with-test-data   # tables/seats + 3 test students with cards + ENTRY-1/EXIT-1 terminals
npm run create-admin -- --email librarian@iitd.ac.in --name "Head Librarian"
npm run dev                         # http://localhost:5001

# 3. Entry gate kiosk (renderer dev server on :5173)
cd ../entrygate-app
npm install
GATE_TERMINAL_CODE=ENTRY-1 GATE_TERMINAL_KEY=<key printed by seed> npm run dev

# 4. Exit gate kiosk (renderer dev server on :5174)
cd ../exitgate-app
npm install
GATE_TERMINAL_CODE=EXIT-1 GATE_TERMINAL_KEY=<key printed by seed> npm run dev

# 5. Student + staff/admin app (renderer dev server on :5175; no terminal key)
cd ../commonapp
npm install
npm run dev
```

In development each kiosk has a small **"Manual scan"** button in the bottom-right corner: type a seeded card UID (for example `04A1B2C301`) to drive the full flow without hardware. It sends the same authenticated `POST /api/gate/scan` the ESP32 would, and it is not shown in production builds.

Set `GATE_KIOSK=1` to run a gate full-screen without window chrome.

### Kiosk flow and timings

| | EntryGate | ExitGate |
| --- | --- | --- |
| Idle | Antenna animation, "Tap your IIT Delhi library card" | Antenna animation, "Tap your library card to exit" |
| After a valid scan | Table map + confirmation bar (table, optional seat, Cancel / Confirm) with a **10 s** countdown. Re-entry during a hold shows "Resume my seat" with the same countdown | "Hold — 15 minutes" / "Leave now" with a **10 s** countdown |
| Countdown expires | Back to idle; nothing is submitted (the server's scan token simply lapses) | Back to idle; no exit or hold |
| Success | Green tick + table and seat, **3 s** | Green tick + exit or hold details (until when), **3 s** |
| Rejection / failure | The server's message, centered, **2 s** | Same |

Each kiosk is an explicit state machine (`idle → scanning → selecting/choosing → submitting → success | error → idle`). Every timer and response is tagged with the scan's sequence number, so a timer or late response from an earlier scan can never reset a newer one. Confirm buttons are guarded against double submission. Socket.IO map updates never change the kiosk state. A request with no response after 15 s shows an error. Gate windows disable background throttling so timers stay accurate even when covered.

The 10-second window starts when the map appears and covers both choosing a table and confirming. It is `SELECT_SECONDS` in `entrygate-app/src/renderer/src/App.jsx` and `CHOOSE_SECONDS` in `exitgate-app/src/renderer/src/App.jsx`.

### Library floor plan

The map is recreated from `librarymap.png` as table rectangles on a 22 × 29 grid (`shared/libraryLayout.mjs`). The relative arrangement and groupings match the reference:
- the top wall row
- both side walls, with the stairs (left) and the entry gate (right)
- the four-across horizontal 8-seat rows
- the five vertical columns of 8-seat tables
- the bottom row

Column widths are made uniform so every table stays legible. The reference has no labels, so tables are numbered left→right, top→bottom:
- **E01–E47:** 8-seat tables
- **P01–P61:** 2-seat tables
- **Total:** 108 tables, 498 seats

`npm run seed` writes this layout to MongoDB. It creates missing tables and updates changed ones. It deactivates tables that aren't in the layout, such as the earlier A1–D3 samples, together with their free seats. Nothing is deleted, and a table with someone seated or on hold is skipped and reported, so re-run the seed once it is free. At runtime the map is drawn entirely from the backend's tables (codes, positions, live counts). Each table shows its ID and **seats taken / capacity**, where taken = occupied + on hold.

**Availability colours** (`shared/ui/TableMap.jsx`, used by the entry kiosk and CommonApp):
- **Green:** `availableSeats = capacity − (occupied + reserved) > 0`. The value is also capped by the backend's count of allocatable seats.
- **Red:** `availableSeats === 0`. Held (reserved) seats count as unavailable.
- **Neutral grey:** availability data is missing or invalid, so it is never guessed.

Colours change live through the existing `map:updated` / `occupancy:updated` Socket.IO events when a student enters, exits, starts a hold, re-enters, or a hold expires. There is no polling. Selection and hover add an outline without hiding the colour. ExitGate shows no map, by design of the kiosk flow. The reference plan has no washrooms, so none are drawn.

`npm run seed -- --with-test-data` prints each terminal key once. To get a new key: `npm run create-terminal -- --code ENTRY-1 --rotate`.

### Production commands

| App | Command |
| --- | --- |
| server | `NODE_ENV=production npm start` |
| entrygate-app | `npm run build:mac` / `build:win` / `build:linux` (electron-builder) |
| exitgate-app | same as entrygate-app |
| commonapp | same as entrygate-app |

## Configuration

### Server (`server/.env`, see `server/.env.example`)

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `MONGODB_URI` | yes | — | MongoDB connection string |
| `JWT_SECRET` | yes (≥ 32 chars) | — | Signs student/staff/terminal tokens |
| `CARD_UID_PEPPER` | yes (≥ 32 chars) | — | HMAC key for RFID UIDs. **Changing it invalidates every registered card.** |
| `PORT` | | `5001` | Port 5000 conflicts with macOS AirPlay |
| `CORS_ORIGINS` | | `http://localhost:5173,http://localhost:5174,http://localhost:5175` | Browser origins allowed to call the API (EntryGate, ExitGate, CommonApp dev servers) |
| `CORS_ALLOW_NULL_ORIGIN` | | `true` | Packaged Electron apps load from `file://` (fetch sends `Origin: null`, WebSocket sends `file://`) |
| `STUDENT_EMAIL_DOMAINS` | | `iitd.ac.in` | Allowed registration email domains (comma-separated) |
| `STUDENT_EMAIL_ALLOW_SUBDOMAINS` | | `true` | Also allow e.g. `cse.iitd.ac.in` |
| `SMTP_HOST` / `SMTP_PORT` | for registration | — / `587` | SMTP server for registration OTP emails |
| `SMTP_SECURE` | | from port | `true` = implicit TLS (465); otherwise STARTTLS when offered |
| `SMTP_USER` / `SMTP_PASS` | if the server needs auth | — | SMTP login (e.g. a Gmail App Password) |
| `SMTP_FROM` | for registration | — | Sender, e.g. `"IIT Delhi Central Library <library@iitd.ac.in>"` |
| `RATE_LIMIT_OTP_REQUEST_MAX` / `RATE_LIMIT_OTP_VERIFY_MAX` | | `10` / `30` | OTP requests / checks per IP per 15 minutes |
| `STUDENT_TOKEN_TTL` / `STAFF_TOKEN_TTL` / `TERMINAL_TOKEN_TTL` | | `12h` / `8h` / `12h` | Token lifetimes |
| `SCAN_TOKEN_TTL_SECONDS` | | `120` | Time a student has at the kiosk after tapping |
| `HOLD_SWEEP_INTERVAL_MS` | | `15000` | Hold-expiry worker interval |
| `BCRYPT_ROUNDS` | | `12` | Password hashing cost |
| `RATE_LIMIT_*` | | see example | Login, registration, gate and general API limits |
| `TRUST_PROXY` | | — | Set behind a reverse proxy so rate limits see client IPs |

### Gate kiosks (`entrygate-app`, `exitgate-app`)

These are read **at runtime by the Electron main process** and never bundled into the renderer. Sources, highest priority first:

1. Environment variables: `API_BASE_URL` (default `http://localhost:5001`), `GATE_TERMINAL_CODE`, `GATE_TERMINAL_KEY`
2. `<userData>/gate-config.json`: `{ "apiBaseUrl": "...", "terminalCode": "...", "terminalKey": "..." }`. On macOS `userData` is `~/Library/Application Support/entrygate-app/` (or `exitgate-app/`).
3. Development only: `./gate.config.json` in the app folder (gitignored)

The terminal key stays in the main process. The renderer asks the main process (IPC `gate:get-token`), which exchanges the key for a short-lived **terminal token** (`POST /api/gate/terminal/token`). Only that token reaches React.

### Student registration with email OTP

Registration proves the student owns their IIT Delhi email before an account exists:

1. `POST /api/auth/register/request-otp {email}` checks the email policy (`STUDENT_EMAIL_DOMAINS`) and that the email is not registered. It then emails a 6-digit code from `crypto.randomInt`.
2. `POST /api/auth/register/verify-otp {email, otp}` returns a **registration token** valid for 15 minutes and bound to that email.
3. `POST /api/auth/register {…details, registrationToken}` creates the account. Without a valid token for the same email it returns 403 `EMAIL_NOT_VERIFIED`; a client-side "verified" flag means nothing to the server.

Rules (`server/src/services/otpService.js`):
- Codes expire after 5 minutes.
- Each code allows 5 attempts. Attempts are reserved atomically, so parallel guesses can't exceed the limit.
- The resend cooldown is 60 s, with at most 5 codes per email per hour, plus per-IP rate limits.
- A new code replaces the previous one. A verified code can't be reused, and a token works once.
- Codes and tokens are stored only as keyed hashes. They never appear in API responses, logs or the email subject.
- If SMTP isn't configured, the request returns 503 `EMAIL_NOT_CONFIGURED`. If the mail server fails, it returns 502 `EMAIL_DELIVERY_FAILED`. In both cases no usable code is left behind, and success is never faked.

**Setting up SMTP:** add the `SMTP_*` variables to `server/.env` (see `.env.example`) and restart the server. It warns at start-up when SMTP is missing.
- **Gmail / Google Workspace:** `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER=<account>`, `SMTP_PASS=<16-character App Password>` (needs 2-step verification), `SMTP_FROM="IIT Delhi Central Library <account>"`.
- **Microsoft 365:** `smtp.office365.com:587`.
- **Institute relay:** ask IIT Delhi IT for the host, port and credentials.

Test it by registering in CommonApp with your own IIT Delhi email.

### CommonApp (`commonapp`)

Has a **Light/Dark theme** switch in the header. The choice is saved in `localStorage` (`iitdlib.theme`); on first visit it follows the OS setting. `public/theme-init.js` applies it before first paint. The dark palette only redefines the shared CSS tokens under `:root[data-theme='dark']` in CommonApp's `app.css`, so the gate kiosks always stay light.

The landing page shows the IIT Delhi logo from the project root (`iitd.webp`). It is imported through the `@iitd-logo` Vite alias and bundled into each build, so there's no copy to keep in sync and no absolute path.

Needs only `API_BASE_URL` (env, `<userData>/app-config.json`, or in development `./app.config.json`). It holds no terminal credentials; students and staff sign in with their own accounts.

Students see only their own data: profile, current visit and seat (`GET /api/gate/status/:entryNumber`, which the server restricts to the student themselves), and the public table-level map. The backend has **no student-facing visit-history endpoint** (visit history is `GET /api/admin/sessions`, staff only), so the student portal shows the current visit, not past visits. Adding history would need a new backend endpoint.

The renderer CSP allows API connections to `localhost`/`127.0.0.1` over HTTP and to any host over HTTPS/WSS. Deployed servers must use TLS.

## Assumptions and design decisions

- **Student email policy:** configurable via `STUDENT_EMAIL_DOMAINS`. The default is `iitd.ac.in` plus subdomains, which is an assumption to confirm with the library.
- **Entry numbers:** validated as 6–15 letters/digits and stored upper-case (e.g. `2021CS10123`). Deliberately lenient, since the exact format rule was not specified.
- **Table first, then seat:** the student taps a table on the map. They can tap a specific green seat, or let the server allocate the **lowest-numbered free seat** at that table (deterministic).
- **Cards:** the card stores nothing about the student. The reader sends the card's UID; the server stores only `HMAC-SHA256(CARD_UID_PEPPER, UID)` and maps it to a student. Lost cards are revoked in the staff console. **A UID is not a secret** (it can be read or cloned by anyone with a reader), so a card scan only identifies a student. The trust boundary is the authenticated terminal: arbitrary devices cannot submit scans. Cards with cryptographic authentication (e.g. MIFARE DESFire) would be needed for stronger guarantees. No encryption keys exist in any frontend.
- **Exit from a hold:** a student on hold who scans at an exit gate is refused (`ALREADY_ON_HOLD`), since they are already outside. Holds are not limited in number per visit.
- **Revoked card at exit:** exit is not blocked by card revocation (the student is already inside); entry is.
- **Staff roles:** `admin` has full control. `staff` (library desk) can read logs, visits, students and terminals, issue/revoke cards, and do staff-assisted admission. Only admins can change students, terminals or tables.
- **Socket for ESP32:** not used. The ESP32 talks REST only, which is simpler for the firmware and supports idempotent retries. `gate:scan` was therefore not implemented.

## Data model

All models are in `server/src/models/` and have timestamps.

| Model | Key fields / indexes |
| --- | --- |
| `Student` | unique `entryNumber`, unique lower-cased `email`, `passwordHash` (bcrypt, `select: false`, stripped from JSON), `department`, `programme`, `isActive` |
| `Staff` | unique `email`, `passwordHash`, `role: admin \| staff`, `isActive`. No public registration |
| `LibrarySession` | `studentId`, `entryTime`, `exitTime`, `entryGateId`, `exitGateId`, `status`, `holdUntil`, `seatId`, `tableId`, `isOpen`, `endReason`, `resumeCount`. Unique partial index `{studentId}` where `status: inside`, **and** unique partial `{studentId, isOpen}` where `isOpen: true` |
| `LibraryTable` | unique `tableCode`, `name`, `capacity`, `location {x, y, width, height, zone}`, `isActive` |
| `Seat` | unique `seatCode`, `tableId`, `seatNumber` (unique per table), `position`, `status`, `studentId`, `sessionId`, `reservedUntil`. Unique partial indexes on `sessionId` and `studentId` |
| `RFIDCard` | unique `cardUidHash`, `cardUidHint` (last 4 hex), `studentId`, `isActive`, `issuedAt`, `revokedAt`. At most one active card per student |
| `GateTerminal` | unique `terminalCode`, `gateType: entry \| exit`, `name`, `isActive`, `credentialHash` (SHA-256 of a 256-bit key), `credentialVersion`, `lastSeenAt` |
| `GateScan` | single-use scan token (hash only), terminal, student, `status`, `expiresAt`, idempotency `requestId`, stored result for replays. TTL 24 h |
| `AuditLog` | `actorType`, `actorId`, `action`, `outcome`, `studentId`, `sessionId`, `terminalCode`, `reason`, `details` (secrets redacted), `createdAt` |
| `RevokedToken` | logged-out JWT ids, TTL-expired |

**Why separate `Seat` documents (not seats embedded in the table):** allocation is one atomic conditional update, `Seat.findOneAndUpdate({ _id | tableId, status: 'available' }, { status: 'occupied', sessionId, studentId })`. Two students racing for the same seat cannot both match. Different seats on the same table don't contend on a shared document. Capacity can't be exceeded because a table has exactly `capacity` seat documents (`{tableId, seatNumber}` is unique and `seatNumber ≤ capacity`). The partial unique indexes on `Seat.sessionId`/`studentId` stop one visit or student from holding two seats.

### Session ↔ seat ↔ map colour

Defined once in `shared/libraryStates.mjs`:

| `LibrarySession.status` | `Seat.status` | Colour | Meaning |
| --- | --- | --- | --- |
| *(no open session)* | `available` | green | Free |
| `inside` | `occupied` | red | Admitted and currently inside |
| `hold` | `reserved` | yellow | Left with "15-minute hold"; seat kept until `holdUntil` (= `seat.reservedUntil`) |
| `completed` | `available` | green | Visit over (immediate exit, or hold expired) |

The kiosks and CommonApp draw tables, not individual seats. Tables are green when seats are available and red when the table is full. A black outline marks the selected table or "your table". The seat states above still drive the per-table counts and the seat picker at the entry gate. Clients render the `status` the server sends. They never derive state from a colour or a local timer. Countdown timers in the UI are display-only and corrected by the server's clock (`serverTime`).

## Business rules (server/src/services/visitService.js, gateService.js)

**Entry:** scan → card lookup (hash) → card active → student active → lazily expire this student's due holds → then:
- **inside** → `DUPLICATE_ENTRY` (audited, no new session)
- **valid hold** → `resume_hold`: the same session goes back to `inside` and the same seat goes back to `occupied`
- **otherwise** → `select_seat`; confirming expires due holds on that table, then atomically creates the session and claims the seat (`SEAT_UNAVAILABLE` / `TABLE_FULL` if lost; the same scan can then pick again)

**Exit:** the session must be `inside`.
- `exit`: session → `completed` (`exitTime`, `exitGateId`) and the seat is released, **conditional on `seat.sessionId` = this session**, so a seat is never released twice.
- `hold`: session → `hold` with `exitTime = now` and `holdUntil = now + 15 min` (server time); seat → `reserved` with `reservedUntil = holdUntil`.

**Expiry:** `holdUntil` lives in MongoDB. The worker (`server/src/workers/holdExpiryWorker.js`) sweeps immediately on start-up (so holds that lapsed while the server was down are released) and then every `HOLD_SWEEP_INTERVAL_MS`. Due holds are also expired **lazily** before every scan, entry, exit, status read and map read, so a late worker never blocks a seat. Expiry sets the session to `completed` (`endReason: hold_expired`, `endedAt = holdUntil`) and releases the seat. A later entry is a new visit on a newly available seat.

**Duplicates and retries:**
- Scan tokens are single-use, bound to one terminal and its gate type, and expire after `SCAN_TOKEN_TTL_SECONDS`. A newer scan at the same terminal supersedes older pending ones.
- A token is claimed atomically (`pending → processing`). A retried request with a consumed token **replays the stored result** instead of acting again. Seat-choice errors put the token back to `pending`.
- Devices may send `requestId`; a retried scan with the same id replays the stored response.
- Every state transition is a conditional update on the current state (`status: 'inside'`, `status: 'hold' && holdUntil > now`, …), backed by the unique indexes above.

### Consistency: transactions and crash recovery

On a replica set or sharded cluster (`/api/ready` reports `transactions: true`), the session and seat writes of each operation run in a MongoDB transaction. On a standalone server the same code runs without a transaction. Each step is still conditional, failed steps are compensated inline, and a **reconciler** (run by the worker) repairs anything a crash leaves half-done:
- seats held by a closed or missing session are released
- open sessions without a seat are linked to their seat, or closed
- seat status is realigned with session status

It only touches records idle for 60 s, so it never races an in-flight request. The full test suite runs in both modes.

## REST API

All responses are `{ "success": true, "data": … }` or `{ "success": false, "error": { "code", "message", "details"? } }`. Paginated lists return `{ items, page, limit, total, totalPages }` (`?page=&limit=`, max 100). Error codes and their user-facing messages are listed in `shared/libraryStates.mjs` (`ERROR_MESSAGES`).

Auth: `Authorization: Bearer <token>`. Gate endpoints also accept `X-Terminal-Code` + `X-Terminal-Key` (device key).

| Method & path | Auth | Description |
| --- | --- | --- |
| `GET /` | — | Welcome message |
| `GET /api/health` | — | Process liveness |
| `GET /api/ready` | — | 200 when MongoDB answers a ping (503 otherwise); reports transaction support |
| `POST /api/auth/register/request-otp` | — | `{email}` → `{email, emailMasked, expiresAt, resendAvailableAt}`; emails a 6-digit code |
| `POST /api/auth/register/verify-otp` | — | `{email, otp}` → `{registrationToken, expiresAt}` |
| `POST /api/auth/register` | registration token | `{registrationToken, entryNumber, name, email, password, department, programme}` → `{student, token, expiresAt}` |
| `POST /api/auth/login` | — | `{identifier (email or entry number), password}` |
| `POST /api/auth/logout` | student/staff | Revokes the token |
| `GET /api/auth/me` | student | Current student |
| `POST /api/admin/login` | — | `{email, password}` → `{staff, token}` |
| `POST /api/admin/logout`, `GET /api/admin/me` | staff | |
| `GET /api/admin/logs` | staff | Filters: `action` (exact, or prefix with trailing `*`), `outcome`, `actorType`, `terminalCode`, `studentId`, `entryNumber`, `from`, `to` (ISO date/datetime) |
| `GET /api/admin/students` | staff | `q`, `isActive` |
| `PATCH /api/admin/students/:studentId` | admin | `{isActive?, name?, department?, programme?}` |
| `GET /api/admin/sessions` | staff | `status`, `studentId`, `entryNumber`, `from`, `to` |
| `GET /api/admin/terminals` | staff | |
| `POST /api/admin/terminals` | admin | `{terminalCode, gateType, name}` → key returned **once** |
| `PATCH /api/admin/terminals/:terminalId` | admin | `{name?, isActive?}` |
| `POST /api/admin/terminals/:terminalId/rotate-key` | admin | New key once; old key and tokens stop working |
| `GET /api/admin/cards`, `POST /api/admin/cards`, `PATCH /api/admin/cards/:cardId/revoke` | staff | Issue `{entryNumber, cardUid, replaceExisting?}` / revoke `{reason?}` |
| `POST /api/admin/tables`, `PATCH /api/admin/tables/:tableId` | admin | Create (seats generated) / update. Capacity can shrink only by removing free seats |
| `POST /api/gate/terminal/token` | terminal key | Short-lived terminal token for kiosks |
| `GET /api/gate/terminal/me` | terminal | |
| `POST /api/gate/scan` | terminal | `{cardUid, requestId?}` → `{accepted, nextAction, scanToken, expiresAt, student:{displayName, entryNumberMasked}, visit, …}`; rejections use 403/409 with the gate payload in `error.details` |
| `POST /api/gate/entry` | entry terminal | `{scanToken, tableId?, seatId?}` (only `scanToken` for a hold resume) |
| `POST /api/gate/exit` | exit terminal | `{scanToken, mode: "exit" \| "hold"}` |
| `GET /api/gate/status/:entryNumber` | the student themselves, or staff | `{state: outside \| inside \| hold, visit}` |
| `GET /api/library/map` | student/staff/terminal | Canvas, legend, tables with seats, occupancy, `serverTime` |
| `GET /api/library/occupancy` | student/staff/terminal | Counts and capacity |
| `GET /api/library/tables` | student/staff/terminal | Active tables with counts |
| `GET /api/library/tables/:tableId/seats` | student/staff/terminal | Seats of one table |
| `POST /api/library/seats/allocate` | staff | Staff-assisted admission `{entryNumber, terminalCode, tableId?, seatId?}` (e.g. lost card); same service and rules as gate entry |

Public scan/map responses never include who sits where, emails, full entry numbers or card data.

## Socket.IO events

Connect with `io(API_BASE_URL, { auth: { token } })` using a student, staff or terminal token. Invalid tokens are refused at the handshake, and sockets are disconnected when the token expires. Client events are rate-limited (20 per 10 s per socket) and acknowledged with `{ ok, error? }`.

| Direction | Event | Who | Payload |
| --- | --- | --- | --- |
| client → server | `map:subscribe` | any authenticated | — joins the live-map room |
| client → server | `gate:subscribe` | terminal (own gate only) | `{terminalCode?}` |
| client → server | `admin:subscribe` | staff | — |
| server → client | `gate:result` | the scanning terminal | Scan result (`stage: "scan"`, includes `scanToken`) or completion (`stage: "completed"`) |
| server → client | `map:updated` | map + admin rooms | `{seats: [seat…], serverTime}`, or `{reload: true}` after layout changes |
| server → client | `occupancy:updated` | map + admin rooms | Same shape as `GET /api/library/occupancy` |
| server → client | `session:updated` | that student's private room + admin | Session summary |
| server → client | `admin:log` | admin room | New audit-log entry |

Broadcasts happen only after the database write has committed, and payloads are re-read from MongoDB. After any reconnect clients re-fetch `GET /api/library/map`, so missed events can't leave a stale view.

## ESP32 integration

There is no existing hardware protocol in the repository. This is the protocol the backend implements:

1. Register the gate: `npm run create-terminal -- --code ENTRY-2 --type entry --name "North entrance"`. Store the printed key in the device's secure configuration (NVS/encrypted flash), never in any app frontend.
2. On each card tap, send:
   ```http
   POST /api/gate/scan HTTP/1.1
   Host: library.example.iitd.ac.in
   Content-Type: application/json
   X-Terminal-Code: ENTRY-2
   X-Terminal-Key: <terminal key>

   {"cardUid": "04A31B22", "requestId": "<unique per physical tap, 8–64 [A-Za-z0-9_-]>"}
   ```
   On a timeout, resend with the **same** `requestId`; the server replays its first answer.
3. Response: HTTP 200 `{"success": true, "data": {"accepted": true, "nextAction": "select_seat" | "resume_hold" | "choose_exit", …}}` → e.g. green LED. 403 (`UNKNOWN_CARD`, `CARD_REVOKED`, `STUDENT_INACTIVE`) or 409 (`DUPLICATE_ENTRY`, `NOT_INSIDE`, `ALREADY_ON_HOLD`, `LIBRARY_FULL`) → red LED; `error.code` says why. 401 means the terminal credentials are wrong or disabled.
4. The kiosk at the same gate receives the result instantly (`gate:result`) and the student completes the choice on screen.

Use **HTTPS** in deployment: the key travels in a header. Test curl:

```bash
curl -X POST http://localhost:5001/api/gate/scan \
  -H "X-Terminal-Code: ENTRY-1" -H "X-Terminal-Key: $KEY" \
  -H "Content-Type: application/json" -d '{"cardUid":"04A1B2C301","requestId":"test-000001"}'
```

Still to do on the hardware side: firmware (reader driver, Wi-Fi/TLS client, `requestId` generation, LED/buzzer feedback). Only the backend side has been built and tested.

## Testing

```bash
cd server
npm test                  # 72 tests against an in-memory MongoDB replica set (transactions)
npm run test:standalone   # the same tests against a standalone mongod (no transactions)
npm run lint              # syntax check of server sources
cd ../entrygate-app && npm run lint && npm run build
cd ../exitgate-app && npm run lint && npm run build
cd ../commonapp && npm run lint && npm run lint:shared && npm run build
```

The tests use `mongodb-memory-server` (a real `mongod`, downloaded on first run) and a controllable clock (`server/src/services/clock.js`), so 15-minute holds are tested instantly. Coverage:

- registration and login, duplicate identifiers, email policy
- email OTP: delivery, hashing, correct/incorrect/expired codes, 5-attempt limit (including concurrent guesses), 60 s cooldown and hourly cap, reuse, tokens bound to the email, single-use and expiring tokens, direct registration rejected, delivery failure, missing SMTP
- entry/double entry, invalid, inactive and revoked cards
- capacity, immediate exit, duplicate exit, hold, resume before expiry, worker and lazy expiry, new visit after expiry
- concurrent seat, table, student and exit races
- admin/terminal authorization, key rotation, no secret leakage
- socket emissions only after commits (including a simulated transaction failure), real Socket.IO auth and subscriptions
- restart recovery and reconciliation
