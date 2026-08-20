import type { TransferOptions } from '../src/shared/protocol';

/** Builds a modal, resolves with its result, and always cleans itself up. */
function modal<T>(
  build: (resolve: (value: T | undefined) => void) => HTMLElement,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    const finish = (value: T | undefined) => {
      backdrop.remove();
      box.remove();
      resolve(value);
    };
    const box = build(finish);
    box.classList.add('modal');
    backdrop.addEventListener('mousedown', () => finish(undefined));
    document.body.append(backdrop, box);
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') finish(undefined);
    });
    (box.querySelector('input, button') as HTMLElement | null)?.focus();
  });
}

export function prompt(title: string, value = ''): Promise<string | undefined> {
  return modal<string>((resolve) => {
    const box = document.createElement('form');
    box.innerHTML = `
      <div class="mh">${escapeHtml(title)}</div>
      <div class="mb"><input class="field" type="text" spellcheck="false"></div>
      <div class="mf">
        <button type="button" class="btn" data-cancel>Annullér</button>
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
        <button class="btn" data-no>Annullér</button>
        <button class="btn pri" data-yes>OK</button>
      </div>`;
    box.querySelector('[data-no]')?.addEventListener('click', () => resolve(undefined));
    box.querySelector('[data-yes]')?.addEventListener('click', () => resolve(true));
    return box;
  });
}

/**
 * The F5 dialog. Every field is pre-filled from the target's own attributes, so
 * the common case is Enter — but the choices stay visible, because a wrong
 * transfer mode or a truncated line is not something the user finds out about
 * until much later.
 */
export function transferDialog(
  defaults: TransferOptions, count: number, targetLabel: string, targetPath: string,
): Promise<TransferOptions | undefined> {
  return modal<TransferOptions>((resolve) => {
    const box = document.createElement('form');
    box.innerHTML = `
      <div class="mh">Kopiér ${count} ${count === 1 ? 'fil' : 'filer'} til ${escapeHtml(targetLabel)}<span>F5</span></div>
      <div class="mb">
        <label class="row"><span>Destination</span>
          <input class="field" name="destination" spellcheck="false"></label>
        <div class="row"><span>Overførsel</span>${radios('mode', [
          ['text', 'Tekst'], ['binary', 'Binær'], ['auto', 'Auto (efter filtype)'],
        ], defaults.mode)}</div>
        <p class="hint">Tekst konverterer linjeskift og tegnsæt; binær sender byte for byte.</p>
        <label class="row"><span>Codepage</span>
          <input class="field short" name="codepage" spellcheck="false"></label>
        <div class="row"><span>For lange linjer</span>${radios('longLines', [
          ['wrap', 'Ombryd'], ['truncate', 'Afkort'], ['abort', 'Afbryd'],
        ], defaults.longLines)}</div>
        <div class="row"><span>Ved konflikt</span>${radios('onConflict', [
          ['ask', 'Spørg'], ['overwrite', 'Overskriv'], ['skip', 'Spring over'],
        ], defaults.onConflict)}</div>
      </div>
      <div class="mf">
        <button type="button" class="btn" data-cancel>Annullér</button>
        <button type="submit" class="btn pri">Kopiér</button>
      </div>`;

    const form = box as HTMLFormElement;
    (form.elements.namedItem('destination') as HTMLInputElement).value =
      targetPath ? `${targetPath}(*)` : defaults.destination;
    (form.elements.namedItem('codepage') as HTMLInputElement).value = defaults.codepage;

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
