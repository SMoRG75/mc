/**
 * The extension's log, written to its own channel in the Output panel.
 *
 * Kept free of `vscode` so that everything can log — the providers, the
 * queue, the flow control — and still be unit-tested: until `configure` hands
 * it a channel, it writes nowhere.
 *
 * The level is a setting (`mc.log.level`) rather than VS Code's own log level
 * for the channel, because a setting is where someone chasing a problem looks,
 * and where they can be told to look.
 */

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = typeof LOG_LEVELS[number];

export interface LogSink {
  appendLine(line: string): void;
}

class Log {
  private sink?: LogSink;
  private level: () => LogLevel = () => 'info';

  configure(sink: LogSink, level: () => LogLevel): void {
    this.sink = sink;
    this.level = level;
  }

  /**
   * True when `level` would be written. For a debug line that costs something
   * to put together — the arguments of every provider call — ask first.
   */
  enabled(level: LogLevel): boolean {
    if (!this.sink) return false;
    const current = this.level();
    const at = LOG_LEVELS.indexOf(LOG_LEVELS.includes(current) ? current : 'info');
    return LOG_LEVELS.indexOf(level) <= at;
  }

  error(message: string, detail?: string): void { this.write('error', message, detail); }
  warn(message: string, detail?: string): void { this.write('warn', message, detail); }
  info(message: string, detail?: string): void { this.write('info', message, detail); }
  debug(message: string, detail?: string): void { this.write('debug', message, detail); }

  private write(level: LogLevel, message: string, detail?: string): void {
    if (!this.enabled(level)) return;
    this.sink!.appendLine(`${timestamp()} [${level}] ${redact(message)}`);
    // Indented under the line it belongs to, so a z/OSMF message of several
    // lines reads as part of one entry rather than as entries of its own.
    if (detail) this.sink!.appendLine(redact(detail).replace(/^/gm, '    '));
  }
}

/**
 * Takes out anything that looks like a credential, whatever wrote it.
 *
 * Nothing of ours logs one, and Imperative's error dump lists the request's
 * headers without the one that authenticates it — but that is its choice, not
 * ours, and a log is exactly the thing that gets pasted into an issue.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]{8,}/g, '$1 ***')
    .replace(/("?(?:Authorization|Cookie|Set-Cookie)"?\s*[:=]\s*"?)[^"\n,}]+/gi, '$1***')
    .replace(/\b(LtpaToken2|jwtToken|apimlAuthenticationToken)=[^;\s"]+/g, '$1=***');
}

export const log = new Log();

function timestamp(): string {
  const now = new Date();
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}
