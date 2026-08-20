import * as vscode from 'vscode';
import { CommanderPanel } from './commanderPanel';
import { ProviderRegistry } from './core/provider';
import { EditorBridge } from './core/editorBridge';
import { settings } from './core/settings';
import { SessionManager } from './zowe/sessions';
import { LocalProvider } from './providers/localProvider';
import { DsProvider } from './providers/dsProvider';
import { UssProvider } from './providers/ussProvider';
import { JesProvider } from './providers/jesProvider';

export function activate(context: vscode.ExtensionContext): void {
  const sessions = new SessionManager();

  const providers = new ProviderRegistry();
  providers.register(new LocalProvider(settings.pageSize));
  providers.register(new DsProvider(sessions, {
    pageSize: settings.pageSize,
    binaryExtensions: settings.binaryExtensions,
  }));
  providers.register(new UssProvider(sessions, {
    pageSize: settings.pageSize,
    binaryExtensions: settings.binaryExtensions,
  }));
  providers.register(new JesProvider(sessions, { defaultOwner: settings.jesOwner }));

  EditorBridge.register(context, providers, settings.transferDefaults);

  context.subscriptions.push(
    vscode.commands.registerCommand('mc.open', () => {
      CommanderPanel.show(context, providers, sessions);
    }),
    // Bound in package.json so the debugger does not start when the user
    // presses F5 with the panel focused.
    vscode.commands.registerCommand('mc.key', (args?: { key?: string }) => {
      if (args?.key) CommanderPanel.forwardKey(args.key);
    }),
    // A changed team config must not leave stale sessions behind.
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('zowe')) sessions.invalidate();
    }),
  );
}

export function deactivate(): void {
  // The panel disposes its own queue and timers via onDidDispose.
}
