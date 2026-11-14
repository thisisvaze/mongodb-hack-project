import {useEffect, useState} from "react"
import {MiniappHeader, useSafeArea} from "@mentra/miniapp/ui"
import type {SendMode, User} from "../shared/api"
import {isConfigured, type FrameMode, type Phase, type Settings, type Status} from "../shared/channels"

const SEND_MODES: Array<{id: SendMode; label: string}> = [
  {id: "text", label: "Text"},
  {id: "audio", label: "Audio"},
  {id: "both", label: "Both"},
]

const FRAME_OPTIONS: Array<{mode: FrameMode; label: string}> = [
  {mode: null, label: "Off"},
  {mode: 2_000, label: "2s"},
  {mode: 5_000, label: "5s"},
  {mode: "video", label: "Video"},
]

const PHASE_TEXT: Record<Phase, string> = {
  idle: "Listening, just speak",
  listening: "Listening…",
  sending: "Thinking…",
  speaking: "Speaking…",
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function App() {
  const {insets} = useSafeArea()
  const [status, setStatus] = useState<Status | null>(null)

  useEffect(() => {
    const off = mentra.on("status", setStatus)
    mentra.request("getStatus", null, {timeout: 10_000}).then(setStatus, () => {})
    return off
  }, [])

  return (
    <div
      className="app"
      style={{
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}>
      <MiniappHeader title="SafeSpace" />
      <main className="content">
        {status === null ? (
          <p className="muted">Connecting…</p>
        ) : (
          <>
            <LiveCard status={status} />
            <Controls status={status} onSaved={setStatus} />
          </>
        )}
      </main>
    </div>
  )
}

function LiveCard({status}: {status: Status}) {
  const configured = isConfigured(status.settings)
  const [snapping, setSnapping] = useState(false)

  const snap = async () => {
    setSnapping(true)
    try {
      await mentra.request("takePhotoNow", null, {timeout: 50_000})
    } catch {
      // Error surfaces on status.photoError.
    } finally {
      setSnapping(false)
    }
  }

  return (
    <section className="card" aria-live="polite">
      <div className="status-top">
        <span className={`dot ${configured ? status.phase : "off"}`} aria-hidden="true" />
        <p className="phase">{configured ? PHASE_TEXT[status.phase] : "Connect server & choose wearer"}</p>
        <button type="button" className="ghost" onClick={snap} disabled={snapping}>
          {snapping ? "Capturing…" : "Test camera"}
        </button>
      </div>

      {status.heard && <p className="said">“{status.heard}”</p>}

      {status.reply && (
        <p className={`reply kind-${status.reply.kind}`}>
          <span className="badge">{status.reply.kind}</span>
          <span>{status.reply.text}</span>
        </p>
      )}

      {status.error && <p className="err">{status.error}</p>}
      {status.photoError && <p className="err">{status.photoError}</p>}

      {status.photo && (
        <figure className="shot">
          <img src={status.photo.url} alt="Latest glasses capture" />
          <figcaption>{(status.photo.tookMs / 1000).toFixed(1)}s</figcaption>
        </figure>
      )}
    </section>
  )
}

function Controls({status, onSaved}: {status: Status; onSaved: (next: Status) => void}) {
  const saved = status.settings
  const [apiBase, setApiBase] = useState(saved.apiBase)
  const [users, setUsers] = useState<User[]>(saved.user ? [saved.user] : [])
  const [connNote, setConnNote] = useState<{ok: boolean; text: string} | null>(null)
  const [loading, setLoading] = useState(false)

  const persist = async (patch: Partial<Settings>, nextUsers?: User[]) => {
    const merged: Settings = {...saved, apiBase, ...patch}
    try {
      const updated = await mentra.request("saveSettings", merged, {timeout: 10_000})
      onSaved(updated)
      setApiBase(updated.settings.apiBase)
      if (nextUsers) setUsers(nextUsers)
    } catch (err) {
      setConnNote({ok: false, text: errorText(err)})
    }
  }

  const connect = async (targetBase: string) => {
    if (!targetBase.trim()) return
    setLoading(true)
    setConnNote(null)
    try {
      const res = await mentra.request("testConnection", {apiBase: targetBase}, {timeout: 15_000})
      setUsers(res.users)
      const keepUser = res.users.find((u) => u.id === saved.user?.id) ?? res.users[0] ?? null
      await persist({apiBase: targetBase, user: keepUser}, res.users)
      setConnNote({ok: true, text: "Connected"})
    } catch (err) {
      setConnNote({ok: false, text: errorText(err)})
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (saved.apiBase) void connect(saved.apiBase)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <section className="card">
      <div className="field">
        <label htmlFor="server-url">Server</label>
        <div className="row">
          <input
            id="server-url"
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
            placeholder="http://192.168.6.195:8080"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => void connect(apiBase)}
            disabled={loading || apiBase.trim() === ""}>
            {loading ? "…" : "Connect"}
          </button>
        </div>
        {connNote && <p className={connNote.ok ? "ok" : "err"}>{connNote.text}</p>}
      </div>

      {users.length > 0 && (
        <div className="field">
          <span className="label">Wearer</span>
          <div className="pills" role="radiogroup" aria-label="Wearer">
            {users.map((u) => {
              const active = saved.user?.id === u.id
              return (
                <button
                  key={u.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={active ? "pill active" : "pill"}
                  onClick={() => void persist({user: u})}>
                  <span className="pill-name">{u.name}</span>
                  <span className="pill-role">{u.role}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className="field">
        <span className="label">Mic payload</span>
        <div className="seg" role="radiogroup" aria-label="Mic payload">
          {SEND_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={saved.sendMode === m.id}
              className={saved.sendMode === m.id ? "active" : ""}
              onClick={() => void persist({sendMode: m.id})}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="label">Camera frames</span>
        <div className="seg" role="radiogroup" aria-label="Camera frames">
          {FRAME_OPTIONS.map((f) => (
            <button
              key={f.label}
              type="button"
              role="radio"
              aria-checked={status.frames.mode === f.mode}
              className={status.frames.mode === f.mode ? "active" : ""}
              onClick={() => mentra.send("setFrames", {mode: f.mode})}>
              {f.label}
            </button>
          ))}
        </div>
        <p className="muted">
          {status.frames.mode === "video" ? "Streaming video to the Mac receiver." : `Photos sent: ${status.frames.sent}.`} Turns
          off when the miniapp restarts.
        </p>
        {status.frames.error && <p className="err">{status.frames.error}</p>}
      </div>
    </section>
  )
}
