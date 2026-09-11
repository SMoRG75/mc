import type {
  DatasetSpec, FavouriteDto, FilterDto, PaneLocation, TransferOptions,
} from '../src/shared/protocol';

let openCount = 0;

/**
 * True while a dialog is up.
 *
 * The app listens for keys on `window` and calls preventDefault on everything
 * the keymap claims — Enter, Tab, Backspace, Space. A focused text field inside
 * a dialog would never see them, so the keymap has to stand down while a dialog
 * owns the keyboard.
 */
export function modalOpen(): boolean {
  return openCount > 0;
}

/** Builds a modal, resolves with its result, and always cleans itself up. */
function modal<T>(
  build: (resolve: (value: T | undefined) => void) => HTMLElement,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    // Where the keyboard was, so closing the dialog gives it back to the pane
    // instead of dropping focus on <body>.
    const returnFocus = document.activeElement as HTMLElement | null;
    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    let done = false;
    const finish = (value: T | undefined) => {
      if (done) return;
      done = true;
      openCount -= 1;
      backdrop.remove();
      box.remove();
      returnFocus?.focus?.({ preventScroll: true });
      resolve(value);
    };
    const box = build(finish);
    box.classList.add('modal');
    backdrop.addEventListener('mousedown', () => finish(undefined));
    openCount += 1;
    document.body.append(backdrop, box);
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') finish(undefined);
    });
    (box.querySelector('input, button') as HTMLElement | null)?.focus();
  });
}

export function prompt(title: string, value = '', hint = ''): Promise<string | undefined> {
  return modal<string>((resolve) => {
    const box = document.createElement('form');
    box.innerHTML = `
      <div class="mh">${escapeHtml(title)}</div>
      <div class="mb"><input class="field" type="text" spellcheck="false">
        ${hint ? `<p class="hint flush">${escapeHtml(hint)}</p>` : ''}</div>
      <div class="mf">
        <button type="button" class="btn" data-cancel>Cancel</button>
        <button type="submit" class="btn pri">OK</button>
      </div>`;
    const input = box.querySelector('input') as HTMLInputElement;
    input.value = value;
    box.querySelector('[data-cancel]')?.addEventListener('click', () => resolve(undefined));
    box.addEventListener('submit', (event) => {
      event.preventDefault();
      resolve(input.value.trim() || undefined);
    });
    return box;
  });
}

export function confirm(title: string, detail: string): Promise<boolean | undefined> {
  return modal<boolean>((resolve) => {
    const box = document.createElement('div');
    box.innerHTML = `
      <div class="mh">${escapeHtml(title)}</div>
      <div class="mb"><p>${escapeHtml(detail)}</p></div>
      <div class="mf">
        <button class="btn" data-no>Cancel</button>
        <button class="btn pri" data-yes>OK</button>
      </div>`;
    box.querySelector('[data-no]')?.addEventListener('click', () => resolve(undefined));
    box.querySelector('[data-yes]')?.addEventListener('click', () => resolve(true));
    return box;
  });
}

/**
 * Ctrl+F: the pane's filter as fields.
 *
 * Entirely driven by what the provider declared, so this one dialog is the JES
 * owner/prefix form without knowing that is what it is. The values come back
 * keyed by the same field ids.
 */
