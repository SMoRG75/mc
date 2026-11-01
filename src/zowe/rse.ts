import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import type { AbstractSession, IProfArgAttrs } from '@zowe/imperative';
import type { IListOptions, IZosFilesResponse } from '@zowe/zos-files-for-zowe-sdk';
import type { IDownloadSpoolContentParms, IJob, IJobFile } from '@zowe/zos-jobs-for-zowe-sdk';
import { describeError, UserFacingError } from '../core/errors';
import { log } from '../core/log';
import type { ZosApi, ZosHost } from './zosApi';

/**
 * z/OS through IBM's RSE API, by way of IBM's own client for it.
 *
 * That client is the RSE API plug-in for Zowe CLI. It is IBM's code under
 * IBM's licence, so it is not in the .vsix: mc uses the copy the user has
 * installed into Zowe CLI, and says how to get it when there is none. Its
 * Zowe Explorer classes are what is used here, because they answer in
 * z/OSMF's shapes — which is what the providers already read.
 */
const PLUGIN = '@ibm/rse-api-for-zowe-cli';

/** The plug-in as far as mc uses it — it ships its own types, but mc does not depend on it. */
interface RsePlugin {
  RseRestMvsApi: new (profile: LoadedProfile) => RseMvs;
  RseRestUssApi: new (profile: LoadedProfile) => RseUss;
  RseRestJesApi: new (profile: LoadedProfile) => RseJes;
  RseRestClient: {
    getExpectJSON<T>(session: AbstractSession, resource: string, headers?: object[]): Promise<T>;
  };
  ZosRestApiConstants: { RESOURCE: string; USS_FILES: string; PATH: string };
}

/** One entry of RSE API's own USS listing, before the plug-in makes z/OSMF of it. */
interface RseUssChild {
  name: string;
  type?: string;
  size?: number;
  lastModified?: string;
  permissionsSymbolic?: string;
  fileOwner?: string;
  group?: string;
}

/** Imperative's IProfileLoaded, which is what the plug-in's classes are made from. */
interface LoadedProfile {
  name: string;
  type: string;
  message: string;
  failNotFound: boolean;
  profile: Record<string, unknown>;
}

interface ContentOptions { stream?: Writable; binary?: boolean; encoding?: string }

interface RseMvs {
  getSession(): AbstractSession;
  dataSet(filter: string, options?: IListOptions): Promise<IZosFilesResponse>;
  allMembers(dataSetName: string, options?: IListOptions): Promise<IZosFilesResponse>;
  getContents(dataSetName: string, options: ContentOptions): Promise<IZosFilesResponse>;
}

interface RseUss {
  fileList(path: string): Promise<IZosFilesResponse>;
  getContents(path: string, options: ContentOptions): Promise<IZosFilesResponse>;
  getTag(path: string): Promise<string>;
}

interface RseJes {
  getJobsByParameters(options: { owner?: string; prefix?: string; status?: string; maxJobs?: number }): Promise<IJob[]>;
  getSpoolFiles(jobname: string, jobid: string): Promise<IJobFile[]>;
  getSpoolContentById(jobname: string, jobid: string, spoolId: number): Promise<string>;
  getJclForJob(job: IJob): Promise<string>;
  downloadSingleSpool(parms: IDownloadSpoolContentParms): Promise<void>;
}

let plugin: RsePlugin | undefined;

/** Where Zowe CLI keeps the plug-in: one layout on Windows, the other where npm uses lib/. */
function pluginCandidates(): string[] {
  const home = path.resolve(process.env.ZOWE_CLI_HOME || path.join(os.homedir(), '.zowe'));
  return [
    path.join(home, 'plugins', 'installed', 'node_modules', ...PLUGIN.split('/')),
    path.join(home, 'plugins', 'installed', 'lib', 'node_modules', ...PLUGIN.split('/')),
  ];
}

/**
 * Loaded on the first rse profile and kept: nobody on z/OSMF alone pays for
 * it, and nobody without it gets more than a sentence when they try.
 */
