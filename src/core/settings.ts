import * as os from 'node:os';
import * as vscode from 'vscode';
import type { PaneLocation, TransferOptions } from '../shared/protocol';

/** Thin, typed reader over the `mc.*` configuration keys declared in package.json. */
export const settings = {
  get<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration('mc').get<T>(key) ?? fallback;
  },

  pageSize: (): number => settings.get('list.pageSize', 1000),
  binaryExtensions: (): readonly string[] => settings.get('transfer.binaryExtensions', []),
  concurrency: (): number => settings.get('transfer.concurrency', 3),
  confirmDelete: (): boolean => settings.get('confirmDelete', true),
  skipDialog: (): boolean => settings.get('transfer.skipDialog', false),
  jesOwner: (): string => settings.get('jes.owner', ''),
  dsDefaultFilter: (): string => settings.get('ds.defaultFilter', ''),
  jesRefreshSeconds: (): number => settings.get('jes.autoRefreshSeconds', 10),

  transferDefaults: (): TransferOptions => ({
    mode: settings.get('transfer.defaultMode', 'auto'),
    codepage: settings.get('transfer.codepage', 'IBM-1140'),
    longLines: settings.get('transfer.longLines', 'abort'),
    onConflict: 'ask',
    destination: '*',
  }),

  startLocation: (pane: 'left' | 'right'): PaneLocation => {
    const fallback: PaneLocation = pane === 'left'
      ? { kind: 'local', profile: '', path: defaultLocalPath() }
      : { kind: 'ds', profile: '', path: '' };
    const configured = settings.get<Partial<PaneLocation>>(`panes.${pane}`, {});
    return {
      kind: configured.kind ?? fallback.kind,
      profile: configured.profile ?? fallback.profile,
      path: configured.path || (configured.kind === 'local' ? defaultLocalPath() : fallback.path),
    };
  },
};

function defaultLocalPath(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
}