export function filterDialog(spec: FilterDto): Promise<Record<string, string> | undefined> {
  return modal<Record<string, string>>((resolve) => {
    const box = document.createElement('form');
    box.innerHTML = `
      <div class="mh">${escapeHtml(spec.title)}<span>Ctrl+F</span></div>
      <div class="mb">
        ${spec.fields.map((field) => `
          <label class="row"><span>${escapeHtml(field.label)}</span>
            ${field.choices
    ? `<select class="field" name="${escapeHtml(field.id)}">${field.choices.map((choice) => `
                  <option value="${escapeHtml(choice.value)}"${choice.value === field.value ? ' selected' : ''}>
                    ${escapeHtml(choice.label)}</option>`).join('')}</select>`
    : `<input class="field" name="${escapeHtml(field.id)}" spellcheck="false"
                 autocapitalize="off" value="${escapeHtml(field.value)}">`}</label>
          ${field.hint ? `<p class="hint">${escapeHtml(field.hint)}</p>` : ''}`).join('')}
      </div>
      <div class="mf">
        <button type="button" class="btn" data-cancel>Cancel</button>
        <button type="submit" class="btn pri">Show</button>
      </div>`;

    const form = box as HTMLFormElement;
    box.querySelector('[data-cancel]')?.addEventListener('click', () => resolve(undefined));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = new FormData(form);
      resolve(Object.fromEntries(
        spec.fields.map((field) => [field.id, String(data.get(field.id) ?? field.value)]),
      ));
    });
    // The field is nearly always being replaced rather than edited.
    queueMicrotask(() => (box.querySelector('input') as HTMLInputElement | null)?.select());
    return box;
  });
}

/** What Ctrl+D was closed with. */
export type FavouriteChoice =
  | { type: 'go'; location: PaneLocation }
  | { type: 'save'; name: string }
  | { type: 'remove'; name: string };

/**
 * Ctrl+D: the saved views, and the chance to add the one on screen.
 *
 * Every button closes the dialog. Removing two of them is therefore two trips —
 * which is the right trade for a list that is read far more often than it is
 * edited, and keeps the dialog free of any state of its own.
 */
export function favouritesDialog(
  favourites: FavouriteDto[], suggestedName: string,
): Promise<FavouriteChoice | undefined> {
  return modal<FavouriteChoice>((resolve) => {
    const box = document.createElement('form');
    box.className = 'favs';
    box.innerHTML = `
      <div class="mh">Saved views<span>Ctrl+D</span></div>
      <div class="mb">
        ${favourites.length === 0
    ? '<p class="hint flush">Nothing saved yet. Name what the pane is showing below and it turns up here — and as a tab in the pane header whenever you are in that world.</p>'
    : `<div class="favlist">${favourites.map((favourite, index) => `
            <div class="fav">
              <button type="button" class="favgo" data-go="${index}">
                <b>${escapeHtml(favourite.name)}</b>
                <i>${escapeHtml(describeLocation(favourite.location))}</i>
              </button>
              <button type="button" class="favdel" data-remove="${index}" title="Remove">✕</button>
            </div>`).join('')}</div>`}
        <label class="row"><span>Save this view as</span>
          <input class="field" name="name" spellcheck="false" placeholder="Name"></label>
        <p class="hint">Saving over a name that is taken replaces it.</p>
      </div>
      <div class="mf">
        <button type="button" class="btn" data-cancel>Close</button>
        <button type="submit" class="btn pri">Save</button>
      </div>`;

    const form = box as HTMLFormElement;
    const input = form.elements.namedItem('name') as HTMLInputElement;
    input.value = suggestedName;

    for (const button of box.querySelectorAll('[data-go]')) {
      button.addEventListener('click', () => {
        const favourite = favourites[Number((button as HTMLElement).dataset.go)];
        if (favourite) resolve({ type: 'go', location: favourite.location });
      });
    }
    for (const button of box.querySelectorAll('[data-remove]')) {
      button.addEventListener('click', () => {
        const favourite = favourites[Number((button as HTMLElement).dataset.remove)];
        if (favourite) resolve({ type: 'remove', name: favourite.name });
      });
    }
    box.querySelector('[data-cancel]')?.addEventListener('click', () => resolve(undefined));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = input.value.trim();
      resolve(name ? { type: 'save', name } : undefined);
    });
    // The suggested name says exactly what is being saved, and is nearly always
    // worth shortening — so it is selected, not just focused.
    queueMicrotask(() => input.select());
    return box;
  });
}

/** `LPAR1 · JES · owner=SANJ` — enough to tell two saved views apart. */
function describeLocation(location: PaneLocation): string {
  const world = { local: 'Local', ds: 'DS', uss: 'USS', jes: 'JES' }[location.kind];
  const where = location.profile || (location.kind === 'local' ? 'this PC' : 'default profile');
  return `${where} · ${world} · ${location.path || '(top)'}`;
}

