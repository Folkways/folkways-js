import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Folkways, type Realtime } from '@folkways/realtime';
import './App.css';

// Dev node defaults (rte `make dev`). Get a token with `make -s token SUB=alice` in the rte repo.
const ENDPOINTS = {
  websocket: import.meta.env.VITE_RTE_WS ?? 'ws://127.0.0.1:8080/v1/ws',
  http: import.meta.env.VITE_RTE_HTTP ?? 'http://127.0.0.1:3000',
};
// Until the node carries several event types per topic (ADR-001, rte#11-#15),
// the room's messages and its typing signals live on two topics.
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
      setClient(await Folkways.connect({ endpoints: ENDPOINTS, token: token.trim() }));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (client) return <Chat client={client} />;
  return (
    <form className="login" onSubmit={connect}>
      <h1>Folkways Realtime</h1>
      <p>
        Paste a dev token (<code>make -s token SUB=alice</code> in the rte repo).
      </p>
      <textarea value={token} onChange={(e) => setToken(e.target.value)} rows={4} />
      <button type="submit" disabled={!token.trim()}>
        Connect
      </button>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

export default App;
