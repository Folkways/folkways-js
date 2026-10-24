import type { ConnectionState as EngineState, Engine } from '../engine';
import { Emitter } from '../shared/emitter';
import type { RealtimeError } from '../shared/errors';
import { Live } from './live';
import type { Connection, ConnectionEvents, ConnectionSnapshot, ConnectionState } from './types';

/** `client.connection`: one connection for the whole segment. */
export class RealtimeConnection extends Emitter<ConnectionEvents> implements Connection {
  private readonly live: Live<ConnectionSnapshot>;

  /** @internal */
  constructor(private readonly engine: Engine) {
    super();
    this.onListenerError = (err) => engine.log.error('connection listener threw', { err });
    this.live = new Live<ConnectionSnapshot>(this.snapshot(null), this.onListenerError);
    engine.on('state', (current: EngineState, previous: EngineState, reason?: RealtimeError) => {
      this.live.set(this.snapshot(current === 'failed' ? (reason ?? engine.error ?? null) : null));
      this.emit('change', { current, previous, reason });
    });
    engine.on('connected', () => this.live.set(this.snapshot(null)));
  }

  get state(): ConnectionState {
    return this.engine.state;
  }

  get transport() {
    return this.engine.transport;
  }

  get error(): RealtimeError | null {
    return this.engine.state === 'failed' ? (this.engine.error ?? null) : null;
  }

  readonly getSnapshot = (): ConnectionSnapshot => this.live.getSnapshot();

  readonly subscribe = (listener: () => void): (() => void) => this.live.subscribe(listener);

  whenConnected(): Promise<void> {
    return this.engine.whenConnected();
  }

  /** @internal Reports an error not tied to one call. */
  report(err: RealtimeError | Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', err);
    else this.engine.log.warn('unhandled client error', { err });
  }

  private snapshot(error: RealtimeError | null): ConnectionSnapshot {
    return Object.freeze({ state: this.engine.state, transport: this.engine.transport, error });
  }
}
