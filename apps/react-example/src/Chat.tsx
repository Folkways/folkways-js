import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from 'react';
import { defineTopic, type Message, type Realtime } from '@folkwaysio/realtime';
import { nameOf, type SignIn } from './api';
import { Avatar, Eyebrow, Wordmark } from './ui';

// One room carries messages, read positions and typing signals.
const ROOM = 'chat/lobby';
const PRESENCE = `$presence/${ROOM}`;
const HISTORY = 50;
const GROUP_MS = 5 * 60_000;

type RoomEvents = {
  message: { text: string };
  read: { messageUid: string };
  typing: { typing: boolean };
};
const chatRoom = defineTopic<RoomEvents>()(ROOM, {
  events: {
    message: 'stream',
    read: { delivery: 'kv', keyIsPublisher: true, ttlMs: 86_400_000 },
    typing: { delivery: 'signal', ttlMs: 3_000 },
  },
  presence: true,
});
type PresenceEntry = { identity?: string; session?: string; since?: number };

interface Person {
  identity: string;
  connections: number;
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** One person per identity, with a count of their live room connections. */
function people(presence: ReadonlyMap<string, Message>): Person[] {
  const counts = new Map<string, number>();
  for (const m of presence.values()) {
    if (m.deleted) continue;
    const entry = (m.data ?? {}) as PresenceEntry;
    const identity = entry.identity ?? m.publisher;
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  return [...counts].map(([identity, connections]) => ({ identity, connections }));
}

export function Chat({ client, me, onSignOut }: { client: Realtime; me: SignIn; onSignOut: () => void }) {
  const room = chatRoom.open(client, {});
  const presenceTopic = client.topic(PRESENCE);
  // Every live connection of this identity, anywhere in the segment. Readable by its owner without any right.
  const onlineTopic = client.topic(`$online/${me.identity}`);

  const messages = useSyncExternalStore(room.messages.subscribe, room.messages.getSnapshot);
  const typingValues = useSyncExternalStore(room.values('typing').subscribe, room.values('typing').getSnapshot);
  const readValues = useSyncExternalStore(room.values('read').subscribe, room.values('read').getSnapshot);
  const presenceValues = useSyncExternalStore(presenceTopic.values().subscribe, presenceTopic.values().getSnapshot);
  const onlineValues = useSyncExternalStore(onlineTopic.values().subscribe, onlineTopic.values().getSnapshot);
  const { state, transport, error: connError } = useSyncExternalStore(client.connection.subscribe, client.connection.getSnapshot);

  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [showPeople, setShowPeople] = useState(false);
  const lastSignal = useRef(0);
  const lastRead = useRef<string | undefined>(undefined);
  const list = useRef<HTMLOListElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const sub = room.subscribe({ from: { last: HISTORY } });
    let active = true;
    sub.on('error', (e) => setError(e.message));
    sub.on('ended', (e) => setError(e.message));
    sub.on('gap', () => setError('Some earlier messages are no longer retained. Showing available history.'));
    void sub.ready.then(() => { if (active) setLoaded(true); }, () => {});
    return () => {
      active = false;
      void sub.unsubscribe();
    };
  }, [room]);

  useEffect(() => {
    const subs = [presenceTopic.subscribe({ from: 'oldest' }), onlineTopic.subscribe({ from: 'oldest' })];
    for (const sub of subs) sub.on('error', (e) => setError(e.message));
    return () => {
      for (const sub of subs) void sub.unsubscribe();
    };
  }, [presenceTopic, onlineTopic]);

  // Follow new messages while the list is scrolled to the bottom.
  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const myConnections = [...onlineValues.values()].filter((m) => !m.deleted).length;

  // Record the latest confirmed message in the open room, not proof that
  // someone read its text. Use the UID instead of a cursor or local ID.
  const latestUid = [...messages].reverse().find((m) => m.name === 'message' && m.status === 'sent' && !m.fromCache && m.uid)?.uid;
  useEffect(() => {
    if (!loaded || state !== 'connected' || !latestUid || lastRead.current === latestUid) return;
    lastRead.current = latestUid;
    void room.publish('read', { messageUid: latestUid }).catch((err: Error) => {
      if (lastRead.current === latestUid) lastRead.current = undefined;
      setError(err.message);
    });
  }, [room, loaded, state, latestUid]);

  const readers = new Map<string, string[]>();
  for (const m of readValues.values()) {
    if (m.publisher === me.identity || m.deleted) continue;
    const uid = (m.data as { messageUid?: unknown } | undefined)?.messageUid;
    if (typeof uid !== 'string') continue;
    const names = readers.get(uid) ?? [];
    names.push(nameOf(m.publisher));
    readers.set(uid, names);
  }

  // You first, then everyone else by name.
  const present = people(presenceValues);
  const inRoom = [
    ...present.filter((p) => p.identity === me.identity),
    ...present
      .filter((p) => p.identity !== me.identity)
      .sort((a, b) => nameOf(a.identity).localeCompare(nameOf(b.identity))),
  ];
  const typing = [...typingValues.values()]
    .filter((m) => (m.data as { typing?: boolean } | undefined)?.typing && m.publisher !== me.identity)
    .map((m) => nameOf(m.publisher));

  function signal(isTyping: boolean) {
    void room.publish('typing', { typing: isTyping });
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
    if (!value) {
      lastSignal.current = 0;
      signal(false);
    } else if (Date.now() - lastSignal.current > 1_000) {
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
                    {mine && m.uid && readers.has(m.uid) && <p className="msg-state">Read up to by {readers.get(m.uid)!.sort().join(', ')}</p>}
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
          <Eyebrow>WebSocket presence · {inRoom.length}</Eyebrow>
          <ul className="people-list">
            {inRoom.map((p) => {
              const mine = p.identity === me.identity;
              const connections = p.connections;
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
              {myConnections === 0 ? 'No active WebSocket connections' : `${myConnections} active WebSocket ${myConnections === 1 ? 'connection' : 'connections'}`}
            </p>
            <p className="note">Only WebSocket connections appear in presence. HTTP clients can still exchange messages and state.</p>
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
