import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Folkways, type Message, type RealtimeClient } from '@folkways/realtime';
import './App.css';

// Dev node defaults (rte `make dev`). Get a token with `make -s token SUB=alice` in the rte repo.
const ENDPOINTS = {
  websocket: import.meta.env.VITE_RTE_WS ?? 'ws://127.0.0.1:8080/v1/ws',
  http: import.meta.env.VITE_RTE_HTTP ?? 'http://127.0.0.1:3000',
};
const ROOM = 'chat/lobby';
const TYPING = 'typing/lobby';

interface ChatMessage {
  text: string;
}

function Chat({ client }: { client: RealtimeClient }) {
  const [messages, setMessages] = useState<Message<ChatMessage>[]>([]);
  const [typing, setTyping] = useState<string[]>([]);
  const [state, setState] = useState(client.state);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const lastSignal = useRef(0);

  useEffect(() => client.on('state', setState), [client]);

  useEffect(() => {
    const sub = client.topic(ROOM).subscribe<ChatMessage>((m) => setMessages((prev) => [...prev, m]), { from: { last: 50 } });
    sub.on('error', (e) => setError(e.message));
    return () => void sub.unsubscribe();
  }, [client]);

  useEffect(() => {
    const sub = client.topic(TYPING).subscribe<{ typing: boolean }>();
    const refresh = () =>
      setTyping(
        [...sub.values.values()].filter((m) => m.data?.typing && m.publisher !== client.identity).map((m) => m.publisher),
      );
    const off = sub.on('message', refresh);
    const timer = setInterval(refresh, 1_000);
    return () => {
      off();
      clearInterval(timer);
      void sub.unsubscribe();
    };
  }, [client]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    client.topic(TYPING).signal({ typing: false });
    try {
      await client.topic(ROOM).publish({ text });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function onType(value: string) {
    setDraft(value);
    if (Date.now() - lastSignal.current > 2_000) {
      lastSignal.current = Date.now();
      client.topic(TYPING).signal({ typing: true });
    }
  }

  return (
    <div className="chat">
      <header>
        <strong>{ROOM}</strong> · {client.identity} · <span className={`state ${state}`}>{state}</span>
        {client.transport && <span className="transport"> via {client.transport}</span>}
      </header>
      <ul className="messages">
        {messages.map((m) => (
          <li key={m.id} className={m.publisher === client.identity ? 'mine' : ''}>
            <b>{m.publisher}</b> {m.data?.text ?? String(m.data)}
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
  const [client, setClient] = useState<RealtimeClient>();
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
