# commonapp

IITD Library — student and staff/admin application (Electron + React).

- **Student:** registration (IIT Delhi email policy enforced by the server), sign-in, current visit, live library map.
- **Staff / Admin:** sign-in, live map, audit logs, visits, students, RFID cards, gate terminals, tables.

```bash
npm install
npm run dev        # renderer dev server on http://localhost:5175
npm run lint
npm run build      # build:mac / build:win / build:linux to package
```

Configuration is read at runtime by the main process: `API_BASE_URL` (default
`http://localhost:5001`), or `<userData>/app-config.json` `{ "apiBaseUrl": "…" }`,
or in development `./app.config.json` (gitignored). This app holds no gate
terminal keys. See [../README.md](../README.md) for the whole system.
