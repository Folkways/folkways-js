import { useEffect, useState, type FormEvent } from 'react';
import { Folkways, isRealtimeError, type Realtime } from '@folkwaysio/realtime';
import { connection, login, realtimeToken, savedSignIn, saveSignIn, SignedOut, type SignIn } from './api';
import { Chat } from './Chat';
import { Eyebrow, LogoTile } from './ui';

// The node URL the last connect used, for error messages.
let nodeUrl = '';

/** Explains a failed connect in terms of what to fix. */
function describe(err: unknown): string {
  // The SDK wraps errors thrown by the token function as AuthRequired, with the original as the cause.
  if (isRealtimeError(err) && err.cause instanceof Error) return describe(err.cause);
  if (err instanceof SignedOut) return err.message;
  if (isRealtimeError(err)) {
    if (err.codeName === 'AuthInvalid') {
      return 'The node refused the token. Check that FOLKWAYS_SEGMENT_ID, FOLKWAYS_KEY_ID and the signing key in apps/token-server/.env belong to the same key of the same segment.';
    }
    if (err.codeName === 'Timeout') return `Can't reach the node at ${nodeUrl}. Check FOLKWAYS_URL in apps/token-server/.env, and that the node is running.`;
    return `${err.codeName}: ${err.message}`;
  }
  return (err as Error).message ?? String(err);
}

const isSignedOut = (err: unknown): boolean => err instanceof SignedOut || (isRealtimeError(err) && err.cause instanceof SignedOut);

async function connect(signIn: SignIn): Promise<Realtime> {
  // Get the first token up front: the SDK retries a failing token function
  // until the connect times out, but an expired sign-in or a stopped token
  // server should show at once.
  // The node comes from the token server too, so the app has no settings of its own.
  const [node, initial] = await Promise.all([connection(), realtimeToken(signIn.session, 'initial')]);
  nodeUrl = node.url;
  let first: string | undefined = initial;
  const transport = new URLSearchParams(window.location.search).get('transport');
  return Folkways.connect({
    ...node,
    ...(transport === 'websocket' || transport === 'http' ? { transports: [transport] } : {}),
    // Called on connect and again before each token expires.
    token: ({ reason }) => {
      const token = first;
      first = undefined;
      return token ?? realtimeToken(signIn.session, reason);
    },
    connectTimeoutMs: 10_000,
  });
}

export default function App() {
  const [signIn, setSignIn] = useState<SignIn | null>(savedSignIn);
  const [client, setClient] = useState<Realtime>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => () => void client?.close(), [client]);

  // A reload keeps this tab's sign-in: connect again straight away.
  useEffect(() => {
    const saved = savedSignIn();
    if (!saved) return;
    let cancelled = false;
    setBusy(true);
    connect(saved)
      .then((c) => (cancelled ? void c.close() : setClient(c)))
      .catch((err) => {
        if (cancelled) return;
        if (isSignedOut(err)) signOut();
        setError(describe(err));
      })
      .finally(() => !cancelled && setBusy(false));
    return () => {
      cancelled = true;
    };
  }, []);

  async function join(name: string) {
    setError(undefined);
    setBusy(true);
    try {
      const s = await login(name);
      saveSignIn(s);
      setSignIn(s);
      setClient(await connect(s));
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  function signOut() {
    setClient(undefined);
    saveSignIn(null);
    setSignIn(null);
  }

  if (client && signIn) return <Chat client={client} me={signIn} onSignOut={signOut} />;
  return <Login onJoin={join} busy={busy} error={error} resuming={busy && !!signIn} />;
}

function Login({ onJoin, busy, error, resuming }: { onJoin: (name: string) => void; busy: boolean; error?: string; resuming: boolean }) {
  const [name, setName] = useState('');
  const valid = /^[A-Za-z0-9._-]{1,32}$/.test(name.trim());

  function submit(e: FormEvent) {
    e.preventDefault();
    if (valid && !busy) onJoin(name.trim());
  }

  return (
    <main className="login-page">
      <div className="login-card">
        <LogoTile size={48} />
        <Eyebrow>Realtime chat example</Eyebrow>
        <h1 className="fw-text-heading-2">Join the lobby</h1>
        {resuming ? (
          <p className="muted" role="status">
            Reconnecting…
          </p>
        ) : (
          <form onSubmit={submit} className="login-form">
            <p className="muted">
              Pick any name. Sign in with the same name in another tab or browser and you show up as one person with
              several connections.
            </p>
            <label className="field">
              <span>Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="alice"
                autoFocus
                autoComplete="nickname"
                maxLength={32}
                spellCheck={false}
                aria-invalid={name.length > 0 && !valid}
              />
              <small className={name.length > 0 && !valid ? 'hint bad' : 'hint'}>Letters, digits, dots, dashes or underscores</small>
            </label>
            <button className="btn btn-primary" type="submit" disabled={!valid || busy}>
              {busy ? 'Joining…' : 'Join chat'}
            </button>
          </form>
        )}
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
      </div>
      <p className="login-foot">
        Tokens are signed by the example token server in <code>apps/token-server</code>.
      </p>
    </main>
  );
}
