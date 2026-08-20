import { ProfileInfo, type AbstractSession, type IProfAttrs } from '@zowe/imperative';
import type { ProfileDto } from '../shared/protocol';
import { UserFacingError } from '../core/errors';

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
  private readonly sessions = new Map<string, AbstractSession>();

  /** Re-reads zowe.config.json; call when the user edits their profiles. */
  invalidate(): void {
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
  async session(profileName: string): Promise<AbstractSession> {
    const cached = this.sessions.get(profileName);
    if (cached) return cached;

    const info = await this.profileInfo();
    const attrs = profileName
      ? info.getAllProfiles('zosmf').find((p) => p.profName === profileName)
      : info.getDefaultProfile('zosmf');

    if (!attrs) {
      throw new UserFacingError(
        profileName
          ? `Zowe-profilen '${profileName}' findes ikke.`
          : 'Der er ingen default zosmf-profil.',
        'Kør `zowe config init` eller vælg en anden profil i panelets profilvælger.',
      );
    }

    const merged = info.mergeArgsForProfile(attrs, { getSecureVals: true });
    const session = ProfileInfo.createSession(merged.knownArgs);
    this.sessions.set(profileName, session);
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
