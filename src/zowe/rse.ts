import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AbstractSession, IProfArgAttrs } from '@zowe/imperative';
import {
  CreateDataSetTypeEnum, type ICreateDataSetOptions, type IListOptions, type IZosFilesResponse,
} from '@zowe/zos-files-for-zowe-sdk';
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
interface UploadOptions { binary?: boolean; encoding?: string; localEncoding?: string }

interface RseMvs {
  getSession(): AbstractSession;
  dataSet(filter: string, options?: IListOptions): Promise<IZosFilesResponse>;
  allMembers(dataSetName: string, options?: IListOptions): Promise<IZosFilesResponse>;
  getContents(dataSetName: string, options: ContentOptions): Promise<IZosFilesResponse>;
  uploadFromBuffer(buffer: Buffer, dataSetName: string, options: UploadOptions): Promise<IZosFilesResponse>;
  putContents(file: string, dataSetName: string, options: UploadOptions): Promise<IZosFilesResponse>;
  /** z/OSMF's names for the attributes, which the plug-in turns into RSE API's. */
  createDataSet(
    type: CreateDataSetTypeEnum, dataSetName: string, options: Partial<ICreateDataSetOptions>,
  ): Promise<IZosFilesResponse>;
  allocateLikeDataSet(dataSetName: string, likeDataSetName: string): Promise<IZosFilesResponse>;
  deleteDataSet(dataSetName: string): Promise<IZosFilesResponse>;
  renameDataSet(from: string, to: string): Promise<IZosFilesResponse>;
  renameDataSetMember(dataSetName: string, from: string, to: string): Promise<IZosFilesResponse>;
  hRecallDataSet(dataSetName: string): Promise<IZosFilesResponse>;
}

interface RseUss {
  fileList(path: string): Promise<IZosFilesResponse>;
  getContents(path: string, options: ContentOptions): Promise<IZosFilesResponse>;
  getTag(path: string): Promise<string>;
  uploadFromBuffer(buffer: Buffer, path: string, options: UploadOptions): Promise<IZosFilesResponse>;
  putContent(file: string, path: string, options: UploadOptions): Promise<IZosFilesResponse>;
  create(path: string, type: string, mode?: string): Promise<IZosFilesResponse>;
  delete(path: string, recursive?: boolean): Promise<IZosFilesResponse>;
  /** `to` is the whole new path; only its last part is the new name. */
  rename(from: string, to: string): Promise<IZosFilesResponse>;
}

