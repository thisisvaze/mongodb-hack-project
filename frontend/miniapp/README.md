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

## Set the API base URL and Send mode

There is no default server. Until one is saved, a button press says "Not set up yet. Open Home Memory on the phone."

1. Open the Home Memory tile in the Mentra App.
2. Under Setup, type the API base URL, for example `https://example.trycloudflare.com`. A missing `https://` is added for you.
3. Leave the space id as `home` unless the backend uses another one.
4. Tap Test connection. It calls `GET /api/state` and shows the number of users and memories, or the error.
5. Pick who is wearing the glasses, pick **Send with each spoken turn** (`Text`, `Audio` or `Both`), and tap Save.

### Battery & Send mode (`Text`, `Audio`, `Both`)

To save glasses battery, **no microphone or transcription subscription stays open while idle**. Subscriptions are opened only when you press the glasses button and torn down immediately when the utterance ends:

- **Text (default):** Opens `session.transcription.on(...)` only during the listening window; `session.mic` is never touched.
- **Audio:** Opens `session.mic.onAudioChunk(...)` and `session.mic.onVoiceActivity(...)` only during the listening window (ends ~1.25 s after voice activity goes silent, capped at 25 s). `session.transcription` is never touched.
- **Both:** Opens transcription + raw audio together during the window so the backend receives both `text` and `audio` on `POST /api/turn` and decides which to use.

Typed turns from the phone UI always send text only.

## The button

A short or long press of the glasses button starts a turn:

1. Subscriptions for the selected Send mode open first, then a beep says it is listening. A photo is taken in parallel.
2. Speak. When the utterance ends, the mic subscriptions close immediately and a second, lower beep confirms capture.
3. The reply is spoken.

- Nothing heard for 8 seconds: "I didn't hear anything."
- No answer from the server within 15 seconds: "Sorry, that took too long."
- Pressing while a reply plays stops it and starts a new turn.
- Presses while listening or sending are ignored.
- The photo never holds things up (capped at 2.5 s after speech finishes).

## Test these on the real glasses first

Run `bun dev`, keep the terminal visible, open the Home Memory tile on the phone.

1. Button events arrive (`button <id> short` or `long` in terminal) without taking a local gallery photo.
2. How fast the listening beep plays after pressing the button now that mic subscriptions open per turn.
3. Transcription arrives in `Text` mode ("Heard" fills in on the phone).
4. In `Audio` or `Both` mode, verify `onAudioChunk` chunks arrive, check what `format` (`pcm_s16le` vs `lc3`) and `sampleRate` the Status card reports, and play back `GET /audio/<user_id>` on the mock server.
5. `takePhoto` returns and how long it takes.
6. `speaker.play` (both the `data:` URL beeps and an HTTPS MP3 `audio_url`) and `speaker.speak` route to the glasses speakers.

`icon.png` is still the scaffolder's placeholder.
