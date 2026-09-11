import { reportsProgress, type ClientMessage } from '../src/shared/protocol';
import { expectWork } from './progress';

interface VsCodeApi {
  postMessage(message: ClientMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** Available once per webview load, so it is grabbed here and shared. */
export const vscode: VsCodeApi = acquireVsCodeApi();

/**
 * Every request to the host goes through here, which is what makes this the
 * one place that has to know a request has been made — the alternative is a
 * call to say so at each of the twenty-odd places that send one, and the one
 * that gets forgotten is the key that looks broken.
 */
export function send(message: ClientMessage): void {
  if (reportsProgress(message.type)) expectWork();
  vscode.postMessage(message);
}
