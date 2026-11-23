# Local setup and smoke test

Step-by-step guide to run **everything** on one machine (written for Windows; macOS/Linux notes inline) and check that it works end to end. For architecture, API and business rules see [README.md](README.md).

What you will have running at the end:

| # | Component | Folder | Address |
| --- | --- | --- | --- |
| 1 | MongoDB | — | `127.0.0.1:27017` |
| 2 | API server (Express + Socket.IO) | `server/` | http://localhost:5001 |
| 3 | Entry gate kiosk (Electron) | `entrygate-app/` | window (renderer dev server :5173) |
| 4 | Exit gate kiosk (Electron) | `exitgate-app/` | window (renderer dev server :5174) |
| 5 | Student + staff app (Electron) | `commonapp/` | window (renderer dev server :5175) |
| 5b | Same app as a website (optional) | `commonapp/` | http://localhost:5176 |

Use **one terminal per component** (2–5 keep running).

---

## 0. Prerequisites

| Tool | Version | Check |
| --- | --- | --- |
| Node.js | ≥ 20.19 (24 recommended) | `node -v` |
| npm | comes with Node | `npm -v` |
| Git for Windows (provides Git Bash) | any recent | `git --version` |
| MongoDB Server | ≥ 6 (local) **or** a free MongoDB Atlas cluster | `mongod --version` |
| mongosh (optional, for inspecting the DB) | any | `mongosh --version` |

### Windows only: make npm scripts run in Git Bash (one-time, important)

Several `server/` scripts use POSIX shell syntax (`'test/**/*.test.js'`, `find`, `VAR=value cmd`). Under npm's default Windows shell (`cmd.exe`) they misbehave **silently**: for example `npm test` reports `tests 0 / pass 0` instead of running the suite. Point npm at Git Bash:

```powershell
npm config set script-shell "C:\Program Files\Git\bin\bash.exe"
```

(Undo with `npm config delete script-shell`.) The commands below are given for **PowerShell**; Git Bash equivalents are noted where they differ.

---

## 1. MongoDB

Pick **one** option.

### Option A — Local single-node replica set (recommended: enables transactions)

1. Install MongoDB Community Server: `winget install MongoDB.Server` or the MSI from mongodb.com. The binary lives in `C:\Program Files\MongoDB\Server\<version>\bin\mongod.exe` — add that folder to `PATH`, or use the full path below.
2. If the installer created a Windows service that is already using port 27017, stop it (admin PowerShell): `Stop-Service MongoDB`.
3. Start a replica-set node with its own data folder and leave this terminal open:

   ```powershell
   New-Item -ItemType Directory -Force C:\data\iitdlib | Out-Null
   mongod --dbpath C:\data\iitdlib --replSet rs0 --port 27017 --bind_ip 127.0.0.1
   ```

4. In another terminal, initialise the replica set (once, ever):

   ```powershell
   mongosh --eval "rs.initiate()"
   ```

5. Your connection string: `mongodb://127.0.0.1:27017/iitd_library?replicaSet=rs0`

macOS: `brew tap mongodb/brew && brew install mongodb-community`, then the same `mongod … --replSet rs0` / `rs.initiate()` steps with `--dbpath ~/data/iitdlib`.

### Option B — Plain local MongoDB service (simplest, no transactions)

Install MongoDB Server with the "run as a service" option and keep it running. Connection string: `mongodb://127.0.0.1:27017/iitd_library`. Everything works; `/api/ready` will just report `transactions: false` (see "Consistency" in the README).

### Option C — MongoDB Atlas (cloud, free tier)

Create a free cluster, add a database user, allow your IP under *Network Access*, and copy the `mongodb+srv://…` string. Put `/iitd_library` before the `?` so the database has a name.

---

## 2. Server (`server/`)

```powershell
cd server
npm install
Copy-Item .env.example .env          # Git Bash / macOS: cp .env.example .env
```

Generate two secrets (run twice, one value each):

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Edit `server/.env` — the minimum to change:

```ini
MONGODB_URI=mongodb://127.0.0.1:27017/iitd_library?replicaSet=rs0   # from step 1
JWT_SECRET=<first generated value>
CARD_UID_PEPPER=<second generated value>
# Optional: fixed password for the seeded test students (else a random one is printed)
SEED_STUDENT_PASSWORD=TestPassword123
```

