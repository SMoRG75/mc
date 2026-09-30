import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import {
  reportsProgress,
  type ClientMessage, type HostMessage, type PaneId, type PaneKind, type PaneLocation,
  type SearchHitDto, type SearchQuery, type TransferJobDto, type TransferOptions,
} from './shared/protocol';
import type { Entry, PaneProvider, ProviderRegistry } from './core/provider';
import { TransferQueue, type TransferRequest } from './core/transferQueue';
import { planCopy, type ConflictAnswer } from './core/treeCopy';
import { search } from './core/search';
import { EditorBridge, type OpenMode } from './core/editorBridge';
import { CursorHistory } from './core/cursorHistory';
import { describeError, UserFacingError } from './core/errors';
import { log } from './core/log';
import {
  asRememberedPanes, sameLocation, settings,
  type RememberedPane, type RememberedPanes,
} from './core/settings';
import type { SessionManager } from './zowe/sessions';

const VIEW_TYPE = 'mainframeCommander';

/**
 * Where the panes were last pointing, in the extension's own storage.
 *
 * Not in `mc.panes.*`: that is the user saying where to start, and it lives in
 * a settings.json that may well be under git. This changes on every navigation,
 * which is a different kind of thing and belongs in a memento.
 */
const REMEMBERED_PANES = 'panes.last';

/** How often a running search sends what it has found to the dialog. */
const SEARCH_REPORT_MS = 150;

/** How often, at most, finished transfers make a pane list itself again. */
const REFRESH_MS = 300;

interface PaneState {
  location: PaneLocation;
  entries: Entry[];
  /** The row the cursor is on in `location`, as the webview last reported it. */
  cursor?: string;
  /**
   * Where the cursor was in each location this pane has visited, so stepping
   * into a PDS and back out lands on the member you came from, not at the top.
   */
  history: CursorHistory;
  /**
   * The last place the pane stood in each world, so Alt+2 comes back to the PDS
   * you were reading rather than to the dataset filter. Four entries at most,
   * and only for the session — the same reasoning as the cursor history.
   */
  lastByKind: Partial<Record<PaneKind, PaneLocation>>;
  /**
   * A remembered cursor waiting to be handed back, cleared once it has been.
   * Set only when the pane moves: a plain refresh must not carry one, or
   * F2 would yank the cursor back from wherever the user had moved it.
   */
  restore?: string;
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
  /** The last state written, so a JES pane refreshing itself does not rewrite it. */
  private remembered = '';
  /** Recalls being waited on, so closing the panel stops the waiting. */
  private readonly recalls = new Set<AbortController>();
  /** Searches running, by the id the webview gave them, so they can be stopped. */
  private readonly searches = new Map<string, AbortController>();
  /** Pending re-listings, so a copy of 500 files does not list the pane 500 times. */
  private readonly refreshTimers: Partial<Record<PaneId, NodeJS.Timeout>> = {};
  /**
   * How many things the user is waiting for. A count rather than a flag: F5 on
   * top of a listing that is still running is two, and the pointer goes back to
   * normal when the last of them is done, not when the first one is.
   */
  private working = 0;

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

