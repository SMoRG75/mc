import type {
  HostMessage, PaneId, PaneLocation, ProfileDto, TransferJobDto, TransferOptions,
} from '../src/shared/protocol';
import { Pane } from './pane';
import { Dispatcher, type Action } from './keymap';
import { datasetDialog, modalOpen, prompt, transferDialog } from './dialogs';
import { send } from './vscode';

const FKEYS: [string, string][] = [
  ['F3', 'View'], ['F4', 'Edit'], ['F5', 'Copy'], ['F6', 'Rename'],
  ['F7', 'Create'], ['F8', 'Delete'], ['F9', 'Submit'], ['F10', 'Compare'],
];

class App {
  private readonly panes: Record<PaneId, Pane>;
  private active: PaneId = 'left';
  private defaults: TransferOptions = {
    mode: 'auto', codepage: 'IBM-1140', longLines: 'abort', onConflict: 'ask', destination: '*',
  };
  private profiles: ProfileDto[] = [];
  private filterMode = false;
  private filterText = '';

  private readonly commandInput = document.createElement('input');
  private readonly promptLabel = document.createElement('span');
  private readonly statusBar = document.createElement('div');
  private readonly dispatcher = new Dispatcher((action) => void this.run(action));

  constructor(root: HTMLElement) {
    this.panes = {
      left: this.makePane('left'),
      right: this.makePane('right'),
    };

    const panes = document.createElement('div');
    panes.className = 'panes';
    panes.append(this.panes.left.element, this.panes.right.element);

    root.append(panes, this.commandLine(), this.fkeyBar(), this.statusBar);
    this.statusBar.className = 'statusbar';
    this.setActive('left');

    window.addEventListener('keydown', (event) => {
      // A dialog handles its own keys, including the Escape that closes it.
      if (modalOpen()) return;
      if (this.filterMode) return this.handleFilterKey(event);
      if (document.activeElement === this.commandInput && event.key !== 'Escape') return;
      this.dispatcher.fromEvent(event);
    });
    window.addEventListener('message', (event: MessageEvent<HostMessage>) => this.receive(event.data));
    // VS Code focuses the webview's iframe when the panel opens or is tabbed
    // back to, but leaves the focus inside it on <body> — where keydown does
    // fire, but a click is still needed after any dialog or editor took it.
    window.addEventListener('focus', () => this.focusActivePane());
    this.focusActivePane();
    send({ type: 'ready' });
  }

  private makePane(id: PaneId): Pane {
    return new Pane(id, {
      activate: (entry) => {
        this.setActive(id);
        send(entry.kind === 'up'
          ? { type: 'up', pane: id }
          : { type: 'enter', pane: id, entryId: entry.id });
      },
      focus: (pane) => this.setActive(pane),
      navigate: (location: PaneLocation) => send({ type: 'navigate', pane: id, location }),
    });
  }

