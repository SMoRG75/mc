import type { HostMessage, PaneId, SearchHitDto, SearchQuery } from '../src/shared/protocol';
import { escapeHtml, modal } from './dialogs';
import { send } from './vscode';

type SearchUpdate = Extract<HostMessage, { type: 'search' }>;

/** The open dialog's handler for the host's answers; there is only ever one. */
let listener: ((update: SearchUpdate) => void) | undefined;

/** Hands a message from the host to the search dialog, if one is open. */
export function searchUpdate(update: SearchUpdate): void {
  listener?.(update);
}

/**
 * Alt+F7: find files by name, and by text inside them, below where the pane is.
 *
 * Hits appear as they are found, while the search goes on; Enter on one — or
 * a double click — closes the dialog and shows it in the pane. Closing it any
 * other way stops a search still running. `remember` gets the query each time
 * one starts, so the next Alt+F7 opens with it.
 */
export function searchDialog(
  pane: PaneId, where: string, last: SearchQuery, remember: (query: SearchQuery) => void,
): Promise<SearchHitDto | undefined> {
  let running: string | undefined;
  const stop = () => {
    if (running) send({ type: 'stopSearch', id: running });
    running = undefined;
  };

  return modal<SearchHitDto>((resolve) => {
    const box = document.createElement('form');
    box.classList.add('search');
    box.innerHTML = `
      <div class="mh">Find below ${escapeHtml(where)}<span>Alt+F7</span></div>
      <div class="mb">
        <label class="row"><span>Names</span>
          <input class="field" name="names" spellcheck="false" autocapitalize="off"
                 placeholder="*.jcl;*.cbl — empty for every name"></label>
        <label class="row"><span>Containing</span>
          <input class="field" name="text" spellcheck="false" autocapitalize="off"
                 placeholder="empty to search by name alone"></label>
        <div class="row"><span></span>
          <label class="check"><input type="checkbox" name="caseSensitive"> Match case</label>
          <label class="check"><input type="checkbox" name="subfolders"> Subfolders, libraries and jobs</label>
        </div>
        <div class="hits" tabindex="0" role="listbox" aria-label="Found"></div>
        <p class="hint flush status">A name without * or ? is found anywhere in a name.</p>
        <pre class="notes hidden"></pre>
      </div>
      <div class="mf">
        <button type="button" class="btn" data-close>Close</button>
        <button type="button" class="btn" data-go disabled>Go to</button>
        <button type="submit" class="btn pri" data-run>Search</button>
      </div>`;

    const field = (name: string) => box.querySelector(`[name="${name}"]`) as HTMLInputElement;
    const list = box.querySelector('.hits') as HTMLElement;
    const status = box.querySelector('.status') as HTMLElement;
    const notes = box.querySelector('.notes') as HTMLElement;
    const run = box.querySelector('[data-run]') as HTMLButtonElement;
    const go = box.querySelector('[data-go]') as HTMLButtonElement;

    field('names').value = last.names;
    field('text').value = last.text;
    field('caseSensitive').checked = last.caseSensitive;
    field('subfolders').checked = last.subfolders;

    let hits: SearchHitDto[] = [];
    let selected = -1;

    const select = (index: number) => {
      if (hits.length === 0) return;
      selected = Math.max(0, Math.min(hits.length - 1, index));
      for (const [i, row] of [...list.children].entries()) row.classList.toggle('sel', i === selected);
      list.children[selected]?.scrollIntoView({ block: 'nearest' });
      go.disabled = false;
    };
    const choose = () => {
      const hit = hits[selected];
      if (hit) resolve(hit);
    };

    const start = () => {
      stop();
      const query: SearchQuery = {
        names: field('names').value.trim(),
        text: field('text').value,
        caseSensitive: field('caseSensitive').checked,
        subfolders: field('subfolders').checked,
      };
      remember(query);
      hits = [];
      selected = -1;
      list.replaceChildren();
      notes.classList.add('hidden');
      go.disabled = true;
      running = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      run.textContent = 'Stop';
      status.textContent = 'Searching…';
      send({ type: 'search', pane, id: running, query });
    };

    listener = (update) => {
      if (update.id !== running) return;
      for (const hit of update.hits) {
        hits.push(hit);
        list.append(row(hit, hits.length - 1));
      }
      if (selected < 0 && hits.length > 0) select(0);
      const found = `${hits.length} found · ${update.folders} folder${update.folders === 1 ? '' : 's'}`
        + ` and ${update.files} file${update.files === 1 ? '' : 's'} searched`;
      if (!update.done) {
        status.textContent = update.current ? `${found} · ${update.current}` : found;
        return;
      }
      running = undefined;
      run.textContent = 'Search';
      status.textContent = `${found}${update.done.stopped ? ' · stopped' : ''}`;
      if (update.done.notes.length > 0) {
        notes.textContent = update.done.notes.join('\n');
        notes.classList.remove('hidden');
      }
    };

    const row = (hit: SearchHitDto, index: number): HTMLElement => {
      const element = document.createElement('div');
      element.className = 'hit';
      element.setAttribute('role', 'option');
      element.innerHTML = `
        <span class="hn">${escapeHtml(hit.name)}${hit.kind === 'dir' ? '/' : ''}</span>
        <span class="hw">${escapeHtml(hit.where)}</span>
        ${hit.line !== undefined ? `<span class="hl">${hit.line}: ${escapeHtml(hit.text ?? '')}</span>` : ''}`;
      element.addEventListener('mousedown', () => select(index));
      element.addEventListener('dblclick', choose);
      return element;
    };

    box.addEventListener('submit', (event) => {
      event.preventDefault();
      if (running) {
        stop();
        run.textContent = 'Search';
      } else {
        start();
      }
    });
    list.addEventListener('keydown', (event) => {
      const moves: Record<string, number> = {
        ArrowDown: selected + 1, ArrowUp: selected - 1,
        PageDown: selected + 10, PageUp: selected - 10,
        Home: 0, End: hits.length - 1,
      };
      if (event.key in moves) {
        event.preventDefault();
        select(moves[event.key]!);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        choose();
      }
    });
    go.addEventListener('click', choose);
    box.querySelector('[data-close]')?.addEventListener('click', () => resolve(undefined));
    return box;
  }, () => {
    stop();
    listener = undefined;
  });
}