/**
 * The F5 dialog. Every field is pre-filled from the target's own attributes, so
 * the common case is Enter — but the choices stay visible, because a wrong
 * transfer mode or a truncated line is not something the user finds out about
 * until much later.
 */
export function transferDialog(
  defaults: TransferOptions, codepages: string[], count: number,
  targetLabel: string, targetPath: string,
): Promise<TransferOptions | undefined> {
  return modal<TransferOptions>((resolve) => {
    const box = document.createElement('form');
    box.innerHTML = `
      <div class="mh">Copy ${count} ${count === 1 ? 'file' : 'files'} to ${escapeHtml(targetLabel)}<span>F5</span></div>
      <div class="mb">
        <label class="row"><span>Destination</span>
          <input class="field" name="destination" spellcheck="false"></label>
        <div class="row"><span>Transfer</span>${radios('mode', [
          ['text', 'Text'], ['binary', 'Binary'], ['auto', 'Auto (by file type)'],
        ], defaults.mode)}</div>
        <p class="hint">Text converts line endings and character set; binary sends byte for byte.</p>
        <label class="row"><span>Codepage</span>
          <select class="field" name="codepage">${codepageOptions(codepages, defaults.codepage)}</select></label>
        <p class="hint">Kept as the default for next time. The list itself is the <code>mc.transfer.codepages</code> setting.</p>
        <div class="row"><span>Long lines</span>${radios('longLines', [
          ['wrap', 'Wrap'], ['truncate', 'Truncate'], ['abort', 'Abort'],
        ], defaults.longLines)}</div>
        <div class="row"><span>On conflict</span>${radios('onConflict', [
          ['ask', 'Ask'], ['overwrite', 'Overwrite'], ['skip', 'Skip'],
        ], defaults.onConflict)}</div>
      </div>
      <div class="mf">
        <button type="button" class="btn" data-cancel>Cancel</button>
        <button type="submit" class="btn pri">Copy</button>
      </div>`;

    const form = box as HTMLFormElement;
    (form.elements.namedItem('destination') as HTMLInputElement).value =
      targetPath ? `${targetPath}(*)` : defaults.destination;

    box.querySelector('[data-cancel]')?.addEventListener('click', () => resolve(undefined));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = new FormData(form);
      resolve({
        // The destination field is for the operator's eyes; the pane location is
        // what actually decides where bytes land, so only the name pattern is used.
        destination: String(data.get('destination') ?? '*').replace(/^.*\(([^)]*)\)\s*$/, '$1') || '*',
        mode: data.get('mode') as TransferOptions['mode'],
        codepage: String(data.get('codepage') ?? defaults.codepage),
        longLines: data.get('longLines') as TransferOptions['longLines'],
        onConflict: data.get('onConflict') as TransferOptions['onConflict'],
      });
    });
    return box;
  });
}

/**
 * The F7 dialog on an MVS pane.
 *
 * The templates are the point: nearly every allocation is one of four shapes,
 * and the ones that are not are a `LIKE` of something that already exists. The
 * individual attributes stay on screen anyway, because a dataset's record format
 * cannot be changed afterwards — the mistake is only visible once something has
 * been written into it.
 */