  private commandLine(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'cmdline';
    this.promptLabel.className = 'prompt';
    this.commandInput.spellcheck = false;
    this.commandInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        send({ type: 'commandLine', pane: this.active, line: this.commandInput.value });
        this.commandInput.value = '';
      } else if (event.key === 'Escape') {
        this.commandInput.blur();
      }
    });
    row.append(this.promptLabel, this.commandInput);
    return row;
  }

  private fkeyBar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'fkeys';
    bar.append(...FKEYS.map(([key, label]) => {
      const button = document.createElement('button');
      button.className = 'fk';
      button.innerHTML = `<b>${key}</b>${label}`;
      // Clicking the bar must not take the keyboard away from the pane —
      // otherwise the next Enter presses the button again.
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => this.dispatcher.fromHost(key));
      return button;
    }));
    return bar;
  }

  /* ---------------------------------------------------------------- */

  private receive(message: HostMessage): void {
    switch (message.type) {
      case 'init':
        this.defaults = message.defaults;
        this.profiles = message.profiles;
        for (const pane of ['left', 'right'] as PaneId[]) this.panes[pane].setProfiles(this.profiles);
        break;
      case 'profiles':
        this.profiles = message.profiles;
        for (const pane of ['left', 'right'] as PaneId[]) this.panes[pane].setProfiles(this.profiles);
        break;
      case 'listing':
        this.panes[message.pane].setListing(message.listing);
        this.updatePrompt();
        break;
      case 'busy':
        this.panes[message.pane].setBusy(message.busy);
        break;
      case 'error':
        if (message.pane) this.panes[message.pane].setError(message.message, message.detail);
        break;
      case 'transfers':
        this.renderTransfers(message.jobs);
        break;
      case 'key':
        // VS Code keeps forwarding F-keys while a dialog is up; F6 on top of an
        // open rename dialog must not open a second one.
        if (!modalOpen()) this.dispatcher.fromHost(message.key);
        break;
      case 'focus':
        this.focusActivePane();
        break;
    }
  }

  private renderTransfers(jobs: TransferJobDto[]): void {
    const running = jobs.filter((job) => job.state === 'running' || job.state === 'queued');
    const failed = jobs.filter((job) => job.state === 'failed');
    this.statusBar.replaceChildren();

    if (running.length > 0) {
      const first = running[0]!;
      const label = document.createElement('span');
      label.textContent = first.label;
      const bar = document.createElement('span');
      bar.className = 'prog';
      const fill = document.createElement('i');
      fill.style.width = `${Math.round((first.progress ?? 0) * 100)}%`;
      bar.append(fill);
      const count = document.createElement('span');
      count.textContent = `${jobs.length - running.length + 1} af ${jobs.length}`;
      this.statusBar.append(label, bar, count);
    }
    for (const job of failed) {
      const error = document.createElement('span');
      error.className = 'error';
      error.textContent = `${job.label}: ${job.error ?? 'fejlede'}`;
      this.statusBar.append(error);
    }
  }

  /* ---------------------------------------------------------------- */

  private async run(action: Action): Promise<void> {
    const pane = this.panes[this.active];
    const other: PaneId = this.active === 'left' ? 'right' : 'left';

    switch (action) {
      case 'up': return pane.moveCursor(-1);
      case 'down': return pane.moveCursor(1);
      case 'pageUp': return pane.moveCursor(-pane.pageSize);
      case 'pageDown': return pane.moveCursor(pane.pageSize);
      case 'home': return pane.setCursor(0);
      case 'end': return pane.setCursor(pane.entryCount - 1);
      case 'switchPane': return this.setActive(other);
      case 'mark': return pane.toggleMark();
      case 'markAll': return pane.markAll(false);
      case 'invertMark': return pane.markAll(true);
      case 'refresh': return send({ type: 'refresh', pane: this.active });
      case 'parent': return send({ type: 'up', pane: this.active });
      case 'cancel': return this.exitFilter();
      case 'nextView': {
        const location = pane.nextView;
        if (location) send({ type: 'navigate', pane: this.active, location });
        return;
      }
      case 'quickFilter': return this.enterFilter();
      case 'focusCommandLine': return this.commandInput.focus();

      case 'enter': {
        const entry = pane.cursorEntry;
        if (!entry) return;
        return send(entry.kind === 'up'
          ? { type: 'up', pane: this.active }
          : { type: 'enter', pane: this.active, entryId: entry.id });
      }

      case 'view':
      case 'edit': {
        const entry = pane.cursorEntry;
        if (!entry || entry.kind === 'up') return;
        return send({
          type: 'open', pane: this.active, entryId: entry.id,
          mode: action === 'view' ? 'view' : 'edit',
        });
      }

      case 'copy':
      case 'copyNoDialog': {
        const ids = pane.selectionIds;
        if (ids.length === 0) return;
        const target = this.panes[other].location;
        const options = action === 'copyNoDialog'
          ? this.defaults
          : await transferDialog(
            this.defaults, ids.length,
            target?.profile || 'local disk', target?.kind === 'ds' ? target.path : '',
          );
        if (!options) return;
        return send({ type: 'copy', from: this.active, entryIds: ids, options });
      }

      case 'rename': {
        const entry = pane.cursorEntry;
        if (!entry || entry.kind === 'up') return;
        // A whole dataset gets the same TSO reading as an allocation, so the
        // suggestion is quoted: it is already the complete name.
        const location = pane.location;
        const dataset = location?.kind === 'ds' && isDatasetFilter(location.path);
        const name = await prompt(
          `Rename ${entry.name}`,
          dataset ? `'${entry.name}'` : entry.name,
          dataset ? 'Without apostrophes your user id goes in front as the first qualifier.' : '',
        );
        if (!name) return;
        return send({ type: 'rename', pane: this.active, entryId: entry.id, newName: name });
      }

      case 'create': {
        const location = pane.location;
        if (!location || pane.capabilities?.create === false) return;

        // F7 means three different things, and only one of them needs a form:
        // allocating a dataset is a decision about RECFM, LRECL and space that
        // cannot be undone afterwards. A member or a directory is just a name.
        if (location.kind === 'ds' && isDatasetFilter(location.path)) {
          const allocation = await datasetDialog(highLevelQualifier(location.path));
          if (!allocation) return;
          return send({
            type: 'create', pane: this.active,
            name: allocation.name, dataset: allocation.spec,
          });
        }
        const name = await prompt(
          location.kind === 'ds' ? 'Name of the new member' : 'Name of the new folder',
        );
        if (!name) return;
        return send({ type: 'create', pane: this.active, name });
      }

      case 'delete': {
        const ids = pane.selectionIds;
        if (ids.length > 0) send({ type: 'delete', pane: this.active, entryIds: ids });
        return;
      }

      case 'submit': {
        const ids = pane.selectionIds;
        if (ids.length > 0) send({ type: 'submit', pane: this.active, entryIds: ids });
        return;
      }

      case 'compare': {
        const left = this.panes.left.cursorEntry;
        const right = this.panes.right.cursorEntry;
        if (left && right && left.kind !== 'up' && right.kind !== 'up') {
          send({ type: 'compare', leftEntryId: left.id, rightEntryId: right.id });
        }
        return;
      }

      case 'swapPanes': {
        const left = this.panes.left.location;
        const right = this.panes.right.location;
        if (left && right) {
          send({ type: 'navigate', pane: 'left', location: right });
          send({ type: 'navigate', pane: 'right', location: left });
        }
        return;
      }
    }
  }

  /* ---- quick filter ------------------------------------------------ */

  private enterFilter(): void {
    this.filterMode = true;
    this.filterText = '';
    document.body.classList.add('filtering');
  }

  private exitFilter(): void {
    if (!this.filterMode) return;
    this.filterMode = false;
    this.filterText = '';
    document.body.classList.remove('filtering');
    this.panes[this.active].setFilter('');
  }

  private handleFilterKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') return this.exitFilter();
    if (event.key === 'Enter') {
      this.filterMode = false;
      document.body.classList.remove('filtering');
      return;
    }
    if (event.key === 'Backspace') this.filterText = this.filterText.slice(0, -1);
    else if (event.key.length === 1) this.filterText += event.key;
    else return;
    event.preventDefault();
    this.panes[this.active].setFilter(this.filterText);
  }

  private setActive(pane: PaneId): void {
    this.active = pane;
    this.panes.left.setActive(pane === 'left');
    this.panes.right.setActive(pane === 'right');
    this.updatePrompt();
    this.focusActivePane();
  }

  /**
   * Hands the keyboard to the active pane — unless the user is already typing
   * somewhere on purpose, in which case taking focus would be the bug.
   */
  private focusActivePane(): void {
    if (modalOpen() || document.activeElement === this.commandInput) return;
    this.panes[this.active].focus();
  }

  private updatePrompt(): void {
    const location = this.panes[this.active].location;
    if (!location) return;
    const profile = location.profile || (location.kind === 'local' ? 'local' : 'default');
    this.promptLabel.textContent = `${profile}:${location.path || '/'}>`;
  }
}

/** Same rule as the provider's: a wildcard or an empty path is a filter. */
function isDatasetFilter(path: string): boolean {
  return path === '' || path.includes('*') || path.includes('%');
}

/**
 * What to put in the name field.
 *
 * The filter the pane is showing is nearly always the prefix the new dataset
 * belongs under, so `IBMUSER.PROD.*` offers `IBMUSER.PROD.` and the user types
 * the last qualifier. The opening apostrophe is TSO's: without it the host puts
 * the user's own high-level qualifier in front, which is right when the field is
 * empty and wrong when it already carries a full prefix.
 */
function highLevelQualifier(filter: string): string {
  const stem = filter.replace(/\.?[*%][^.]*$/, '').replace(/\.$/, '');
  return stem ? `'${stem}.` : '';
}

new App(document.getElementById('app') as HTMLElement);
