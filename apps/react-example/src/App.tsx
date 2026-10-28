import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Folkways, type Realtime } from '@folkwaysio/realtime';
import './App.css';

// The node URL from your segment's Connect tab in the Folkways dashboard.
const NODE_URL = import.meta.env.VITE_RTE_URL ?? '';
// Optional: your own backend's token endpoint. Without it, the app signs in
// through the example token server (apps/token-server), proxied at /api.
const AUTH_URL = import.meta.env.VITE_RTE_AUTH_URL;
const EXAMPLE_API = '/api';
const TOKEN_SERVER_DOWN = "Can't reach the token server. Start it as apps/token-server/README.md explains.";
// A topic rule has one class, so the room's messages (Durable) and its typing
// signals (Ephemeral) live on two topics.
const ROOM = 'chat/lobby';
const TYPING = 'typing/lobby';

type RoomEvents = { message: { text: string } };
type TypingEvents = { typing: { typing: boolean } };

function Chat({ client, leave, leaveLabel }: { client: Realtime; leave: () => void; leaveLabel: string }) {
  const room = client.topic<RoomEvents>(ROOM);
  const typingTopic = client.topic<TypingEvents>(TYPING);
  const messages = useSyncExternalStore(room.messages.subscribe, room.messages.getSnapshot);
  const typingValues = useSyncExternalStore(typingTopic.values().subscribe, typingTopic.values().getSnapshot);
  const { state, transport } = useSyncExternalStore(client.connection.subscribe, client.connection.getSnapshot);
  const identity = client.session?.identity;
  const typing = [...typingValues.values()].filter((m) => (m.data as { typing?: boolean })?.typing && m.publisher !== identity).map((m) => m.publisher);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const lastSignal = useRef(0);

  useEffect(() => {
    const sub = room.subscribe({ from: { last: 50 } });
    sub.on('error', (e) => setError(e.message));
    return () => void sub.unsubscribe();
  }, [room]);

  useEffect(() => {
    const sub = typingTopic.subscribe();
    return () => void sub.unsubscribe();
  }, [typingTopic]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void client.topic<TypingEvents>(TYPING).publish('typing', { typing: false }, { delivery: 'signal' });
    try {
      await client.topic<RoomEvents>(ROOM).publish('message', { text });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function onType(value: string) {
    setDraft(value);
    if (Date.now() - lastSignal.current > 2_000) {
      lastSignal.current = Date.now();
      void client.topic<TypingEvents>(TYPING).publish('typing', { typing: true }, { delivery: 'signal' });
    }
  }

  return (
    <div className="chat">
      <header>
        <strong>{ROOM}</strong> · {identity} · <span className={`state ${state}`}>{state}</span>
        {transport && <span className="transport"> via {transport}</span>}
        <button className="leave" onClick={leave}>
          {leaveLabel}
        </button>
      </header>
      <ul className="messages">
        {messages.map((m) => (
          <li key={m.id} className={`${m.publisher === identity ? 'mine' : ''} ${m.status}`}>
            <b>{m.publisher}</b> {m.data?.text ?? String(m.data)}
            {m.status === 'failed' && <button onClick={() => void m.retry?.()}>retry</button>}
          </li>
        ))}
      </ul>
      <div className="typing">{typing.length > 0 && `${typing.join(', ')} typing…`}</div>
      {error && <div className="error">{error}</div>}
      <form onSubmit={send}>
        <input value={draft} onChange={(e) => onType(e.target.value)} placeholder="Say something" autoFocus />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}

/** Calls the example token server. A 5xx is the dev server's proxy failing to reach it. */
async function exampleApi(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<{ identity?: string | null; error?: string }> {
  const res = await fetch(`${EXAMPLE_API}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status >= 500) throw new Error(TOKEN_SERVER_DOWN);
  const json = res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as { identity?: string | null; error?: string });
  if (!res.ok) throw new Error(json.error ?? `The token server answered HTTP ${res.status}`);
  return json;
}

function App() {
  const [client, setClient] = useState<Realtime>();
  const [error, setError] = useState<string>();
  // Who is signed in to the example token server: undefined while asking it, null when nobody.
  const [identity, setIdentity] = useState<string | null>();
  const [name, setName] = useState('');

  useEffect(() => () => void client?.close(), [client]);

  useEffect(() => {
    if (AUTH_URL) return;
    exampleApi('GET', '/session')
      .then((s) => setIdentity(s.identity ?? null))
      .catch((err: Error) => {
        setIdentity(null);
        setError(err.message);
      });
  }, []);

  async function connect(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    try {
      if (!AUTH_URL && !identity) {
        const session = await exampleApi('POST', '/session', { name: name.trim() });
        if (!session.identity) throw new Error(session.error ?? 'Sign-in failed');
        setIdentity(session.identity);
      }
      // The SDK POSTs to authUrl for a token now, and again before it expires.
      setClient(await Folkways.connect({ url: NODE_URL, authUrl: AUTH_URL ?? `${EXAMPLE_API}/realtime-token` }));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function leave() {
    setClient(undefined);
    if (AUTH_URL) return;
    try {
      await exampleApi('DELETE', '/session');
      setIdentity(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (client) return <Chat client={client} leave={() => void leave()} leaveLabel={AUTH_URL ? 'Disconnect' : 'Sign out'} />;
  if (!NODE_URL) {
    return (
      <div className="login">
        <h1>Folkways Realtime</h1>
        <p>
          Set <code>VITE_RTE_URL</code> in <code>.env.local</code> to the node URL from your segment&apos;s{' '}
          <strong>Connect</strong> tab in the Folkways dashboard, then restart the dev server.
        </p>
      </div>
    );
  }
  return (
    <form className="login" onSubmit={connect}>
      <h1>Folkways Realtime</h1>
      {AUTH_URL ? (
        <p>
          Gets a token from <code>{AUTH_URL}</code>.
        </p>
      ) : identity === undefined ? (
        <p>Checking whether you are signed in…</p>
      ) : identity ? (
        <p>
          Signed in as <strong>{identity}</strong>.{' '}
          <button type="button" className="link" onClick={() => void leave()}>
            Sign out
          </button>
        </p>
      ) : (
        <>
          <p>
            Sign in with any name. The example token server in <code>apps/token-server</code> signs a token for you
            with your segment&apos;s signing key.
          </p>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name, e.g. alice" autoFocus />
        </>
      )}
      <button type="submit" disabled={!AUTH_URL && (identity === undefined || (!identity && !name.trim()))}>
        Connect
      </button>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

export default App;