export function datasetDialog(
  suggestedName: string,
): Promise<{ name: string; spec: DatasetSpec } | undefined> {
  return modal<{ name: string; spec: DatasetSpec }>((resolve) => {
    const box = document.createElement('form');
    box.className = 'alloc';
    box.innerHTML = `
      <div class="mh">Allocate dataset<span>F7</span></div>
      <div class="mb">
        <label class="row"><span>Name</span>
          <input class="field" name="name" spellcheck="false" autocapitalize="off"></label>
        <p class="hint">As in TSO: without a leading apostrophe your user id goes in front as the first qualifier.</p>
        <label class="row"><span>Like existing</span>
          <input class="field" name="like" spellcheck="false" placeholder="LIKE — empty: use the fields below"></label>
        <div class="attrs">
          <div class="row"><span>Type</span>${radios('type', [
            ['pdse', 'Library (PDS/E)'], ['pds', 'PDS'], ['seq', 'Sequential'],
          ], 'pdse')}</div>
          <label class="row"><span>Template</span>
            <select class="field" name="template">
              <option value="fb80">JCL and source — FB 80</option>
              <option value="fba133">Listing — FBA 133</option>
              <option value="vb255">Variable text — VB 255</option>
              <option value="load">Load module — U, PDS/E</option>
              <option value="custom">Custom values</option>
            </select></label>
          <div class="row"><span>Format</span>
            <input class="field num" name="recfm" spellcheck="false" title="RECFM">
            <span class="unit">LRECL</span><input class="field num" name="lrecl" inputmode="numeric">
            <span class="unit">BLKSIZE</span><input class="field num" name="blksize" inputmode="numeric" placeholder="auto">
          </div>
          <div class="row"><span>Space</span>
            <input class="field num" name="primary" inputmode="numeric" title="Primary">
            <span class="unit">+</span><input class="field num" name="secondary" inputmode="numeric" title="Secondary">
            ${radios('alcunit', [['TRK', 'Tracks'], ['CYL', 'Cylinders']], 'TRK')}
          </div>
          <label class="row dirblk"><span>Directory blocks</span>
            <input class="field num" name="dirblk" inputmode="numeric"></label>
        </div>
        <div class="row"><span>Volume / SMS</span>
          <input class="field mid" name="volser" spellcheck="false" placeholder="VOLSER">
          <input class="field mid" name="dataclass" spellcheck="false" placeholder="Data class">
          <input class="field mid" name="storclass" spellcheck="false" placeholder="Storage class">
        </div>
        <p class="hint">Empty fields are left to SMS and the system defaults — with a model as well.</p>
      </div>
      <div class="mf">
        <button type="button" class="btn" data-cancel>Cancel</button>
        <button type="submit" class="btn pri">Allocate</button>
      </div>`;

    const form = box as HTMLFormElement;
    const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
    const template = form.elements.namedItem('template') as HTMLSelectElement;
    const attrs = box.querySelector('.attrs') as HTMLElement;
    const dirblkRow = box.querySelector('.dirblk') as HTMLElement;

    field('name').value = suggestedName;
    field('primary').value = '10';
    field('secondary').value = '5';
    field('dirblk').value = '20';
    applyTemplate('fb80');
    syncType();

    function applyTemplate(id: string): void {
      const shape = TEMPLATES[id];
      if (!shape) return;
      field('recfm').value = shape.recfm;
      field('lrecl').value = String(shape.lrecl);
      field('blksize').value = shape.blksize ? String(shape.blksize) : '';
      if (shape.type) {
        (form.querySelector(`input[name="type"][value="${shape.type}"]`) as HTMLInputElement).checked = true;
        syncType();
      }
    }

    /** Directory blocks only exist on an old-style PDS; a PDS/E grows its own. */
    function syncType(): void {
      dirblkRow.classList.toggle('hidden', selectedType() !== 'pds');
    }

    function selectedType(): DatasetSpec['type'] {
      return (new FormData(form).get('type') as DatasetSpec['type']) ?? 'pdse';
    }

    box.addEventListener('change', (event) => {
      const target = event.target as HTMLInputElement;
      if (target === (template as HTMLElement)) applyTemplate(template.value);
      if (target.name === 'type') syncType();
    });
    // Touching a shape field by hand means the template no longer describes it.
    for (const name of ['recfm', 'lrecl', 'blksize']) {
      field(name).addEventListener('input', () => { template.value = 'custom'; });
    }
    // With a model dataset every attribute is inherited, so leaving the fields
    // editable would only suggest they still matter.
    field('like').addEventListener('input', () => {
      const modelled = field('like').value.trim().length > 0;
      attrs.classList.toggle('disabled', modelled);
      for (const element of attrs.querySelectorAll('input, select')) {
        (element as HTMLInputElement).disabled = modelled;
      }
    });

    box.querySelector('[data-cancel]')?.addEventListener('click', () => resolve(undefined));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const name = String(data.get('name') ?? '').trim();
      if (!name) return field('name').focus();
      const like = String(data.get('like') ?? '').trim();
      const type = selectedType();
      resolve({
        name,
        spec: {
          type,
          recfm: String(data.get('recfm') ?? 'FB').trim() || 'FB',
          lrecl: number(data.get('lrecl'), 80),
          blksize: number(data.get('blksize'), 0),
          primary: Math.max(1, number(data.get('primary'), 10)),
          secondary: number(data.get('secondary'), 0),
          alcunit: (data.get('alcunit') as DatasetSpec['alcunit']) ?? 'TRK',
          dirblk: type === 'pds' ? Math.max(1, number(data.get('dirblk'), 20)) : undefined,
          volser: text(data.get('volser')),
          dataclass: text(data.get('dataclass')),
          storclass: text(data.get('storclass')),
          like: like || undefined,
        },
      });
    });
    return box;
  });
}