function loadPlugin(): RsePlugin {
  if (plugin) return plugin;
  const candidates = pluginCandidates();
  const dir = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'package.json')));
  if (!dir) {
    throw new UserFacingError(
      'An rse profile needs IBM\'s RSE API plug-in for Zowe CLI, and it is not installed.',
      `Install it with \`zowe plugins install ${PLUGIN}\` (https://www.npmjs.com/package/${PLUGIN}) `
      + `and reload the window. mc looks for it in ${candidates[0]}.`,
    );
  }
  const started = Date.now();
  try {
    // A path, not a package name: the bundle has to leave this require alone.
    plugin = require(dir) as RsePlugin;
  } catch (err) {
    const { message, detail } = describeError(err);
    throw new UserFacingError(
      `IBM's RSE API plug-in in ${dir} could not be loaded.`,
      `${message}\n${detail ?? ''}`.trim(),
    );
  }
  const version = readVersion(dir);
  log.info(`RSE API plug-in ${version ?? '(version unknown)'} loaded from ${dir} (${Date.now() - started} ms)`);
  return plugin;
}

function readVersion(dir: string): string | undefined {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/** The way in for one rse profile, from its merged arguments — secure ones included. */
export function rseHost(profileName: string, args: IProfArgAttrs[]): ZosHost {
  const rse = loadPlugin();
  const { RseRestMvsApi, RseRestUssApi, RseRestJesApi } = rse;
  const loaded: LoadedProfile = {
    name: profileName,
    type: 'rse',
    message: '',
    failNotFound: false,
    profile: Object.fromEntries(args.map((arg) => [arg.argName, arg.argValue])),
  };
  const mvs = new RseRestMvsApi(loaded);
  return {
    type: 'rse',
    // Who and where, for the serializer and for "my jobs"; the calls below
    // each use the session their own class made from the same profile.
    session: mvs.getSession(),
    api: rseApi(rse, mvs, new RseRestUssApi(loaded), new RseRestJesApi(loaded)),
  };
}

/**
 * The SDK calls, answered by the plug-in. Reading goes through — listing, F3,
 * copying off the host; changing anything is the next step and says so.
 */
function rseApi(rse: RsePlugin, mvs: RseMvs, uss: RseUss, jes: RseJes): ZosApi {
  return {
    List: {
      dataSet: (_session, filter, options) => mvs.dataSet(filter, options),
      // Without the cap: the plug-in turns it into a range, which RSE API only
      // takes from 1.1.6 and refuses below. The pane cuts the list to a page.
      allMembers: (_session, dataSetName, options) =>
        mvs.allMembers(dataSetName, { ...options, maxLength: undefined }),
      // The plug-in lists a whole directory; the pane cuts it to a page.
      fileList: (_session, path) => isRoot(path) ? listRoot(rse, mvs.getSession()) : uss.fileList(path),
    },
    Get: {
      dataSet: (_session, dataSetName, options) =>
        collect((stream) => mvs.getContents(dataSetName, { ...contentOptions(options), stream })),
      USSFile: (_session, path, options) =>
        collect((stream) => uss.getContents(path, { ...contentOptions(options), stream })),
    },
    Download: {
      dataSet: (_session, dataSetName, options) =>
        mvs.getContents(dataSetName, { ...contentOptions(options), stream: options?.stream }),
      ussFile: (_session, path, options) =>
        uss.getContents(path, { ...contentOptions(options), stream: options?.stream }),
    },
    Upload: {
      bufferToDataSet: notYet('Writing to a data set'),
      streamToDataSet: notYet('Writing to a data set'),
      bufferToUssFile: notYet('Writing to a USS file'),
      streamToUssFile: notYet('Writing to a USS file'),
    },
    Create: {
      dataSet: notYet('Allocating a data set'),
      dataSetLike: notYet('Allocating a data set'),
      uss: notYet('Making a USS directory'),
    },
    Delete: {
      dataSet: notYet('Deleting'),
      ussFile: notYet('Deleting'),
    },
    Rename: {
      dataSet: notYet('Renaming'),
      dataSetMember: notYet('Renaming'),
    },
    HRecall: {
      dataSet: notYet('Recalling a data set'),
    },
    Utilities: {
      applyTaggedEncoding: async (_session, path, options) => applyTag(await uss.getTag(path), options),
      renameUSSFile: notYet('Renaming'),
    },
    GetJobs: {
      getJobsCommon: (_session, parms) => jes.getJobsByParameters({
        owner: parms?.owner, prefix: parms?.prefix, status: parms?.status, maxJobs: parms?.maxJobs,
      }),
      getSpoolFiles: (_session, jobname, jobid) => jes.getSpoolFiles(jobname, jobid),
      // The plug-in takes no codepage here; spool comes back in the host's.
      getSpoolContentById: (_session, jobname, jobid, spoolId) =>
        jes.getSpoolContentById(jobname, jobid, spoolId),
      getJcl: (_session, jobname, jobid) => jes.getJclForJob({ jobname, jobid } as IJob),
    },
    DownloadJobs: {
      downloadSpoolContentCommon: (_session, parms) => jes.downloadSingleSpool(parms),
    },
    DeleteJobs: {
      deleteJob: notYet('Purging a job'),
    },
    SubmitJobs: {
      submitJob: notYet('Submitting'),
      submitJcl: notYet('Submitting'),
      submitUSSJob: notYet('Submitting'),
    },
  };
}

function isRoot(path: string): boolean {
  return path.replace(/\/+/g, '/') === '/';
}

/**
 * The plug-in writes every path without its trailing slash, which leaves the
 * root as no path at all, and RSE API refuses that. So the root is asked for
 * here, and answered the way the plug-in answers every other directory.
 */
async function listRoot(rse: RsePlugin, session: AbstractSession): Promise<IZosFilesResponse> {
  const { RESOURCE, USS_FILES, PATH } = rse.ZosRestApiConstants;
  const root = await rse.RseRestClient.getExpectJSON<{ children?: RseUssChild[] }>(
    session,
    `${RESOURCE}${USS_FILES}?${PATH}=%2F`,
    [{ 'Show-Additional-Attributes': 'true' }, { Accept: 'application/json' }],
  );
  const items = (root.children ?? []).map((child) => ({
    name: child.name,
    size: child.size,
    mtime: child.lastModified,
    mode: child.permissionsSymbolic ?? (child.type === 'DIRECTORY' ? 'd?????????' : '-?????????'),
    group: child.group,
    user: child.fileOwner,
  }));
  return { success: true, commandResponse: '', apiResponse: { items } };
}

/** Only what decides how the bytes come back; the rest of the SDK's options mean nothing to RSE. */
function contentOptions(options?: { binary?: boolean; encoding?: string }): ContentOptions {
  return options?.binary ? { binary: true } : { encoding: options?.encoding };
}

/** A download into memory, for the SDK calls that answer with the content itself. */
async function collect(download: (stream: Writable) => Promise<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  });
  await download(sink);
  return Buffer.concat(chunks);
}

/**
 * What the z/OSMF SDK does with a file's tag, done with the tag the plug-in
 * reads: binary and the ASCII and Unicode sets come over untouched, an EBCDIC
 * page is what the text is converted from.
 */
export function applyTag(tag: string, options: { binary?: boolean; encoding?: string }): void {
  const text = tag.trim();
  if (/^b(inary)?\b/i.test(text) || /\b(ISO8859-|UCS-|UTF-)/i.test(text)) {
    options.binary = true;
    return;
  }
  const ebcdic = /\bIBM-\d+\b/i.exec(text);
  if (ebcdic) options.encoding = ebcdic[0].toUpperCase();
}

function notYet(what: string): () => Promise<never> {
  return async () => {
    throw new UserFacingError(
      `${what} does not go through RSE in mc yet.`,
      'Over an rse profile mc lists, shows and copies off the host for now. Use a zosmf profile for this.',
    );
  };
}