Leave `SMTP_*` as is for now — only **new student self-registration** needs email (see [§7](#7-optional-email-otp-for-student-registration)). The seeded test students can sign in without it.

Seed the database and create a staff admin:

```powershell
npm run seed -- --with-test-data
npm run create-admin -- --email librarian@iitd.ac.in --name "Head Librarian"
```

- `seed` creates 108 tables / 498 seats, 3 test students with cards, and the two gate terminals. **Copy the output now** — the terminal keys are printed only once:

  ```text
  Student 2021CS10001 <cs1210001@iitd.ac.in> card UID 04A1B2C301
  Student 2022EE10002 <ee1220002@iitd.ac.in> card UID 04A1B2C302
  Student 2023ME20003 <me2230003@iitd.ac.in> card UID 04A1B2C303
  Terminal ENTRY-1: GATE_TERMINAL_CODE=ENTRY-1 GATE_TERMINAL_KEY=…
  Terminal EXIT-1:  GATE_TERMINAL_CODE=EXIT-1  GATE_TERMINAL_KEY=…
  ```

  Lost a key? `npm run create-terminal -- --code ENTRY-1 --rotate` (same for `EXIT-1`) prints a new one.
- `create-admin` prompts for a password (min 12 characters, not echoed).

Start the API (auto-restarts on code changes):

```powershell
npm run dev
```

### ✅ Check the server

In another terminal:

```powershell
curl.exe http://localhost:5001/api/health
curl.exe http://localhost:5001/api/ready
```

Expected: both return `{"success":true,…}`; `/api/ready` shows `"transactions": true` with Option A/C, `false` with Option B. The server log should say `Server running at http://localhost:5001`. A warning about SMTP not being configured is expected at this point.

---

## 3. Point the apps at your local server

> **Important:** all three apps default to the **deployed** backend (`https://iitd-library-backend.onrender.com`). Without the files below they will talk to that server, not yours, and your seeded terminal keys will be rejected.

These files are dev-only and already gitignored, so the keys never get committed.

`entrygate-app/gate.config.json`

```json
{ "apiBaseUrl": "http://localhost:5001", "terminalCode": "ENTRY-1", "terminalKey": "<ENTRY-1 key from seed>" }
```

`exitgate-app/gate.config.json`

```json
{ "apiBaseUrl": "http://localhost:5001", "terminalCode": "EXIT-1", "terminalKey": "<EXIT-1 key from seed>" }
```

`commonapp/app.config.json`

```json
{ "apiBaseUrl": "http://localhost:5001" }
```

`commonapp/.env.local` (only for the web version, step 4d)

```ini
VITE_API_BASE_URL=http://localhost:5001
```

(Environment variables `API_BASE_URL`, `GATE_TERMINAL_CODE`, `GATE_TERMINAL_KEY` override these files if you prefer.)

---

## 4. Start the apps

Each in its own terminal. The first `npm install` in each app also downloads Electron (~100 MB).

```powershell
# 4a. Entry gate kiosk
cd entrygate-app; npm install; npm run dev

# 4b. Exit gate kiosk
cd exitgate-app; npm install; npm run dev

# 4c. Student + staff app (Electron)
cd commonapp; npm install; npm run dev

# 4d. (optional) the same student/staff app in a browser
cd commonapp; npm run dev:web        # open http://localhost:5176
```

Ports 5173–5176 are fixed (`strictPort`); if one is busy the app exits with an error instead of moving to another port — close whatever is using it.

To reach the web version from a phone on the same Wi‑Fi: open `http://<your-PC-LAN-IP>:5176`, set `VITE_API_BASE_URL=http://<your-PC-LAN-IP>:5001` in `commonapp/.env.local`, add `http://<your-PC-LAN-IP>:5176` to `CORS_ORIGINS` in `server/.env`, restart both, and allow Node through Windows Firewall.

---

## 5. End-to-end smoke test

Do these in order with everything running. Each step says what you should see.

### 5.1 Staff console (CommonApp)
1. CommonApp → **Staff / Admin** → sign in with the admin from step 2.
2. ✅ The live map shows 108 tables, all **green** (`0 / 8`, `0 / 2`).
3. ✅ *Students* lists the 3 test students; *RFID cards* lists 3 active cards; *Terminals* lists `ENTRY-1` and `EXIT-1`.

### 5.2 Student sign-in (CommonApp)
1. Open a second CommonApp window — or use the web version at http://localhost:5176 — choose **Student** and sign in with `2021CS10001` (or `cs1210001@iitd.ac.in`) and the seeded password.
2. ✅ The portal shows the profile and state **outside**.

### 5.3 Entry
1. Entry kiosk: idle antenna screen ("Tap your IIT Delhi library card").
2. Click the small **Manual scan** button (bottom-right; dev builds only) and enter `04A1B2C301`.
3. ✅ The table map with a 10-second countdown appears. Tap a green table (optionally a seat) → **Confirm**.
4. ✅ Green tick with table and seat for 3 s, then back to idle.
5. ✅ Without refreshing: that table's count goes up in the staff map and the student portal shows **inside** with the table/seat. The staff *Audit logs* show the entry.

### 5.4 Rejections
- Scan `04A1B2C301` at the entry kiosk again → ✅ "already inside" (`DUPLICATE_ENTRY`), shown for 2 s.
- Scan `FFFFFFFF` → ✅ unknown card (`UNKNOWN_CARD`).
- Scan `04A1B2C302` at the **exit** kiosk → ✅ not inside (`NOT_INSIDE`).

### 5.5 Exit with a hold, then resume
1. Exit kiosk → Manual scan `04A1B2C301` → **Hold — 15 minutes**.
2. ✅ Success screen with the hold end time; the seat shows as held/unavailable on the map; the student portal shows **hold** with a countdown.
3. Entry kiosk → Manual scan `04A1B2C301` → ✅ "Resume my seat" → confirm → same seat, state **inside** again.

### 5.6 Exit for good
1. Exit kiosk → Manual scan `04A1B2C301` → **Leave now**.
2. ✅ The seat turns free on every map; the student is **outside**; the visit appears under staff *Visits* as completed.

### 5.7 Community board
1. As the student in CommonApp, open the community board, create a post and add a comment.
2. ✅ It appears in the list; staff can see/moderate it from their own sign-in.

### 5.8 Simulating the ESP32 reader (optional)

The kiosks' Manual scan sends exactly what the hardware would. To send it yourself (Git Bash):

```bash
KEY='<ENTRY-1 key>'
curl -X POST http://localhost:5001/api/gate/scan \
  -H "X-Terminal-Code: ENTRY-1" -H "X-Terminal-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"cardUid":"04A1B2C302","requestId":"test-000001"}'
```

✅ JSON with `"accepted": true, "nextAction": "select_seat"`, and the entry kiosk immediately switches to the map for that student.

---

## 6. Automated tests, lint and builds

The server tests start their own in-memory MongoDB (downloaded on the first run, a few minutes), so they do **not** touch your dev database and don't need step 1.

```powershell
cd server
npm test                  # full suite against an in-memory replica set (~1–2 min); expect "fail 0"
npm run test:standalone   # same suite without transactions
npm run lint              # syntax check of server sources

cd ..\entrygate-app; npm run lint; npm run build
cd ..\exitgate-app;  npm run lint; npm run build
cd ..\commonapp;     npm run lint; npm run lint:shared; npm run build; npm run build:web
```

If `npm test` prints `tests 0`, npm is still using `cmd.exe` — see [§0](#windows-only-make-npm-scripts-run-in-git-bash-one-time-important).

Packaged installers: `npm run build:win` (or `build:mac` / `build:linux`) inside each app folder; output goes to that app's `dist/`. A packaged app reads its config from `%APPDATA%\<app-name>\gate-config.json` / `app-config.json`, not from the dev files in step 3.

---

## 7. (Optional) Email OTP for student registration

New students register with an emailed 6-digit code. To test it, fill in `SMTP_*` in `server/.env` and restart the server. With Gmail:

```ini
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=<your Gmail address>
SMTP_PASS=<16-character App Password>   # needs 2-step verification on the account
SMTP_FROM="IIT Delhi Central Library <your Gmail address>"
```

Then CommonApp → Student → Register with an `@iitd.ac.in` address you can read. Without SMTP, registration fails with `EMAIL_NOT_CONFIGURED` by design (no code is faked).

---

## 8. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Server exits on start mentioning `JWT_SECRET` / `CARD_UID_PEPPER` | Missing or shorter than 32 characters in `server/.env`. |
| `MongoServerSelectionError` / `ECONNREFUSED 127.0.0.1:27017` | `mongod` not running, or the URI is wrong. With Option A, did you run `rs.initiate()`? |
| `/api/ready` returns 503 | Server can't reach MongoDB (see above). |
| Kiosk shows a terminal/credentials error, or 401 | `gate.config.json` missing/wrong, the key was rotated, or the app is still pointing at the deployed backend (§3). Re-run `npm run create-terminal -- --code ENTRY-1 --rotate`. |
| Apps load but show no data / sign-in fails with a network error | Server not running, or `apiBaseUrl` is not `http://localhost:5001`. |
| CORS error in the browser console (web version) | Add the page's origin to `CORS_ORIGINS` in `server/.env` and restart the server. |
| `Port 517x is already in use` | Another dev server (or a previous run) is still open — close it. |
| `EADDRINUSE :5001` | An old server is still running; stop it, or change `PORT` and every `apiBaseUrl`. |
| Test student password unknown | Re-seeding skips students that already exist. Set `SEED_STUDENT_PASSWORD` in `.env` and follow [Reset everything](#reset-everything). |
| `npm test` prints `tests 0` / `npm run lint` errors about `find` | npm is using `cmd.exe` — set `script-shell` (§0). |
| "Manual scan" button missing | It only exists in `npm run dev`, not in built/packaged apps. |
| Map doesn't update live | Check the server log for Socket.IO errors; reloading the app re-fetches the map. |

### Reset everything

```powershell
mongosh iitd_library --eval "db.dropDatabase()"
cd server; npm run seed -- --with-test-data; npm run create-admin -- --email librarian@iitd.ac.in --name "Head Librarian"
```

Then put the new terminal keys into both `gate.config.json` files.
