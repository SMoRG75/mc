import { ProfileInfo, type AbstractSession, type IProfArgAttrs, type IProfAttrs } from '@zowe/imperative';
import { PROFILE_TYPES, type PaneKind, type ProfileDto } from '../shared/protocol';
import { UserFacingError } from '../core/errors';
import { log } from '../core/log';
import { Serializer } from '../core/serial';
import { rseHost } from './rse';
import { ZOSMF_API, type ZosHost } from './zosApi';

const ZOSMF = 'zosmf';

/** Every profile type some world can be on, each once. */
const KNOWN_TYPES = [...new Set(Object.values(PROFILE_TYPES).flat())];

/**
 * Owns the connection to z/OS.
 *
 * Everything goes through the user's existing Zowe team configuration
 * (`zowe.config.json` plus the secure credential store), which is the whole
 * reason for building on Zowe: certificates, MFA and the credential manager
 * are already solved there, and a profile the user can already use from the
 * CLI works here without being re-entered.
 */
export class SessionManager {
  private info?: Promise<ProfileInfo>;
  /**
   * Promises, not sessions: both panes ask for one as the panel opens, and
   * caching only the finished session let each of them build its own.
   */
  private readonly sessions = new Map<string, Promise<AbstractSession>>();
  private readonly hosts = new Map<string, Promise<ZosHost>>();
  private readonly fileServices = new Serializer();
  private readonly tsoCommands = new Serializer();
  private readonly consoleCommands = new Serializer();

  /**
   * Runs `call` — one z/OSMF file-service request that is not a transfer:
   * a listing, an attribute lookup, a create, rename or delete — once no other
   * such request for the same user on the same host is running.
   *
   * Two at once make z/OSMF start a second TSO address space for the user,
   * which cannot open the ISPF profile the first one holds and stops at
   * `ISPT036 Table in use`; see `Serializer`. Reading and writing content was
   * measured not to, so transfers stay parallel and do not go through here.
   */
  fileService<T>(session: AbstractSession, call: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.fileServices.run(userKey(session), call, signal);
  }

  /**
   * Runs `call` — one TSO command — once no other TSO command for the same
   * user on the same host is running.
   *
   * A queue of its own, not the file services': TSO was measured not to
   * collide with them, and a command must not wait behind a slow listing.
   * Two TSO commands at once were not measured, and something typed by hand
   * loses nothing by waiting for the one before — whose output then comes
   * first, as it was asked for first.
   */
  tso<T>(session: AbstractSession, call: () => Promise<T>): Promise<T> {
    return this.tsoCommands.run(userKey(session), call);
  }

  /**
   * Runs `call` — one console command, with the messages that come after it —
   * once no other console command for the same user on the same host is
   * running, so that each command's answer is written out in one piece.
   * Not behind the file services or TSO: the console is another service, with
   * no TSO address space of the user's in it.
   */
  console<T>(session: AbstractSession, call: () => Promise<T>): Promise<T> {
    return this.consoleCommands.run(userKey(session), call);
  }

  /** Re-reads zowe.config.json; call when the user edits their profiles. */
  invalidate(): void {
    log.debug('Zowe configuration changed; profiles will be read again.');
    this.info = undefined;
    this.sessions.clear();
    this.hosts.clear();
  }

  private profileInfo(): Promise<ProfileInfo> {
    if (!this.info) {
      this.info = (async () => {
        const info = new ProfileInfo('zowe');
        await info.readProfilesFromDisk();
        return info;
      })();
      // A failed read must not be cached, or the user has to reload the window.
      this.info.catch(() => { this.info = undefined; });
    }
    return this.info;
  }

  /** Every profile some world can be on; each pane picks out its own. */
  async profiles(): Promise<ProfileDto[]> {
    const info = await this.profileInfo();
    return KNOWN_TYPES.flatMap((type) => {
      const defaultProfile = info.getDefaultProfile(type);
      return info.getAllProfiles(type).map((attrs) => ({
        name: attrs.profName,
        type: attrs.profType,
        host: this.readArg(info, attrs, 'host'),
        isDefault: attrs.profName === defaultProfile?.profName,
      }));
    });
  }

  /**
   * Whether a pane in `kind` can be on `profileName`. The empty name — the
   * default — always can, and so can a name that is not there at all: that is
   * for the listing to say, the way it does today.
   */
  async fits(kind: PaneKind, profileName: string): Promise<boolean> {
    if (!profileName) return true;
    const profile = (await this.profiles()).find((p) => p.name === profileName);
    return !profile || PROFILE_TYPES[kind].includes(profile.type);
  }

  /**
   * The way into z/OS for a pane in `kind` on `profileName`: the z/OSMF SDKs
   * for a zosmf profile, IBM's RSE client for an rse one. The empty name is
   * the default profile of the first type the world takes that has one.
   */
  host(kind: PaneKind, profileName: string): Promise<ZosHost> {
    return memo(this.hosts, `${kind}\u0000${profileName}`, () => this.createHost(kind, profileName));
  }

  /**
   * The z/OSMF session for a profile name; empty name means the default
   * z/OSMF profile. What the TSO and console commands go through, and the
   * providers on a zosmf profile.
   */
  session(profileName: string): Promise<AbstractSession> {
    return memo(this.sessions, profileName, () => this.createSession(profileName));
  }

