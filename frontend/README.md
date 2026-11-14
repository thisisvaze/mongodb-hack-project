# Frontend

Browser side of Home memory. Three parts:

- `web/` - the dashboard and the capture page (Vite, React, TypeScript)
- `mock-server/` - a mock of `docs/api-contract.md`, so the web app runs without the real backend
- `miniapp/` - the glasses app. Someone else is building it, it is not covered here

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
- Web app: port 5180, fixed. If the port is taken the dev server stops instead of picking another one.
- `npm run build` type-checks and builds to `web/dist`. Whatever serves `dist` has to send `index.html` for `/capture` too.

## The two pages

- `/` - judge dashboard. Pick who you are acting as, type a note or a question, and watch the memories, rules and audit log update live.
- `/capture` - a phone or laptop standing in for a second wearer. Camera preview, a Talk button, a text box, and an optional frame every 3 seconds.

## Point it at another backend

The app picks the backend URL in this order:

1. `?api=` in the address, for example `http://localhost:5180/?api=https://something.trycloudflare.com`. It gets saved in the browser, so you only need it once.
2. The value saved in that browser
3. `VITE_API_BASE` from `web/.env.local`, read when the dev server starts or the app is built
4. `http://localhost:8787`

Both pages show the current URL with a Change button, so you can switch when the tunnel URL changes. No rebuild needed. `?api=` with nothing after it clears the saved value.

## Phones

Phone browsers only allow the camera and microphone on HTTPS pages. So for `/capture` on a phone:

- Put the web app behind an HTTPS tunnel. The dev server accepts `*.trycloudflare.com` and ngrok hostnames. For any other tunnel start it with `DEV_ALLOWED_HOSTS=your.host npm run dev`.
- The backend has to be HTTPS too, a page on HTTPS can't call an `http://` backend. Tunnel it as well and open `/capture?api=<backend tunnel URL>`.
- If the mock is behind a tunnel and image links come out wrong, start it with `PUBLIC_BASE=https://<mock tunnel URL>`.

The Talk button uses the browser's speech recognition. Where the browser doesn't have it, the button is off and the text box still works.

## What is mock-only

The mock keeps everything in memory and forgets it on restart. It is there to build against, not to demo.

- No AI. It decides note, question or "forget ..." from keywords, and answers by matching words.
- `audio_url` is always `null`, so replies are spoken by the browser's own voice.
- Only the space `home` exists, with three users: `u_resident`, `u_caregiver`, `u_visitor`.
- Camera frames are stored and shown but never looked at.
- An `image_url` from the glasses is passed through as it is, not downloaded.
- Expiry is checked every 2 seconds. To see a memory expire quickly, save rules with a short `keep_for` such as `"10s"`.

The Visible / Hidden label on each memory card is worked out in the browser (`web/src/visibility.ts`) so judges can see the rule. The backend is what enforces it.

## Where things are

- `web/src/api.ts` - every backend call and the backend URL logic
- `web/src/types.ts` - the contract's object shapes
- `web/src/pages/` - the two pages
- `mock-server/server.mjs` - the whole mock, no dependencies
