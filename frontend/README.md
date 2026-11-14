# Frontend

Browser and smart-glasses side of Home memory:

- `web/` - the judge dashboard (`/`) and the phone/laptop capture page (`/capture`) (Vite, React, TypeScript)
- `miniapp/` - the Mentra Live glasses miniapp (`@mentra/miniapp`)
- `mock-server/` - a dependency-free mock of `docs/api-contract.md`, so both clients run without the real backend

## Run it

Two terminals, from the repo root. Tested with Node 22.

```sh
node frontend/mock-server/server.mjs
```

```sh
cd frontend/web
npm install
npm run dev
```

Then open http://localhost:5180

- Mock server: port 8787, change it with `PORT=9000`. It only listens on this machine unless you set `HOST=0.0.0.0`.
- Web app: port 5180, fixed. Pass `-- --host` to expose on your LAN.
- `npm run build` type-checks and builds to `web/dist`. Whatever serves `dist` has to send `index.html` for `/capture` too.
- For the glasses miniapp, see `frontend/miniapp/README.md`.

## The two web pages

- `/` - judge dashboard. Pick who you are acting as, type a note or a question, and watch the memories, rules and audit log update live.
- `/capture` - a phone or laptop standing in for a second wearer. Camera preview, a **Send** selector (`Text`, `Audio`, or `Both` — default `Text` to save battery; `Audio`/`Both` record a 16 kHz mono WAV clip only while talking, capped at 25 s), a Talk button, a text box, and an optional frame every 3 seconds.

## Point it at another backend

The web app picks the backend URL in this order:

1. `?api=` in the address, for example `http://localhost:5180/?api=https://something.trycloudflare.com`. Saved in `localStorage`.
2. The value saved in that browser
3. `VITE_API_BASE` from `web/.env.local`
4. `http://localhost:8787`

## Phones

Phone browsers only allow the camera and microphone on HTTPS pages. Put both the web app and backend behind HTTPS tunnels when opening `/capture` on a phone.

## What is mock-only

The mock keeps everything in memory and forgets it on restart.

- No AI and no speech-to-text. On `text + audio` turns it acts on `text` (`input_used: "text"`). On `audio`-only turns it returns `kind: "ignored"` with the clip's duration (`input_used: "audio"`).
- **Mock-only audio playback aid:** `GET /audio/<user_id>` serves the latest audio clip uploaded by `<user_id>` (wrapping raw `pcm_s16le` in a WAV header when `sample_rate` is known) so developers can listen to what the browser or glasses captured.
- `audio_url` is always `null`, so replies are spoken by the client's own voice.
- Only the space `home` exists, with three users: `u_resident`, `u_caregiver`, `u_visitor`.
