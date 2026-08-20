import type { ClientMessage } from '../src/shared/protocol';

interface VsCodeApi {
  postMessage(message: ClientMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** Available once per webview load, so it is grabbed here and shared. */
export const vscode: VsCodeApi = acquireVsCodeApi();

export function send(message: ClientMessage): void {
  vscode.postMessage(message);
}
