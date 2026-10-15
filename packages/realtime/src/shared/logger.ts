export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const noop = () => {};

export const silentLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** A logger writing to `console` at `level` and above. Tokens are never logged by the SDK. */
export function consoleLogger(level: LogLevel = 'info', prefix = '[folkways]'): Logger {
  const at = (l: LogLevel) => (message: string, fields?: Record<string, unknown>) => {
    if (ORDER[l] < ORDER[level]) return;
    const args: unknown[] = [`${prefix} ${message}`];
    if (fields && Object.keys(fields).length > 0) args.push(fields);
    // eslint-disable-next-line no-console
    console[l](...args);
  };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}
