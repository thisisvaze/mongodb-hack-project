import {useEffect, useState, type FormEvent} from "react"
import {MiniappHeader, useSafeArea} from "@mentra/miniapp/ui"
import type {User} from "../shared/api"
import {isConfigured, type Phase, type Status} from "../shared/channels"

const PHASE_LABEL: Record<Phase, string> = {
  idle: "Ready. Press the glasses button to talk.",
  listening: "Listening…",
  sending: "Sending…",
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
      <MiniappHeader title="Home Memory" />
      <main className="content">
        {status === null ? (
          <p className="muted">Connecting…</p>
        ) : (
          <>
            <StatusCard status={status} />
            <TypedTurn disabled={!isConfigured(status.settings)} />
            <Setup status={status} />
            <Frames status={status} />
          </>
        )}
      </main>
    </div>
  )
}

function StatusCard({status}: {status: Status}) {
  const {settings, reply, photo} = status
  const configured = isConfigured(settings)

  return (
    <section aria-live="polite">
      <h2>Status</h2>
      {configured ? (
        <p className="state">{PHASE_LABEL[status.phase]}</p>
      ) : (
        <p className="state warn">Not configured. Set the API base URL and the user below.</p>
      )}
      <dl>
        <dt>User</dt>
        <dd>{settings.user ? `${settings.user.name} (${settings.user.role})` : "not chosen"}</dd>
        <dt>Space</dt>
        <dd>{settings.spaceId}</dd>
        <dt>Camera</dt>
        <dd>{status.hasCamera === null ? "no glasses connected" : status.hasCamera ? "yes" : "none on these glasses"}</dd>
        <dt>Heard</dt>
        <dd>{status.heard ?? "nothing yet"}</dd>
        <dt>Reply</dt>
        <dd>{reply ? `${reply.kind}: ${reply.text}` : "nothing yet"}</dd>
      </dl>
      {status.error && <p className="warn">Turn failed: {status.error}</p>}
      {status.photoError && <p className="warn">Photo failed: {status.photoError}</p>}
      {photo && (
        <figure>
          <img src={photo.url} alt="Last photo from the glasses" />
          <figcaption>Last photo, taken in {(photo.tookMs / 1000).toFixed(1)} s</figcaption>
        </figure>
      )}
    </section>
  )
}

function TypedTurn({disabled}: {disabled: boolean}) {
  const [text, setText] = useState("")
  const [note, setNote] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    try {
      const result = await mentra.request("sendText", {text}, {timeout: 10_000})
      setNote(result.accepted ? null : (result.reason ?? "Not sent."))
      if (result.accepted) setText("")
    } catch (err) {
      setNote(errorText(err))
    }
  }

  return (
    <section>
      <h2>Type a turn</h2>
      <form onSubmit={submit} className="row">
        <input
          aria-label="Text to send as a turn"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Where are my keys?"
        />
        <button type="submit" disabled={disabled || text.trim() === ""}>
          Send
        </button>
      </form>
      <p className="muted">Runs the same flow as the glasses button. The reply is spoken.</p>
      {note && <p className="warn">{note}</p>}
    </section>
  )
}

function Setup({status}: {status: Status}) {
  const saved = status.settings
  const [apiBase, setApiBase] = useState(saved.apiBase)
  const [spaceId, setSpaceId] = useState(saved.spaceId)
  const [userId, setUserId] = useState(saved.user?.id ?? "")
  const [users, setUsers] = useState<User[]>(saved.user ? [saved.user] : [])
  const [result, setResult] = useState<{ok: boolean; text: string} | null>(null)
  const [busy, setBusy] = useState(false)

  const test = async () => {
    setBusy(true)
    setResult(null)
    try {
      const state = await mentra.request("testConnection", {apiBase, spaceId}, {timeout: 15_000})
      setUsers(state.users)
      setUserId((current) => (state.users.some((user) => user.id === current) ? current : ""))
      setResult({ok: true, text: `Connected: ${state.users.length} users, ${state.memories} memories.`})
    } catch (err) {
      setResult({ok: false, text: `Failed: ${errorText(err)}`})
    } finally {
      setBusy(false)
    }
  }

  // Fill the user list when the UI opens with a saved server.
  useEffect(() => {
    if (saved.apiBase) void test()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = async () => {
    setBusy(true)
    try {
      const user = users.find((candidate) => candidate.id === userId) ?? null
      const next = await mentra.request("saveSettings", {apiBase, spaceId, user}, {timeout: 10_000})
      setApiBase(next.settings.apiBase)
      setSpaceId(next.settings.spaceId)
      setResult({ok: true, text: "Saved."})
    } catch (err) {
      setResult({ok: false, text: `Not saved: ${errorText(err)}`})
    } finally {
      setBusy(false)
    }
  }

  const unsaved = apiBase !== saved.apiBase || spaceId !== saved.spaceId || userId !== (saved.user?.id ?? "")

  return (
    <section>
      <h2>Setup</h2>
      <label>
        API base URL
        <input
          value={apiBase}
          onChange={(event) => setApiBase(event.target.value)}
          placeholder="https://example.trycloudflare.com"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
      </label>
      <label>
        Space id
        <input
          value={spaceId}
          onChange={(event) => setSpaceId(event.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
      </label>
      <button type="button" className="secondary" onClick={test} disabled={busy || apiBase.trim() === ""}>
        Test connection
      </button>
      <label>
        This wearer is
        <select value={userId} onChange={(event) => setUserId(event.target.value)}>
          <option value="">{users.length ? "Choose a user" : "Test the connection to load users"}</option>
          {users.map((user) => (
            <option key={user.id} value={user.id}>
              {user.name} ({user.role})
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={save} disabled={busy || !unsaved}>
        Save
      </button>
      {unsaved && <p className="muted">Unsaved changes.</p>}
      {result && <p className={result.ok ? "ok" : "warn"}>{result.text}</p>}
    </section>
  )
}

function Frames({status}: {status: Status}) {
  const {on, sent, error} = status.frames

  return (
    <section>
      <h2>Camera frames</h2>
      <label className="check">
        <input type="checkbox" checked={on} onChange={(event) => mentra.send("setFrames", {on: event.target.checked})} />
        Send a photo to the server every 5 seconds
      </label>
      <p className="muted">
        Off whenever the miniapp restarts. Frames sent: {sent}.
      </p>
      {on && error && <p className="warn">Last frame failed: {error}</p>}
    </section>
  )
}
