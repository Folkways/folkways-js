import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Folkways, type Realtime } from '@folkwaysio/realtime';
import './App.css';

// The node URL from your segment's Connect tab in the Folkways dashboard.
const NODE_URL = import.meta.env.VITE_RTE_URL ?? '';
// Optional: your backend's token endpoint. Without it, paste a token your backend issued.
const AUTH_URL = import.meta.env.VITE_RTE_AUTH_URL;
const TOKEN_DOCS = 'https://docs.folkways.io/docs/js-sdk/server-tokens';
// A topic rule has one class, so the room's messages (Durable) and its typing
// signals (Ephemeral) live on two topics.
const ROOM = 'chat/lobby';
const TYPING = 'typing/lobby';

type RoomEvents = { message: { text: string } };
type TypingEvents = { typing: { typing: boolean } };

function Chat({ client }: { client: Realtime }) {
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

function App() {
  const [token, setToken] = useState(import.meta.env.VITE_RTE_TOKEN ?? '');
  const [client, setClient] = useState<Realtime>();
  const [error, setError] = useState<string>();

  useEffect(() => () => void client?.close(), [client]);

  async function connect(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    try {
      const auth = AUTH_URL ? { authUrl: AUTH_URL } : { token: token.trim() };
      setClient(await Folkways.connect({ url: NODE_URL, ...auth }));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (client) return <Chat client={client} />;
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
      ) : (
        <>
          <p>
            Paste a token issued by your backend (<a href={TOKEN_DOCS}>how to issue tokens</a>).
          </p>
          <textarea value={token} onChange={(e) => setToken(e.target.value)} rows={4} />
        </>
      )}
      <button type="submit" disabled={!AUTH_URL && !token.trim()}>
        Connect
      </button>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

export default App;