interface RseJes {
  getJobsByParameters(options: { owner?: string; prefix?: string; status?: string; maxJobs?: number }): Promise<IJob[]>;
  getSpoolFiles(jobname: string, jobid: string): Promise<IJobFile[]>;
  getSpoolContentById(jobname: string, jobid: string, spoolId: number): Promise<string>;
  getJclForJob(job: IJob): Promise<string>;
  downloadSingleSpool(parms: IDownloadSpoolContentParms): Promise<void>;
  submitJob(dataSetName: string): Promise<IJob>;
  submitJcl(jcl: string): Promise<IJob>;
  deleteJob(jobname: string, jobid: string): Promise<void>;
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
 * The SDK calls, answered by the plug-in, mostly one for one. Where they are
 * not, the comment says what the plug-in or RSE API does differently.
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
    // The plug-in uploads from files, so a stream is put in one first.
    Upload: {
      bufferToDataSet: async (_session, buffer, dataSetName, options) =>
        uploaded(await mvs.uploadFromBuffer(buffer, dataSetName, uploadOptions(options))),
      streamToDataSet: (_session, stream, dataSetName, options) =>
        spooled(stream, async (file) => uploaded(await mvs.putContents(file, dataSetName, uploadOptions(options)))),
      bufferToUssFile: async (_session, path, buffer, options) =>
        uploaded(await uss.uploadFromBuffer(buffer, path, ussUploadOptions(options))),
      streamToUssFile: (_session, path, stream, options) =>
        spooled(stream, async (file) => uploaded(await uss.putContent(file, path, ussUploadOptions(options)))),
    },
    Create: {
      dataSet: (_session, type, dataSetName, options) =>
        mvs.createDataSet(type, dataSetName, organised(type, options)),
      // RSE API takes the classes along from the model; there is no saying otherwise.
      dataSetLike: (_session, dataSetName, likeDataSetName) => mvs.allocateLikeDataSet(dataSetName, likeDataSetName),
      uss: (_session, path, type, mode) => uss.create(path, type, mode),
    },
    Delete: {
      dataSet: (_session, dataSetName) => mvs.deleteDataSet(dataSetName),
      ussFile: (_session, path, recursive) => uss.delete(path, recursive),
    },
    Rename: {
      dataSet: (_session, from, to) => mvs.renameDataSet(from, to),
      dataSetMember: (_session, dataSetName, from, to) => mvs.renameDataSetMember(dataSetName, from, to),
    },
    HRecall: {
      // RSE API has no waiting for the recall; the provider asks until it is back.
      dataSet: (_session, dataSetName) => mvs.hRecallDataSet(dataSetName),
    },
    Utilities: {
      applyTaggedEncoding: async (_session, path, options) => applyTag(await uss.getTag(path), options),
      renameUSSFile: async (_session, from, to) => {
        await uss.rename(from, to);
        return Buffer.alloc(0);
      },
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
      deleteJob: async (_session, jobname, jobid) => {
        await jes.deleteJob(jobname, jobid);
        return undefined;
      },
    },
    SubmitJobs: {
      submitJob: (_session, dataSetName) => jes.submitJob(dataSetName),
      submitJcl: (_session, jcl) => jes.submitJcl(jcl),
      // RSE API submits from a data set or from JCL, not from a USS file; so
      // the file is read and its JCL sent.
      submitUSSJob: async (_session, path) =>
        jes.submitJcl((await collect((stream) => uss.getContents(path, { stream }))).toString('utf8')),
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

/**
 * The same, for a USS file. Asked for text, the plug-in still looks at the
 * bytes, and a NUL among them sends the file up as binary — tagged with the
 * code page all the same, so it reads back as garbage. Saying what the bytes
 * are is the one way to make it take the word for it, and they are UTF-8: that
 * is what mc hands over as text.
 */
function ussUploadOptions(options?: { binary?: boolean; encoding?: string }): UploadOptions {
  return options?.binary ? { binary: true } : { encoding: options?.encoding, localEncoding: 'UTF-8' };
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

/** Only what decides how the bytes go up; the rest of the SDK's options mean nothing to RSE. */
function uploadOptions(options?: { binary?: boolean; encoding?: string }): UploadOptions {
  return options?.binary ? { binary: true } : { encoding: options?.encoding };
}

/**
 * The plug-in answers a failed upload rather than throwing it, and it writes
 * records too long for the data set cut short rather than refuse them.
 */
function uploaded(response: IZosFilesResponse): IZosFilesResponse {
  const said = response.commandResponse ?? '';
  if (!response.success || /truncated/i.test(said)) {
    throw new UserFacingError(said || 'The upload through RSE API failed.');
  }
  return response;
}

/** A stream written to a file of its own for the time `use` takes. */
async function spooled<T>(stream: Readable, use: (file: string) => Promise<T>): Promise<T> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mc-rse-'));
  try {
    const file = path.join(dir, 'upload');
    await pipeline(stream, fs.createWriteStream(file));
    return await use(file);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

/**
 * The SDK takes the organisation from the type; the plug-in only from the
 * attributes, and a partitioned one without a DSNTYPE is not one RSE API knows.
 */
function organised(
  type: CreateDataSetTypeEnum, options?: Partial<ICreateDataSetOptions>,
): Partial<ICreateDataSetOptions> {
  const sequential = type === CreateDataSetTypeEnum.DATA_SET_SEQUENTIAL;
  return {
    ...options,
    dsorg: sequential ? 'PS' : 'PO',
    ...(sequential ? {} : { dsntype: options?.dsntype ?? 'PDS' }),
  };
}