  /**
   * Re-lists any pane standing where something was just written. Static for the
   * same reason as `forwardKey`: the editor bridge outlives the panel, which is
   * only created when the user opens it.
   */
  static locationChanged(location: PaneLocation): void {
    const panel = CommanderPanel.current;
    if (!panel) return;
    for (const pane of ['left', 'right'] as PaneId[]) {
      if (sameLocation(panel.panes[pane].location, location)) void panel.refresh(pane);
    }
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly providers: ProviderRegistry,
    private readonly sessions: SessionManager,
  ) {
    const remembered = asRememberedPanes(context.globalState.get(REMEMBERED_PANES));
    const restore = (pane: PaneId): PaneState => {
      const location = settings.startLocation(pane, remembered);
      // A cursor is only meaningful in the listing it was remembered in. When
      // the location came from mc.panes.* instead, the remembered row is
      // somewhere else entirely and starting on it would be nonsense.
      const saved = remembered?.[pane];
      const cursor = saved && sameLocation(saved.location, location) ? saved.cursor : undefined;
      const history = new CursorHistory();
      // Seeded, so navigating away from the restored location and back returns
      // to the same row rather than only working from the second visit on.
      if (cursor) history.remember(location, cursor);

      // The other three worlds, with their rows. Kept whatever `mc.panes.*`
      // says: the setting decides where the pane starts, not where it stood in
      // a world it is not starting in.
      const lastByKind: Partial<Record<PaneKind, PaneLocation>> = {};
      for (const world of saved?.worlds ?? []) {
        lastByKind[world.location.kind] = world.location;
        if (world.cursor) history.remember(world.location, world.cursor);
      }
      // Last, so the world the pane is actually opening in is the one it starts
      // in — the setting may have moved it since.
      lastByKind[location.kind] = location;

      return { location, entries: [], cursor, restore: cursor, history, lastByKind };
    };
    this.panes = { left: restore('left'), right: restore('right') };

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
      // The saved views are a setting, so they also change when the user edits
      // settings.json by hand — and the pane header has to follow either way.
      // Our own writes come back through here too, which is why saving one does
      // not post anything itself.
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('mc.favourites')) {
          this.post({ type: 'favourites', favourites: settings.favourites() });
        }
      }),
      panel.onDidDispose(() => this.dispose()),
    );
    this.scheduleJesRefresh();
  }

  private dispose(): void {
    CommanderPanel.current = undefined;
    if (this.jesTimer) clearInterval(this.jesTimer);
    for (const timer of Object.values(this.refreshTimers)) clearTimeout(timer);
    for (const running of this.searches.values()) running.abort();
    for (const waiting of this.recalls) waiting.abort();
    this.queue.cancelAll();
    for (const d of this.disposables) d.dispose();
  }

  /* ---------------------------------------------------------------- */
  /* messages                                                          */
  /* ---------------------------------------------------------------- */

  private async handle(msg: ClientMessage): Promise<void> {
    // Everything below is awaited, so this is also where the work ends — which
    // is the only place that can honestly say the pointer may go back.
    const progress = reportsProgress(msg.type);
    if (progress && this.working++ === 0) this.post({ type: 'working', working: true });
    try {
      switch (msg.type) {
        case 'ready':
          this.post({
            type: 'init',
            panes: { left: this.panes.left.location, right: this.panes.right.location },
            profiles: await this.sessions.profiles().catch(() => []),
            defaults: settings.transferDefaults(),
            codepages: settings.codepages(),
            favourites: settings.favourites(),
          });
          this.post({ type: 'focus' });
          await Promise.all([this.refresh('left'), this.refresh('right')]);
          break;

        case 'navigate':
          this.goTo(msg.pane, msg.location);
          await this.refresh(msg.pane);
          break;

        case 'switchKind': {
          const state = this.panes[msg.pane];
          const here = state.location;
          // The root of a world, on the profile the pane is already using: what
          // a world it has never been to opens on, and what a second press
          // means once it is there.
          const root: PaneLocation = { kind: msg.kind, profile: here.profile, path: '' };
          this.goTo(msg.pane, here.kind === msg.kind
            ? root
            : state.lastByKind[msg.kind] ?? root);
          await this.refresh(msg.pane);
          break;
        }

        case 'up': {
          const state = this.panes[msg.pane];
          const parent = this.provider(msg.pane).parent(state.location);
          if (parent) {
            this.goTo(msg.pane, parent);
            await this.refresh(msg.pane);
          }
          break;
        }

        case 'enter':
          await this.enter(msg.pane, msg.entryId);
          break;

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

        case 'cursor':
          this.rememberCursorAt(msg.pane, msg.location, msg.entryId);
          break;

        case 'cancelTransfer':
          this.queue.cancel(msg.id);
          break;

        case 'commandLine':
          await this.runCommandLine(msg.pane, msg.line);
          break;

        case 'setFilter': {
          const provider = this.provider(msg.pane);
          if (!provider.applyFilter) break;
          this.goTo(msg.pane, provider.applyFilter(this.panes[msg.pane].location, msg.values));
          await this.refresh(msg.pane);
          break;
        }

        case 'saveFavourite':
          // The name is the identity, so saving over one replaces it — that is
          // how a saved filter gets adjusted without leaving two tabs that
          // claim to be the same view.
          await settings.saveFavourites([
            ...settings.favourites().filter((f) => f.name !== msg.name),
            { name: msg.name, location: msg.location },
          ]);
          break;

        case 'search':
          // Not awaited: it runs for as long as it runs, and reports as it goes.
          this.startSearch(msg.pane, msg.id, msg.query);
          break;

        case 'stopSearch':
          this.searches.get(msg.id)?.abort();
          break;

        case 'reveal': {
          this.goTo(msg.pane, msg.location);
          // The row the search found, rather than the one the pane last had
          // its cursor on here.
          const state = this.panes[msg.pane];
          state.restore = msg.entryId;
          state.cursor = msg.entryId;
          await this.refresh(msg.pane);
          break;
        }

        case 'removeFavourite':
          await settings.saveFavourites(
            settings.favourites().filter((f) => f.name !== msg.name),
          );
          break;
      }
    } catch (err) {
      const { message, detail } = describeError(err);
      this.post({ type: 'error', pane: 'pane' in msg ? msg.pane : null, message, detail });
    } finally {
      if (progress && --this.working === 0) this.post({ type: 'working', working: false });
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
          filter: listing.filter,
          cursor: state.restore,
        },
      });
      state.restore = undefined;
      this.rememberPanes();
    } catch (err) {
      if (controller.signal.aborted) return;
      const { message, detail } = describeError(err);
      this.post({ type: 'error', pane, message, detail });
    } finally {
      if (!controller.signal.aborted) this.post({ type: 'busy', pane, busy: false });
    }
  }

  /**
   * Keeps where the panes are pointing, so the next session opens there.
   *
   * Written on every listing that succeeded rather than when the panel closes:
   * VS Code is usually shut down with the panel still open, and nothing
   * guarantees an async write started from `onDidDispose` ever finishes. Saving
   * as we go also means a path that failed to list is not what you come back
   * to — only somewhere that actually worked is worth reopening on.
   */
  /**
   * Points a pane somewhere else, bringing back the row the cursor was on there
   * last time. Every location change goes through here — that is what makes the
   * history complete rather than a special case for Backspace.
   */
  private goTo(pane: PaneId, location: PaneLocation): void {
    const state = this.panes[pane];
    state.location = location;
    state.lastByKind[location.kind] = location;
    state.restore = state.history.recall(location);
    state.cursor = state.restore;
  }

  /**
   * Files a cursor position under the listing it was read in.
   *
   * `location` is the message's, not the pane's: a debounced report can arrive
   * after the pane has moved on, and it still says something true about where
   * it came from.
   */
  private rememberCursorAt(pane: PaneId, location: PaneLocation, entryId: string): void {
    const state = this.panes[pane];
    state.history.remember(location, entryId);
    if (sameLocation(location, state.location)) {
      state.cursor = entryId;
      this.rememberPanes();
    }
  }

  private rememberPanes(): void {
    const state: RememberedPanes = {
      left: this.rememberedPane('left'),
      right: this.rememberedPane('right'),
      from: {
        left: settings.configuredStartLocation('left'),
        right: settings.configuredStartLocation('right'),
      },
    };
    const json = JSON.stringify(state);
    if (json === this.remembered) return;
    this.remembered = json;
    void this.context.globalState.update(REMEMBERED_PANES, state);
  }

  /**
   * One pane's position: where it is, and where it stood in every world it has
   * been to, each with the row it was on. The rows come out of the cursor
   * history rather than being tracked a second time — it is already the thing
   * that knows them.
   */
  private rememberedPane(pane: PaneId): RememberedPane {
    const state = this.panes[pane];
    return {
      location: state.location,
      cursor: state.cursor,
      worlds: Object.values(state.lastByKind)
        .filter((location): location is PaneLocation => location !== undefined)
        .map((location) => ({ location, cursor: state.history.recall(location) })),
    };
  }

  /** Into a folder, library or job; a file opens in the editor instead. */
  private async enter(pane: PaneId, entryId: string): Promise<void> {
    const state = this.panes[pane];
    const entry = this.entry(pane, entryId);
    if (await this.offerRecall(pane, entry, 'enter')) return;
    const next = this.provider(pane).enter(state.location, entry);
    if (next) {
      // The row being entered is where the cursor belongs when the user
      // comes back up, and it is known here and now — the webview's own
      // report is on a timer this navigation is about to invalidate.
      this.rememberCursorAt(pane, state.location, entryId);
      this.goTo(pane, next);
      await this.refresh(pane);
    } else {
      await this.openInEditor(pane, entryId, 'edit');
    }
  }

  /**
   * Enter, F3 and F4 on a migrated data set: ask whether to recall it, and if
   * so start it and return true. False for anything that is at hand.
   */
  private async offerRecall(pane: PaneId, entry: Entry, then: 'enter' | OpenMode): Promise<boolean> {
    const provider = this.provider(pane);
    const location = this.panes[pane].location;
    const item = provider.describe(location, entry);
    if (!item.offline) return false;
    if (!provider.recall) throw new UserFacingError(`${item.name} is ${item.offline} and cannot be read.`);
    const answer = await vscode.window.showInformationMessage(
      `${item.name} is migrated. Recall it?`,
      {
        modal: true,
        detail: 'DFSMShsm has moved it off disk, and it has to come back before it can be read. '
          + 'From disk that takes seconds, from tape it can take many minutes — you can carry on '
          + 'meanwhile, and it opens once it is back if the pane is still here.',
      },
      'Recall',
    );
    if (answer === 'Recall') this.recallInBackground(pane, entry, then);
    return true;
  }

  /**
   * Waits for a recall with a notification that can be dismissed, then shows
   * the data set: refreshes the panes standing where it is, and does what was
   * asked of it — provided the pane is still there, since jumping somewhere
   * minutes later would be the wrong kind of surprise.
   */
  private recallInBackground(pane: PaneId, entry: Entry, then?: 'enter' | OpenMode): void {
    const provider = this.provider(pane);
    const location = this.panes[pane].location;
    const name = provider.describe(location, entry).name;
    const stop = new AbortController();
    this.recalls.add(stop);
    log.info(`Recall requested: ${name}`);

    const waited = vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Recalling ${name}…`,
      cancellable: true,
    }, async (_progress, token) => {
      token.onCancellationRequested(() => stop.abort());
      await provider.recall!(location, entry, stop.signal);
    });

    void Promise.resolve(waited).then(async () => {
      log.info(`Recalled: ${name}`);
      if (CommanderPanel.current !== this) return;
      const here = (['left', 'right'] as PaneId[]).filter((p) => sameLocation(this.panes[p].location, location));
      await Promise.all(here.map((p) => this.refresh(p)));
      if (then && here.includes(pane)) {
        if (then === 'enter') await this.enter(pane, entry.dto.id);
        else await this.openInEditor(pane, entry.dto.id, then);
      } else {
        void vscode.window.showInformationMessage(`${name} has been recalled.`);
      }
    }).catch((err: unknown) => {
      if (stop.signal.aborted) {
        log.info(`Stopped waiting for the recall of ${name}`);
        if (CommanderPanel.current === this) {
          void vscode.window.showInformationMessage(
            `Stopped waiting for ${name}. DFSMShsm still has the request; F2 shows it once it is back.`,
          );
        }
        return;
      }
      if (CommanderPanel.current !== this) return;
      const { message, detail } = describeError(err);
      this.post({ type: 'error', pane, message, detail });
    }).finally(() => this.recalls.delete(stop));
  }

  private async openInEditor(pane: PaneId, entryId: string, mode: OpenMode): Promise<void> {
    const state = this.panes[pane];
    const entry = this.entry(pane, entryId);
    if (await this.offerRecall(pane, entry, mode)) return;

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

    const plan = await planCopy({
      source, sourceLoc, target, targetLoc,
      entries: entryIds.map((id) => this.entry(from, id)),
      options, move,
      ask: (name, where, many) => askConflict(name, target.label(where), many),
      signal: new AbortController().signal,
    });
    if (plan.problems.length > 0) {
      const count = plan.problems.length;
      this.post({
        type: 'error', pane: from,
        message: `${count} item${count === 1 ? ' was' : 's were'} left out of the copy.`,
        detail: plan.problems.join('\n'),
      });
    }
    // The new folders are there already; the files arrive as the queue runs.
    if (plan.foldersMade > 0) this.refreshSoon(to);
    this.queue.enqueue(plan.requests);
  }

  /**
   * Re-lists the panes a finished transfer touched. By location rather than by
   * pane: a file copied three folders down changes nothing either pane shows,
   * unless one of them is standing in that folder.
   */
  private onTransferFinished(job: TransferRequest): void {
    for (const pane of ['left', 'right'] as PaneId[]) {
      const here = this.panes[pane].location;
      if (sameLocation(here, job.targetLoc) || (job.move && sameLocation(here, job.sourceLoc))) {
        this.refreshSoon(pane);
      }
    }
  }

  /**
   * Lists `pane` again shortly, once for however many asked in the meantime.
   * A pending one is left to run rather than pushed back: a long copy of small
   * files would otherwise keep the pane unchanged until the very end.
   */
  private refreshSoon(pane: PaneId): void {
    if (this.refreshTimers[pane]) return;
    this.refreshTimers[pane] = setTimeout(() => {
      this.refreshTimers[pane] = undefined;
      void this.refresh(pane);
    }, REFRESH_MS);
  }

  /**
   * Alt+F7 below where `pane` is standing. Hits and progress go to the dialog
   * in batches a few times a second; the last message carries `done`.
   */
  private startSearch(pane: PaneId, id: string, query: SearchQuery): void {
    const stop = new AbortController();
    this.searches.set(id, stop);
    const provider = this.provider(pane);
    const root = this.panes[pane].location;
    const started = performance.now();
    log.info(`Search below ${root.kind}:${root.profile || '-'}:${root.path || '/'}`
      + ` for names '${query.names || '*'}'${query.text ? ` containing '${query.text}'` : ''}`);

    let hits: SearchHitDto[] = [];
    let found = 0;
    let progress = { folders: 0, files: 0, current: '' };
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      timer = undefined;
      const batch = hits;
      hits = [];
      this.post({ type: 'search', id, hits: batch, ...progress });
    };
    const soon = () => { timer ??= setTimeout(flush, SEARCH_REPORT_MS); };

    void search({
      provider, root, query,
      // Read as F3 reads, except that the binary list decides what is text:
      // a search for words in a load module finds nothing worth showing.
      options: { ...settings.transferDefaults(), mode: 'auto' },
      binaryExtensions: settings.binaryExtensions(),
      concurrency: settings.concurrency(),
      signal: stop.signal,
      onHit: (hit) => { hits.push(hit); found += 1; soon(); },
      onProgress: (folders, files, current) => { progress = { folders, files, current }; soon(); },
    }).catch((err: unknown) => ({ stopped: false, notes: [describeError(err).message] }))
      .then((outcome) => {
        clearTimeout(timer);
        this.searches.delete(id);
        this.post({ type: 'search', id, hits, folders: progress.folders, files: progress.files, done: outcome });
        log.info(`Search ${outcome.stopped ? 'stopped' : 'finished'}: ${found} found in ${progress.folders} folders`
          + ` and ${progress.files} files, ${Math.round(performance.now() - started)} ms`,
        outcome.notes.join('\n') || undefined);
      });
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
    this.goTo(other, { kind: 'jes', profile: this.panes[pane].location.profile, path: '' });
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
    if (provider.describe(location, entry).offline) {
      throw new UserFacingError(
        `'${entry.dto.name}' is migrated — recall it first.`,
        'Enter on it offers to, and so does `recall` on the command line.',
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
        this.goTo(pane, provider.resolve
          ? provider.resolve(from, argument)
          : { ...from, path: argument });
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
      case 'recall':
      case 'hrecall': {
        // TSO's name for it works too, since that is what the fingers know.
        const entry = this.panes[pane].entries.find(
          (e) => e.dto.name.toUpperCase() === argument.replace(/'/g, '').toUpperCase(),
        );
        if (!entry) throw new Error(`'${argument}' is not in the pane.`);
        const provider = this.provider(pane);
        if (!provider.describe(this.panes[pane].location, entry).offline) {
          throw new UserFacingError(`${entry.dto.name} is not migrated.`);
        }
        this.recallInBackground(pane, entry);
        return;
      }
      default:
        throw new Error(`Unknown command '${verb}'. Known commands: cd, submit, recall, refresh.`);
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
    // Everything the user is told went wrong, with the detail the status bar
    // only shows on hover — the log is where it is still there afterwards.
    if (message.type === 'error') log.error(message.message, message.detail);
    void this.panel.webview.postMessage(message);
  }

  private html(): string {
    const webview = this.panel.webview;
    const asset = (file: string) => webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', file),
    );
    const nonce = nonceOf(16);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';
  style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};
  img-src ${webview.cspSource};">
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


/**
 * The overwrite question. With more than one thing being copied, it also
 * offers to answer for the rest — a folder of 200 files that are mostly there
 * already is otherwise 200 dialogs.
 */
async function askConflict(name: string, where: string, many: boolean): Promise<ConflictAnswer | undefined> {
  const choices = many ? ['Overwrite', 'Skip', 'Overwrite All', 'Skip All'] : ['Overwrite', 'Skip'];
  const answer = await vscode.window.showWarningMessage(
    `${name} already exists in ${where}.`, { modal: true }, ...choices,
  );
  switch (answer) {
    case 'Overwrite': return { answer: 'overwrite', all: false };
    case 'Skip': return { answer: 'skip', all: false };
    case 'Overwrite All': return { answer: 'overwrite', all: true };
    case 'Skip All': return { answer: 'skip', all: true };
    default: return undefined;
  }
}

/**
 * A CSP nonce has to be unguessable, so it comes from the CSPRNG rather than
 * from `Math.random()` — which is seeded predictably and is not a security
 * primitive. 16 bytes is the amount the CSP spec asks for; base64 keeps it to
 * source-expression characters.
 */
function nonceOf(bytes: number): string {
  return randomBytes(bytes).toString('base64');
}

export function transferDefaults(): TransferOptions {
  return settings.transferDefaults();
}

export type { TransferJobDto };