/** The four shapes nearly every allocation actually is. */
const TEMPLATES: Record<string, { recfm: string; lrecl: number; blksize?: number; type?: DatasetSpec['type'] }> = {
  fb80: { recfm: 'FB', lrecl: 80 },
  fba133: { recfm: 'FBA', lrecl: 133 },
  vb255: { recfm: 'VB', lrecl: 255 },
  load: { recfm: 'U', lrecl: 0, blksize: 32760, type: 'pdse' },
  // 'custom' is deliberately absent: picking it leaves the fields alone.
};

function number(value: FormDataEntryValue | null, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function text(value: FormDataEntryValue | null): string | undefined {
  return String(value ?? '').trim() || undefined;
}

/**
 * The codepage picker.
 *
 * The countries are the whole point: `IBM-278` says nothing, "Finland, Sweden"
 * says everything. A codepage the list below does not know still shows up — the
 * offered set is a setting, and an installation may well have its own.
 */
function codepageOptions(codepages: string[], selected: string): string {
  return codepages.map((code) => {
    const country = COUNTRIES[code];
    const label = country ? `${code} — ${country}` : code;
    return `<option value="${escapeHtml(code)}"${code === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
}

/** The EBCDIC pages by the country that uses them; euro variants marked. */
const COUNTRIES: Record<string, string> = {
  'IBM-037': 'US, Canada, Netherlands, Brazil',
  'IBM-273': 'Germany, Austria',
  'IBM-277': 'Denmark, Norway',
  'IBM-278': 'Finland, Sweden',
  'IBM-280': 'Italy',
  'IBM-284': 'Spain, Latin America',
  'IBM-285': 'United Kingdom',
  'IBM-297': 'France',
  'IBM-500': 'International (Latin-1)',
  'IBM-870': 'Central Europe (Latin-2)',
  'IBM-871': 'Iceland',
  'IBM-1025': 'Cyrillic',
  'IBM-1026': 'Turkey',
  'IBM-1047': 'Latin-1 Open Systems (USS)',
  'IBM-1140': 'US, Canada, Netherlands, Brazil · euro',
  'IBM-1141': 'Germany, Austria · euro',
  'IBM-1142': 'Denmark, Norway · euro',
  'IBM-1143': 'Finland, Sweden · euro',
  'IBM-1144': 'Italy · euro',
  'IBM-1145': 'Spain, Latin America · euro',
  'IBM-1146': 'United Kingdom · euro',
  'IBM-1147': 'France · euro',
  'IBM-1148': 'International · euro',
  'IBM-1149': 'Iceland · euro',
  'ISO8859-1': 'ASCII, Latin-1',
  'UTF-8': 'Unicode',
};

function radios(name: string, options: [string, string][], selected: string): string {
  return `<span class="radio">${options.map(([value, label]) => `
    <label><input type="radio" name="${name}" value="${value}"${value === selected ? ' checked' : ''}>
    ${escapeHtml(label)}</label>`).join('')}</span>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c
  ));
}
