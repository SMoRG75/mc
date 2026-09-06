import * as vscode from 'vscode';
import type {
  ClientMessage, HostMessage, PaneId, PaneLocation, TransferJobDto, TransferOptions,
} from './shared/protocol';
import type { Entry, PaneProvider, ProviderRegistry } from './core/provider';
import { TransferQueue, type TransferRequest } from './core/transferQueue';
import { EditorBridge, type OpenMode } from './core/editorBridge';
import { describeError, UserFacingError } from './core/errors';
import { settings } from './core/settings';
import type { SessionManager } from './zowe/sessions';

const VIEW_TYPE = 'mainframeCommander';

interface PaneState {
  location: PaneLocation;
  entries: Entry[];
  /** Cancels the in-flight listing when the user navigates away from it. */
  inFlight?: AbortController;
}

/**
 * The webview panel and everything it talks to.
 *
 * Deliberately the only stateful place in the extension: providers are pure,
 * the queue only knows about bytes, and this class holds "where each pane is
 * pointing and what it last listed" so that an entry id coming back from the
 * webview can be resolved to a real provider entry.
 */
export class CommanderPanel {
  private static current?: CommanderPanel;

  private readonly panes: Record<PaneId, PaneState>;
  private readonly queue: TransferQueue;
  private readonly disposables: vscode.Disposable[] = [];
  private jesTimer?: NodeJS.Timeout;