  private async createHost(kind: PaneKind, profileName: string): Promise<ZosHost> {
    const info = await this.profileInfo();
    const types = PROFILE_TYPES[kind];
    const attrs = profileName
      ? types.flatMap((type) => info.getAllProfiles(type)).find((p) => p.profName === profileName)
      : types.map((type) => info.getDefaultProfile(type)).find((p) => p !== null);

    // z/OSMF's own path, cache and all — which is also what tells the user
    // about a profile that is not there.
    if (!attrs || attrs.profType === ZOSMF) {
      return { type: ZOSMF, session: await this.session(attrs?.profName ?? profileName), api: ZOSMF_API };
    }

    const merged = info.mergeArgsForProfile(attrs, { getSecureVals: true });
    assertHasCredentials(merged.knownArgs, attrs.profName);
    const host = rseHost(attrs.profName, merged.knownArgs);
    logConnection(attrs.profName, host.session, 'RSE API');
    return host;
  }

  private async createSession(profileName: string): Promise<AbstractSession> {
    const info = await this.profileInfo();
    const attrs = profileName
      ? info.getAllProfiles(ZOSMF).find((p) => p.profName === profileName)
      : info.getDefaultProfile(ZOSMF);

    if (!attrs) {
      // A profile of another type by that name is a profile mc cannot use here
      // yet, which is not the same as no profile at all.
      const other = profileName
        ? KNOWN_TYPES.flatMap((type) => info.getAllProfiles(type)).find((p) => p.profName === profileName)
        : undefined;
      throw new UserFacingError(
        other
          ? `The Zowe profile '${profileName}' is a ${other.profType} profile, and this needs a ${ZOSMF} one.`
          : profileName
            ? `The Zowe profile '${profileName}' does not exist.`
            : `There is no default ${ZOSMF} profile.`,
        'Run `zowe config init`, or pick another profile in the pane\'s profile selector.',
      );
    }

    const merged = info.mergeArgsForProfile(attrs, { getSecureVals: true });
    assertHasCredentials(merged.knownArgs, attrs.profName);
    const session = ProfileInfo.createSession(merged.knownArgs);
    logConnection(attrs.profName, session, 'z/OSMF');
    return session;
  }

  private readArg(info: ProfileInfo, attrs: IProfAttrs, name: string): string | undefined {
    try {
      const merged = info.mergeArgsForProfile(attrs, { getSecureVals: false });
      const arg = merged.knownArgs.find((a) => a.argName === name);
      return arg?.argValue === undefined ? undefined : String(arg.argValue);
    } catch {
      // A profile missing required args should still be listed, just without a host.
      return undefined;
    }
  }
}

/**
 * One promise per key, shared by everyone who asks while it is pending. A
 * failure is not kept: the user fixes the profile and presses F2.
 */
function memo<T>(cache: Map<string, Promise<T>>, key: string, create: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached) return cached;
  const made = create();
  cache.set(key, made);
  made.catch(() => {
    if (cache.get(key) === made) cache.delete(key);
  });
  return made;
}

/** Where, and as whom — never with what: the password and token stay out. */
function logConnection(profileName: string, session: AbstractSession, through: string): void {
  const s = session.ISession;
  log.info(`Profile '${profileName}' (${through}): ${s.protocol ?? 'https'}://${s.hostname}:${s.port}`
    + `${s.basePath ? `/${s.basePath.replace(/^\//, '')}` : ''} as ${s.user ?? '(certificate or token)'}, `
    + `${s.type ?? 'basic'} auth${s.rejectUnauthorized === false ? ', certificates not checked' : ''}`);
}

/**
 * Turns a missing credential manager into a sentence the user can act on.
 *
 * Imperative loads `@zowe/secrets-for-zowe-sdk` with a runtime require() and,
 * when it is absent, only logs "Failed to load Keytar module" before carrying
 * on with every secure value silently empty. The connection then fails much
 * later with an unrelated-looking 401, so the check happens here instead.
 */
/**
 * By host and user rather than by profile: it is the user's ISPF profile and
 * address space that are shared, and two profiles for one user share them.
 */
function userKey(session: AbstractSession): string {
  const s = session.ISession;
  return `${s.hostname}:${s.port}:${(s.user ?? '').toUpperCase()}`;
}

function assertHasCredentials(args: IProfArgAttrs[], profileName: string): void {
  const has = (name: string): boolean => {
    const arg = args.find((a) => a.argName === name);
    return arg?.argValue !== undefined && arg.argValue !== '';
  };

  const authenticated = (has('user') && has('password'))
    || has('tokenValue')
    || (has('certFile') && has('certKeyFile'));

  if (authenticated) return;

  throw new UserFacingError(
    `The profile '${profileName}' has no usable credentials.`,
    'Either they are missing from zowe.config.json, or the credential manager '
    + 'could not read them. The latter shows up as "Failed to load Keytar module" in '
    + 'the Debug Console and means @zowe/secrets-for-zowe-sdk is not installed — '
    + 'run `npm install` again. Otherwise check `zowe config list --locations` and '
    + '`zowe zosmf check status` from a terminal.',
  );
}
