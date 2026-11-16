import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from 'react';
import type { Message, Realtime } from '@folkwaysio/realtime';
import { nameOf, type SignIn } from './api';
import { Avatar, Eyebrow, Wordmark } from './ui';

// A topic rule has one class, so the room's messages (Durable) and its
// signals (Ephemeral: typing, and who is here) live on two topics.
const ROOM = 'chat/lobby';
const SIGNALS = 'typing/lobby';
// When the `chat/>` rule has presence turned on, the node keeps one entry per
// connection in the room here, keyed `identity#session`.
const PRESENCE = `$presence/${ROOM}`;
// Otherwise each connection says it is here with a signal this often. Signals
// live 5 s, so someone who leaves drops off the list within a few seconds.
const HERE_EVERY_MS = 2_000;
const HISTORY = 50;
const GROUP_MS = 5 * 60_000;

type RoomEvents = { message: { text: string } };
type SignalEvents = { typing: { typing: boolean }; here: { connections: number } };
type PresenceEntry = { identity?: string; session?: string; since?: number };

interface Person {
  identity: string;
  connections: number;
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * One person per identity, however many connections they have: from the
 * node's presence entries (one per connection) and from `here` signals (one
 * per identity, carrying its connection count).
 */
function people(presence: ReadonlyMap<string, Message>, here: ReadonlyMap<string, Message>): Person[] {
  const byIdentity = new Map<string, Person>();
  const add = (identity: string, connections: number) => {
    const p = byIdentity.get(identity) ?? { identity, connections: 0 };
    p.connections = Math.max(p.connections, connections);
    byIdentity.set(identity, p);
  };
  const counts = new Map<string, number>();
  for (const m of presence.values()) {
    if (m.deleted) continue;
    const entry = (m.data ?? {}) as PresenceEntry;
    const identity = entry.identity ?? m.publisher;
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
    add(identity, counts.get(identity)!);
  }
  for (const m of here.values()) {
    const n = (m.data as { connections?: unknown } | undefined)?.connections;
    add(m.publisher, typeof n === 'number' && n > 0 ? n : 1);
  }
  return [...byIdentity.values()];
}

