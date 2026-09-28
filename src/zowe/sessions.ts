import { ProfileInfo, type AbstractSession, type IProfArgAttrs, type IProfAttrs } from '@zowe/imperative';
import type { ProfileDto } from '../shared/protocol';
import { UserFacingError } from '../core/errors';
import { log } from '../core/log';
import { Serializer } from '../core/serial';

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
  private readonly fileServices = new Serializer();

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
    // By host and user rather than by profile: it is the user's ISPF profile
    // that is held, and two profiles for one user share it.
    const s = session.ISession;
    const key = `${s.hostname}:${s.port}:${(s.user ?? '').toUpperCase()}`;
    return this.fileServices.run(key, call, signal);
  }

  /** Re-reads zowe.config.json; call when the user edits their profiles. */
  invalidate(): void {
    log.debug('Zowe configuration changed; profiles will be read again.');
    this.info = undefined;
    this.sessions.clear();
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

  async profiles(): Promise<ProfileDto[]> {
    const info = await this.profileInfo();
    const defaultProfile = info.getDefaultProfile('zosmf');
    return info.getAllProfiles('zosmf').map((attrs) => ({
      name: attrs.profName,
      type: attrs.profType,
      host: this.readArg(info, attrs, 'host'),
      isDefault: attrs.profName === defaultProfile?.profName,
    }));
  }

  /** The session for a profile name; empty name means the default profile. */
  session(profileName: string): Promise<AbstractSession> {
    const cached = this.sessions.get(profileName);
    if (cached) return cached;
    const session = this.createSession(profileName);
    this.sessions.set(profileName, session);
    // A failure is not cached: the user fixes the profile and presses F2.
    session.catch(() => {
      if (this.sessions.get(profileName) === session) this.sessions.delete(profileName);
    });
    return session;
  }

  private async createSession(profileName: string): Promise<AbstractSession> {
    const info = await this.profileInfo();
    const attrs = profileName
      ? info.getAllProfiles('zosmf').find((p) => p.profName === profileName)
      : info.getDefaultProfile('zosmf');

    if (!attrs) {
      throw new UserFacingError(
        profileName
          ? `The Zowe profile '${profileName}' does not exist.`
          : 'There is no default zosmf profile.',
        'Run `zowe config init`, or pick another profile in the pane\'s profile selector.',
      );
    }

    const merged = info.mergeArgsForProfile(attrs, { getSecureVals: true });
    assertHasCredentials(merged.knownArgs, attrs.profName);
    const session = ProfileInfo.createSession(merged.knownArgs);
    const s = session.ISession;
    // Where, and as whom — never with what: the password and token stay out.
    log.info(`Profile '${attrs.profName}': ${s.protocol ?? 'https'}://${s.hostname}:${s.port}`
      + `${s.basePath ?? ''} as ${s.user ?? '(certificate or token)'}, ${s.type ?? 'basic'} auth`
      + `${s.rejectUnauthorized === false ? ', certificates not checked' : ''}`);
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
 * Turns a missing credential manager into a sentence the user can act on.
 *
 * Imperative loads `@zowe/secrets-for-zowe-sdk` with a runtime require() and,
 * when it is absent, only logs "Failed to load Keytar module" before carrying
 * on with every secure value silently empty. The connection then fails much
 * later with an unrelated-looking 401, so the check happens here instead.
 */
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
