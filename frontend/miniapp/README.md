# Home Memory - glasses miniapp

The Mentra miniapp for Mentra Live glasses. The wearer presses the glasses button, speaks a note or a question, and hears the backend's reply. It follows `docs/api-contract.md` and calls `GET /api/state`, `POST /api/turn` and `POST /api/frames`.

Nothing here has run on a phone or on glasses yet. See "Test these on the real glasses first" below.

## Run it

You need [Bun](https://bun.sh) and the Mentra App on a phone, signed in, with the glasses connected.

```bash
cd frontend/miniapp
bun install
bun dev
```

`bun dev` builds both layers, serves them on your LAN (port 3000, or the next free one) and prints a QR code.

On the phone: Mentra App → Settings → Miniapp Developer Settings → Scan Miniapp QR Code. Scan once. After that every saved change rebuilds and reloads on the phone. Keep `bun dev` running, the phone loads the miniapp from it.

The phone and the laptop must be on the same Wi-Fi. On Android you can skip that: plug the phone in and run

```bash
bun dev --usb
```

Logs from the miniapp (`console.log` in the background layer) show up in the `bun dev` terminal.

Other commands:

```bash
bun run typecheck   # TypeScript
bun run build       # both bundles into dist/, fails on APIs the background runtime does not have
bun run release     # install a fixed copy that runs without the laptop
```

## Set the API base URL

There is no default server. Until one is saved, a button press says "Not set up yet. Open Home Memory on the phone."

1. Open the Home Memory tile in the Mentra App.
2. Under Setup, type the API base URL, for example `https://example.trycloudflare.com`. A missing `https://` is added for you.
3. Leave the space id as `home` unless the backend uses another one.
4. Tap Test connection. It calls `GET /api/state` and shows the number of users and memories, or the error.
5. Pick who is wearing the glasses and tap Save.

The settings are kept on the phone with `session.storage`, so they survive restarts.

The phone has to reach the server, so `localhost` will not work. Use an HTTPS tunnel, as the contract says. For the mock server that means a tunnel in front of port 8787, or running it with `HOST=0.0.0.0` and using `http://<laptop-ip>:8787` (not tried on a phone, and iOS may refuse plain `http`).

## The button

A short press of the glasses button starts a turn. A long press does the same, so a slow press still works.

1. A beep says it is listening. A photo is taken at the same moment.
2. Speak. When the sentence is finished a second, lower beep confirms it was heard.
3. The reply is spoken.

- Nothing heard for 8 seconds: "I didn't hear anything."
- No answer from the server within 15 seconds: "Sorry, that took too long."
- Pressing while a reply plays stops it and starts a new turn.
- Presses while it is listening or sending are ignored.
- The photo never holds things up. If it is not ready 2.5 seconds after you finish speaking, or it fails, the turn goes without it.

Going by the Mentra App source, the button stops taking its usual gallery photo while a miniapp is listening for presses. That is test 1 below. The microphone also stays on the whole time the miniapp runs: transcription is subscribed once at startup so no words are lost waiting for it to start. To transcribe on the phone instead of the cloud when possible, pass `{processing: "preferLocal"}` to `session.transcription.on` in `src/background/index.ts`.

## The phone screen

For a sighted helper. The wearer never needs it after setup.

- Status: configured or not, user, whether a turn is in progress, last heard text, last reply and its kind, last photo and how long it took.
- Type a turn: sends typed text through the same flow, reply spoken, so you can test without talking.
- Setup: as above.
- Camera frames: a toggle, off by default and off again after every restart. While on, it takes a photo every 5 seconds and posts it to `POST /api/frames`. A tick is skipped while a turn or another photo is in progress.

## Test these on the real glasses first

Run `bun dev`, keep the terminal visible, open the Home Memory tile on the phone.

1. Button events arrive. Each press prints `button <id> short` or `long` in the terminal. Check the glasses do not also take their own photo.
2. Transcription arrives. Press, wait for the beep, speak. "Heard" on the phone should fill in while you talk. If it stays empty, check the microphone permission for the Mentra App.
3. `takePhoto` returns, and how long it takes. The Status section shows the photo and "taken in N s", or "Photo failed" with the error code. If it usually takes much longer than your sentence plus 2.5 seconds, turns will go out without a photo.
4. `speaker.play` plays a URL. Two cases:
   - The beeps are `data:` URLs. If the phone will not play them the terminal prints `tone failed, using speech for the cue` and you hear "Listening." instead.
   - A reply with `audio_url` (an MP3 over HTTPS). The mock server always sends `audio_url: null`, so this needs the real backend. If it fails the terminal prints `reply audio failed, speaking the text`.
5. `speaker.speak` comes out of the glasses and not the phone speaker.
6. Press during a reply. It should stop and beep, and the cut-off reply should not show up under "Heard".

## Where things are

```
miniapp.json                 manifest: permissions (microphone, camera), hardware
src/shared/api.ts            contract types and the three API calls
src/shared/channels.ts       messages between the two layers, settings and status types
src/background/index.ts      wiring: settings, button, transcription, phone UI requests
src/background/turn.ts       the turn state machine
src/background/camera.ts     one-at-a-time photo capture and the frame loop
src/background/tones.ts      the two beeps
src/ui/                      the phone screen (React)
```

`icon.png` is still the scaffolder's placeholder.
