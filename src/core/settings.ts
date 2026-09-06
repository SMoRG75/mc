import * as os from 'node:os';
import * as vscode from 'vscode';
import type { PaneId, PaneKind, PaneLocation, TransferOptions } from '../shared/protocol';

/**
 * Where the panes were pointing when they were last listed, and the `mc.panes.*`
 * values that was remembered against.
 *
 * `from` is what keeps the setting meaningful. Without it a remembered position
 * would shadow the setting for ever, and editing `mc.panes.left` would look
 * like it did nothing.
 */
export interface RememberedPane {
  location: PaneLocation;
  /** Entry id the cursor was on, when there was one worth coming back to. */
  cursor?: string;
}

export interface RememberedPanes {
  left: RememberedPane;
  right: RememberedPane;
  from: { left: PaneLocation; right: PaneLocation };
}

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
  ebcdicRecordLength: (): number => settings.get('view.ebcdicRecordLength', 80),

  /** What Shift+F3 decodes with — the transfer codepage unless one is set here. */
  ebcdicCodepage: (): string => (
    settings.get('view.ebcdicCodepage', '').trim() || settings.transferDefaults().codepage
  ),

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

  /** Where the pane opens when nothing has been remembered: the user's own setting. */
  configuredStartLocation: (pane: PaneId): PaneLocation => {
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

  /**
   * Where the pane opens.
   *
   * The place it was left is the answer nearly always: coming back to the PDS
   * or the USS directory you were working in is the whole point of a file
   * manager remembering anything. The setting wins only when it has been changed
   * since — that is the user saying where to start, and a position remembered
   * from before the change says nothing about it.
   */
  startLocation: (pane: PaneId, remembered?: RememberedPanes): PaneLocation => {
    const configured = settings.configuredStartLocation(pane);
    if (!remembered) return configured;
    return sameLocation(remembered.from[pane], configured) ? remembered[pane].location : configured;
  },
};

export function sameLocation(a: PaneLocation, b: PaneLocation): boolean {
  return a.kind === b.kind && a.profile === b.profile && a.path === b.path;
}

const KINDS: PaneKind[] = ['local', 'ds', 'uss', 'jes'];

function asLocation(value: unknown): PaneLocation | undefined {
  const raw = value as Partial<PaneLocation> | undefined;
  if (!raw || typeof raw.profile !== 'string' || typeof raw.path !== 'string') return undefined;
  return KINDS.includes(raw.kind as PaneKind)
    ? { kind: raw.kind as PaneKind, profile: raw.profile, path: raw.path }
    : undefined;
}

/**
 * Reads the remembered position back.
 *
 * Checked rather than cast: this outlives the version of the extension that
 * wrote it, and a pane pointed at a `kind` that no longer exists would fail on
 * the first listing with an error about the provider registry.
 */
export function asRememberedPanes(value: unknown): RememberedPanes | undefined {
  const raw = value as { left?: unknown; right?: unknown; from?: { left?: unknown; right?: unknown } };
  const left = asPane(raw?.left);
  const right = asPane(raw?.right);
  const fromLeft = asLocation(raw?.from?.left);
  const fromRight = asLocation(raw?.from?.right);
  if (!left || !right || !fromLeft || !fromRight) return undefined;
  return { left, right, from: { left: fromLeft, right: fromRight } };
}

function asPane(value: unknown): RememberedPane | undefined {
  const raw = value as { location?: unknown; cursor?: unknown } | undefined;
  const location = asLocation(raw?.location);
  if (!location) return undefined;
  return { location, cursor: typeof raw?.cursor === 'string' ? raw.cursor : undefined };
}

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
