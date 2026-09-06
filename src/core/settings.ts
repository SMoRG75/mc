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
    codepage: settings.get('transfer.codepage', 'IBM-277'),
    longLines: settings.get('transfer.longLines', 'abort'),
    onConflict: 'ask',
    destination: '*',
  }),

  /** The codepages the F5 dialog offers, current default always included. */
  codepages: (): string[] => {
    const configured = settings.get('transfer.codepages', CODEPAGES);
    const current = settings.transferDefaults().codepage;
    return configured.includes(current) ? configured : [current, ...configured];
  },

  /**
   * Writes the codepage the user picked back into the settings, so the choice
   * survives the session.
   *
   * Written to whichever scope already defines the key: updating the global
   * value while a workspace value shadows it would look like the pick was
   * silently ignored.
   */
  rememberCodepage: async (codepage: string): Promise<void> => {
    const config = vscode.workspace.getConfiguration('mc');
    const inspected = config.inspect<string>('transfer.codepage');
    if (!codepage || codepage === (config.get<string>('transfer.codepage') ?? '')) return;
    const target = inspected?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await config.update('transfer.codepage', codepage, target);
  },

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

/**
 * The codepages offered when `mc.transfer.codepages` says nothing.
 *
 * The national EBCDIC pages, their euro-sign successors, and the two ASCII
 * encodings a USS file is realistically tagged with. Anything missing is a
 * matter of adding it to the setting — this list only decides what the dialog
 * offers, never what is accepted.
 */
const CODEPAGES = [
  'IBM-037', 'IBM-273', 'IBM-277', 'IBM-278', 'IBM-280', 'IBM-284', 'IBM-285',
  'IBM-297', 'IBM-500', 'IBM-870', 'IBM-871', 'IBM-1025', 'IBM-1026', 'IBM-1047',
  'IBM-1140', 'IBM-1141', 'IBM-1142', 'IBM-1143', 'IBM-1144', 'IBM-1145',
  'IBM-1146', 'IBM-1147', 'IBM-1148', 'IBM-1149', 'ISO8859-1', 'UTF-8',
];

function defaultLocalPath(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
}