  static show(
    context: vscode.ExtensionContext,
    providers: ProviderRegistry,
    sessions: SessionManager,
  ): CommanderPanel {
    if (CommanderPanel.current) {
      // preserveFocus: false — reopening the command should hand the keyboard
      // back to the panes, not leave it wherever it was.
      CommanderPanel.current.panel.reveal(undefined, false);
      CommanderPanel.current.post({ type: 'focus' });
      return CommanderPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE, 'Mainframe Commander', vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
      },
    );
    CommanderPanel.current = new CommanderPanel(panel, context, providers, sessions);
    return CommanderPanel.current;
  }

  /** Keys VS Code binds globally are forwarded here instead of being swallowed. */
  static forwardKey(key: string): void {
    CommanderPanel.current?.post({ type: 'key', key });
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly providers: ProviderRegistry,
    private readonly sessions: SessionManager,
  ) {
    this.panes = {
      left: { location: settings.startLocation('left'), entries: [] },
      right: { location: settings.startLocation('right'), entries: [] },
    };

    this.queue = new TransferQueue(
      settings.concurrency,
      (jobs) => this.post({ type: 'transfers', jobs }),
      (job) => this.onTransferFinished(job),
    );

    panel.webview.html = this.html();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg: ClientMessage) => void this.handle(msg)),
      // Tabbing back to the panel focuses the iframe but nothing in it; the
      // webview needs the nudge to put focus on the active pane again.
      panel.onDidChangeViewState(() => {
        if (panel.active) this.post({ type: 'focus' });
      }),
      panel.onDidDispose(() => this.dispose()),
    );
    this.scheduleJesRefresh();
  }

  private dispose(): void {
    CommanderPanel.current = undefined;
    if (this.jesTimer) clearInterval(this.jesTimer);
    this.queue.cancelAll();
    for (const d of this.disposables) d.dispose();
  }

  /* ---------------------------------------------------------------- */
  /* messages                                                          */
  /* ---------------------------------------------------------------- */

  private async handle(msg: ClientMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          this.post({
            type: 'init',
            panes: { left: this.panes.left.location, right: this.panes.right.location },
            profiles: await this.sessions.profiles().catch(() => []),
            defaults: settings.transferDefaults(),
            codepages: settings.codepages(),
          });
          this.post({ type: 'focus' });
          await Promise.all([this.refresh('left'), this.refresh('right')]);
          break;

        case 'navigate':
          this.panes[msg.pane].location = msg.location;
          await this.refresh(msg.pane);
          break;

        case 'up': {
          const state = this.panes[msg.pane];
          const parent = this.provider(msg.pane).parent(state.location);
          if (parent) {
            state.location = parent;
            await this.refresh(msg.pane);
          }
          break;
        }

        case 'enter': {
          const state = this.panes[msg.pane];
          const entry = this.entry(msg.pane, msg.entryId);
          const next = this.provider(msg.pane).enter(state.location, entry);
          if (next) {
            state.location = next;
            await this.refresh(msg.pane);
          } else {
            await this.openInEditor(msg.pane, msg.entryId, 'edit');
          }
          break;
        }

        case 'refresh':
          await this.refresh(msg.pane);
          break;

        case 'open':
          await this.openInEditor(msg.pane, msg.entryId, msg.mode);
          break;

        case 'copy':
        case 'move':
          await this.transfer(msg.from, msg.entryIds, msg.options, msg.type === 'move');
          break;

        case 'delete':
          await this.remove(msg.pane, msg.entryIds);
          break;

        case 'rename': {
          const entry = this.entry(msg.pane, msg.entryId);
          await this.provider(msg.pane).rename(this.panes[msg.pane].location, entry, msg.newName);
          await this.refresh(msg.pane);
          break;
        }

        case 'create': {
          const state = this.panes[msg.pane];
          const created = await this.provider(msg.pane).create(
            state.location, msg.name, msg.dataset,
          );
          await this.refresh(msg.pane);
          // The name that was typed is not always the name that was made — and a
          // dataset allocated outside the pane's own filter refreshes into the
          // same listing as before, which looks exactly like nothing happened.
          if (msg.dataset && !state.entries.some((e) => e.dto.name === created)) {
            void vscode.window.showInformationMessage(
              `${created} was allocated, but it is outside the filter '${state.location.path}'.`,
            );
          }
          break;
        }

        case 'submit':
          await this.submit(msg.pane, msg.entryIds);
          break;

        case 'compare':
          await this.compare(msg.leftEntryId, msg.rightEntryId);
          break;

        case 'cancelTransfer':
          this.queue.cancel(msg.id);
          break;

        case 'commandLine':
          await this.runCommandLine(msg.pane, msg.line);
          break;
      }
    } catch (err) {
      const { message, detail } = describeError(err);
      this.post({ type: 'error', pane: 'pane' in msg ? msg.pane : null, message, detail });
    }
  }

  /* ---------------------------------------------------------------- */
  /* actions                                                           */
  /* ---------------------------------------------------------------- */

  private async refresh(pane: PaneId): Promise<void> {
    const state = this.panes[pane];
    state.inFlight?.abort();
    const controller = new AbortController();
    state.inFlight = controller;

    this.post({ type: 'busy', pane, busy: true });
    try {
      const provider = this.provider(pane);
      const listing = await provider.list(state.location, controller.signal);
      if (controller.signal.aborted) return;
      state.entries = listing.entries;
      this.post({
        type: 'listing',
        pane,
        listing: {
          location: state.location,
          title: listing.title,
          columns: listing.columns,
          entries: listing.entries.map((e) => e.dto),
          status: listing.status,
          truncated: listing.truncated,
          capabilities: provider.capabilities(state.location),
          views: listing.views,
        },
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      const { message, detail } = describeError(err);
      this.post({ type: 'error', pane, message, detail });
    } finally {
      if (!controller.signal.aborted) this.post({ type: 'busy', pane, busy: false });
    }
  }

  private async openInEditor(pane: PaneId, entryId: string, mode: OpenMode): Promise<void> {
    const state = this.panes[pane];
    const entry = this.entry(pane, entryId);

    // Shift+F3 has to go through the bridge even on local disk: the point of it
    // is that nothing but the bridge is allowed to interpret the bytes.
    if (state.location.kind === 'local' && mode !== 'ebcdic') {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(entryId));
      await vscode.window.showTextDocument(document, { preview: mode === 'view' });
      return;
    }
    if (mode === 'ebcdic' && state.location.kind === 'jes') {
      throw new UserFacingError(
        'Spool output is already converted before it leaves JES.',
        'There are no EBCDIC bytes left to decode here — F3 shows the same content as text.',
      );
    }

    const name = this.provider(pane).describe(state.location, entry).name;
    const uri = EditorBridge.uri(
      state.location, entryId,
      // The page is in the tab title because it is a decision, not a property of
      // the file: the same bytes read as IBM-037 and as IBM-277 are both valid.
      mode === 'ebcdic' ? `${name} [${settings.ebcdicCodepage()}]` : name,
      mode,
    );
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: mode !== 'edit' });
  }

  private async transfer(
    from: PaneId, entryIds: string[], options: TransferOptions, move: boolean,
  ): Promise<void> {
    const to: PaneId = from === 'left' ? 'right' : 'left';
    const source = this.provider(from);
    const target = this.provider(to);
    const sourceLoc = this.panes[from].location;
    const targetLoc = this.panes[to].location;

    if (!target.capabilities(targetLoc).write) {
      throw new Error(`Cannot write to ${target.label(targetLoc)}.`);
    }

    // The codepage the user picked becomes the default for next time. Failing to
    // save a preference is worth saying out loud, but never worth stopping the
    // transfer that is already under way.
    settings.rememberCodepage(options.codepage).catch((err: unknown) => {
      const { message } = describeError(err);
      this.post({
        type: 'error', pane: from,
        message: `The codepage ${options.codepage} could not be saved as the default: ${message}`,
      });
    });

    const requests: TransferRequest[] = [];
    for (const id of entryIds) {
      const entry = this.entry(from, id);
      if (entry.dto.kind === 'dir') {
        // Recursive copy is a roadmap item; failing loudly beats copying half a tree.
        this.post({
          type: 'error', pane: from,
          message: `'${entry.dto.name}' is a folder — recursive copy is not implemented yet.`,
        });
        continue;
      }
      const name = applyPattern(options.destination, source.describe(sourceLoc, entry).name);
      if (options.onConflict !== 'overwrite' && await target.exists(targetLoc, name)) {
        if (options.onConflict === 'skip') continue;
        const answer = await vscode.window.showWarningMessage(
          `${name} already exists in ${target.label(targetLoc)}.`,
          { modal: true }, 'Overwrite', 'Skip',
        );
        if (answer !== 'Overwrite') continue;
      }
      requests.push({ source, sourceLoc, target, targetLoc, entry, name, options, move });
    }
    this.queue.enqueue(requests);
  }

  private onTransferFinished(job: TransferRequest): void {
    const target: PaneId = this.panes.left.location === job.targetLoc ? 'left' : 'right';
    void this.refresh(target);
    if (job.move) void this.refresh(target === 'left' ? 'right' : 'left');
  }

  private async remove(pane: PaneId, entryIds: string[]): Promise<void> {
    const entries = entryIds.map((id) => this.entry(pane, id));
    if (settings.confirmDelete()) {
      const what = entries.length === 1
        ? entries[0]!.dto.name
        : `${entries.length} items`;
      const answer = await vscode.window.showWarningMessage(
        `Delete ${what} in ${this.provider(pane).label(this.panes[pane].location)}?`,
        { modal: true, detail: 'This cannot be undone.' }, 'Delete',
      );
      if (answer !== 'Delete') return;
    }
    await this.provider(pane).remove(this.panes[pane].location, entries);
    await this.refresh(pane);
  }

  private async submit(pane: PaneId, entryIds: string[]): Promise<void> {
    const provider = this.provider(pane);
    if (!provider.submit) throw new Error('Nothing can be submitted from here.');
    const ids = await provider.submit(
      this.panes[pane].location, entryIds.map((id) => this.entry(pane, id)),
    );
    const other: PaneId = pane === 'left' ? 'right' : 'left';
    void vscode.window.showInformationMessage(`Submitted: ${ids.join(', ')}`);

    // Point the other pane at the job queue so the result is one glance away.
    this.panes[other].location = {
      kind: 'jes', profile: this.panes[pane].location.profile, path: '',
    };
    await this.refresh(other);
  }

  private async compare(leftEntryId: string, rightEntryId: string): Promise<void> {
    const left = this.compareSide('left', leftEntryId);
    const right = this.compareSide('right', rightEntryId);
    await vscode.commands.executeCommand(
      'vscode.diff', left.uri, right.uri, `${left.label} ↔ ${right.label}`,
    );
  }

  /**
   * One half of the diff.
   *
   * A local file is diffed as the file it is rather than through the bridge:
   * `file:` gives VS Code the real document, so the diff is editable and does
   * not cost a listing of the whole directory just to find one row again.
   */
  private compareSide(pane: PaneId, entryId: string): { uri: vscode.Uri; label: string } {
    const location = this.panes[pane].location;
    const provider = this.provider(pane);
    const entry = this.entry(pane, entryId);
    if (entry.dto.kind === 'dir') {
      throw new UserFacingError(
        `'${entry.dto.name}' is a folder — F10 compares two files.`,
      );
    }
    const name = provider.describe(location, entry).name;
    return {
      uri: location.kind === 'local'
        ? vscode.Uri.file(entryId)
        : EditorBridge.uri(location, entryId, name, 'view'),
      label: `${provider.label(location)}: ${name}`,
    };
  }

  /**
   * The command line under the panes. Only the verbs that have a real
   * equivalent are wired; anything else is refused rather than guessed at.
   */
  private async runCommandLine(pane: PaneId, line: string): Promise<void> {
    const [verb, ...rest] = line.trim().split(/\s+/);
    const argument = rest.join(' ');
    switch ((verb ?? '').toLowerCase()) {
      case '':
        return;
      case 'cd': {
        const provider = this.provider(pane);
        const from = this.panes[pane].location;
        this.panes[pane].location = provider.resolve
          ? provider.resolve(from, argument)
          : { ...from, path: argument };
        await this.refresh(pane);
        return;
      }
      case 'submit': {
        const entry = this.panes[pane].entries.find(
          (e) => e.dto.name.toUpperCase() === argument.toUpperCase(),
        );
        if (!entry) throw new Error(`'${argument}' is not in the pane.`);
        await this.submit(pane, [entry.dto.id]);
        return;
      }
      case 'refresh':
        await this.refresh(pane);
        return;
      default:
        throw new Error(`Unknown command '${verb}'. Known commands: cd, submit, refresh.`);
    }
  }

  private scheduleJesRefresh(): void {
    const seconds = settings.jesRefreshSeconds();
    if (seconds <= 0) return;
    this.jesTimer = setInterval(() => {
      if (!this.panel.visible) return;
      for (const pane of ['left', 'right'] as PaneId[]) {
        if (this.panes[pane].location.kind === 'jes') void this.refresh(pane);
      }
    }, seconds * 1000);
  }

  /* ---------------------------------------------------------------- */
  /* plumbing                                                          */
  /* ---------------------------------------------------------------- */

  private provider(pane: PaneId): PaneProvider {
    return this.providers.get(this.panes[pane].location.kind);
  }

  private entry(pane: PaneId, entryId: string): Entry {
    const entry = this.panes[pane].entries.find((e) => e.dto.id === entryId);
    if (!entry) throw new Error('That row no longer exists — the pane has been refreshed.');
    return entry;
  }

  private post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private html(): string {
    const webview = this.panel.webview;
    const asset = (file: string) => webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', file),
    );
    const nonce = nonceOf(32);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';
  style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<link rel="stylesheet" href="${asset('style.css')}">
<title>Mainframe Commander</title>
</head>
<body>
<div id="app"></div>
<script type="module" nonce="${nonce}" src="${asset('index.js')}"></script>
</body>
</html>`;
  }
}

/** `*` keeps the source name; anything else is used verbatim. */
function applyPattern(pattern: string, sourceName: string): string {
  if (!pattern || pattern === '*') return sourceName;
  return pattern.replace(/\*/g, sourceName);
}

function nonceOf(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export function transferDefaults(): TransferOptions {
  return settings.transferDefaults();
}

export type { TransferJobDto };