export function Chat({ client, me, onSignOut }: { client: Realtime; me: SignIn; onSignOut: () => void }) {
  const room = client.topic<RoomEvents>(ROOM);
  const signals = client.topic<SignalEvents>(SIGNALS);
  const presenceTopic = client.topic(PRESENCE);
  // Every live connection of this identity, anywhere in the segment. Readable by its owner without any right.
  const onlineTopic = client.topic(`$online/${me.identity}`);

  const messages = useSyncExternalStore(room.messages.subscribe, room.messages.getSnapshot);
  const typingValues = useSyncExternalStore(signals.values('typing').subscribe, signals.values('typing').getSnapshot);
  const hereValues = useSyncExternalStore(signals.values('here').subscribe, signals.values('here').getSnapshot);
  const presenceValues = useSyncExternalStore(presenceTopic.values().subscribe, presenceTopic.values().getSnapshot);
  const onlineValues = useSyncExternalStore(onlineTopic.values().subscribe, onlineTopic.values().getSnapshot);
  const { state, transport, error: connError } = useSyncExternalStore(client.connection.subscribe, client.connection.getSnapshot);

  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [showPeople, setShowPeople] = useState(false);
  const lastSignal = useRef(0);
  const list = useRef<HTMLOListElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const sub = room.subscribe({ from: { last: HISTORY } });
    sub.on('error', (e) => setError(e.message));
    const t = setTimeout(() => setLoaded(true), 600);
    return () => {
      clearTimeout(t);
      void sub.unsubscribe();
    };
  }, [room]);

  useEffect(() => {
    const subs = [signals.subscribe(), onlineTopic.subscribe({ from: 'oldest' })];
    // Refused or empty when the segment has no presence for `chat/>`; the `here` signals cover that.
    const presence = presenceTopic.subscribe({ from: 'oldest' });
    presence.on('error', () => {});
    return () => {
      for (const s of [...subs, presence]) void s.unsubscribe();
    };
  }, [signals, presenceTopic, onlineTopic]);

  // Follow new messages while the list is scrolled to the bottom.
  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const myConnections = Math.max(1, [...onlineValues.values()].filter((m) => !m.deleted).length);
  const connectionsRef = useRef(myConnections);
  connectionsRef.current = myConnections;

  // Say "I'm here" (with how many connections this identity has) while connected.
  useEffect(() => {
    const beat = () => void signals.publish('here', { connections: connectionsRef.current }, { delivery: 'signal' });
    beat();
    const t = setInterval(beat, HERE_EVERY_MS);
    return () => clearInterval(t);
  }, [signals]);

  // You first, then everyone else by name.
  const inRoom = [
    { identity: me.identity, connections: myConnections },
    ...people(presenceValues, hereValues)
      .filter((p) => p.identity !== me.identity)
      .sort((a, b) => nameOf(a.identity).localeCompare(nameOf(b.identity))),
  ];
  const typing = [...typingValues.values()]
    .filter((m) => (m.data as { typing?: boolean } | undefined)?.typing && m.publisher !== me.identity)
    .map((m) => nameOf(m.publisher));

  function signal(isTyping: boolean) {
    void signals.publish('typing', { typing: isTyping }, { delivery: 'signal' });
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    stick.current = true;
    lastSignal.current = 0;
    signal(false);
    try {
      await room.publish('message', { text });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function onType(value: string) {
    setDraft(value);
    if (value && Date.now() - lastSignal.current > 2_000) {
      lastSignal.current = Date.now();
      signal(true);
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <Wordmark />
        <span className="room-name">
          <span className="sep" aria-hidden="true">/</span>
          {ROOM}
        </span>
        <span className="spacer" />
        <Status state={state} transport={transport} />
        <button className="btn btn-ghost people-toggle" type="button" onClick={() => setShowPeople((v) => !v)} aria-expanded={showPeople}>
          People <span className="count">{inRoom.length}</span>
        </button>
        <span className="me-chip">
          <Avatar name={me.name} me size={26} />
          <span className="me-name">{me.name}</span>
        </span>
        <button className="btn btn-secondary btn-sm" type="button" onClick={onSignOut}>
          Sign out
        </button>
      </header>

      <div className="layout">
        <section className="conversation" aria-label="Messages">
          <ol
            className="messages"
            ref={list}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
          >
            {messages.length === 0 && (
              <li className="empty">
                {loaded ? (
                  <>
                    <Eyebrow>chat/lobby</Eyebrow>
                    <p className="fw-text-heading-3">No messages yet.</p>
                    <p className="muted">Say hello. Open this page in another tab to talk to yourself, as someone else or as {me.name} again.</p>
                  </>
                ) : (
                  <p className="muted">Loading the last {HISTORY} messages…</p>
                )}
              </li>
            )}
            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const at = m.serverTime || m.clientTime || Date.now();
              const prevAt = prev ? prev.serverTime || prev.clientTime || 0 : 0;
              const grouped = !!prev && prev.publisher === m.publisher && at - prevAt < GROUP_MS;
              const mine = m.publisher === me.identity;
              const name = nameOf(m.publisher);
              const text = (m.data as { text?: unknown } | undefined)?.text;
              return (
                <li key={m.id} className={`msg ${mine ? 'mine' : ''} ${grouped ? 'grouped' : ''} ${m.status}`}>
                  <span className="msg-avatar">{!grouped && <Avatar name={name} me={mine} />}</span>
                  <div className="msg-body">
                    {!grouped && (
                      <p className="msg-meta">
                        <span className="msg-name">{mine ? `${name} (you)` : name}</span>
                        <time dateTime={new Date(at).toISOString()}>{time(at)}</time>
                      </p>
                    )}
                    <p className="msg-text">{typeof text === 'string' ? text : JSON.stringify(m.data)}</p>
                    {m.status === 'pending' && <p className="msg-state">Sending…</p>}
                    {m.status === 'failed' && (
                      <p className="msg-state bad">
                        Not sent.{' '}
                        <button className="link" type="button" onClick={() => void m.retry?.()}>
                          Retry
                        </button>
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>

          <div className="typing" aria-live="polite">
            {typing.length > 0 && (
              <>
                <span className="dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                {typing.length === 1 ? `${typing[0]} is typing` : `${typing.slice(0, -1).join(', ')} and ${typing.at(-1)} are typing`}
              </>
            )}
          </div>

          {(error || (state === 'failed' && connError)) && (
            <p className="alert" role="alert">
              {error ?? connError?.message}
              {error && (
                <button className="link" type="button" onClick={() => setError(undefined)}>
                  Dismiss
                </button>
              )}
            </p>
          )}

          <form className="composer" onSubmit={send}>
            <textarea
              value={draft}
              onChange={(e) => onType(e.target.value)}
              onKeyDown={onKey}
              placeholder={`Message ${ROOM}`}
              rows={1}
              autoFocus
              aria-label="Message"
            />
            <button className="btn btn-primary" type="submit" disabled={!draft.trim()}>
              Send
            </button>
          </form>
        </section>

        <aside className={`people ${showPeople ? 'open' : ''}`} aria-label="People in the room">
          <Eyebrow>In the room · {inRoom.length}</Eyebrow>
          <ul className="people-list">
            {inRoom.map((p) => {
              const mine = p.identity === me.identity;
              const connections = mine ? Math.max(p.connections, myConnections) : p.connections;
              return (
                <li key={p.identity}>
                  <span className="presence-avatar">
                    <Avatar name={nameOf(p.identity)} me={mine} />
                    <span className="live-dot" aria-hidden="true" />
                  </span>
                  <span className="person">
                    <span className="person-name">
                      {nameOf(p.identity)}
                      {mine && <span className="tag">you</span>}
                    </span>
                    <span className="person-meta">
                      {connections} {connections === 1 ? 'connection' : 'connections'}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>

          <div className="you-card">
            <p className="you-title">
              Signed in as <strong>{me.name}</strong>
            </p>
            <p className="you-count">
              <span className="live-dot static" aria-hidden="true" />
              {myConnections === 1 ? 'Connected in this tab only' : `Connected in ${myConnections} places`}
            </p>
            <p className="note">Same name, same person: every tab or browser that signs in as {me.name} adds a connection.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Status({ state, transport }: { state: string; transport: string | null }) {
  const live = state === 'connected';
  const bad = state === 'failed' || state === 'closed' || state === 'offline';
  const label = live ? 'Live' : state === 'reconnecting' || state === 'connecting' ? 'Reconnecting…' : state === 'offline' ? 'Offline' : state;
  return (
    <span className={`status ${live ? 'live' : bad ? 'bad' : 'busy'}`} role="status">
      {label}
      {live && transport && <span className="transport"> · {transport}</span>}
    </span>
  );
}
