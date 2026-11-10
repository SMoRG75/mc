import { Create, Delete, Download, Get, HRecall, List, Rename, Upload, Utilities } from '@zowe/zos-files-for-zowe-sdk';
import { DeleteJobs, DownloadJobs, GetJobs, SubmitJobs } from '@zowe/zos-jobs-for-zowe-sdk';
import type { AbstractSession } from '@zowe/imperative';
import { issueConsole } from './console';
import { issueTso, type TsoReply } from './tso';

/**
 * Every call the providers make to z/OS, in the shape the z/OSMF SDKs give
 * them — down to taking the session first and answering in z/OSMF's field
 * names.
 *
 * That shape is the contract rather than one of mc's own because z/OSMF is
 * where everything started and what it is tested on: its path stays exactly
 * the SDK calls it always was, and another way in (RSE) is what has to fit
 * around it. Only what the providers use is in here, so a new call shows up
 * as something the other ways in have to answer too.
 */
export interface ZosApi {
  List: Pick<typeof List, 'dataSet' | 'allMembers' | 'fileList'>;
  Get: Pick<typeof Get, 'dataSet' | 'USSFile'>;
  Download: Pick<typeof Download, 'dataSet' | 'ussFile'>;
  Upload: Pick<typeof Upload, 'bufferToDataSet' | 'streamToDataSet' | 'bufferToUssFile' | 'streamToUssFile'>;
  Create: Pick<typeof Create, 'dataSet' | 'dataSetLike' | 'uss'>;
  Delete: Pick<typeof Delete, 'dataSet' | 'ussFile'>;
  Rename: Pick<typeof Rename, 'dataSet' | 'dataSetMember'>;
  HRecall: Pick<typeof HRecall, 'dataSet'>;
  Utilities: Pick<typeof Utilities, 'applyTaggedEncoding' | 'renameUSSFile'>;
  GetJobs: Pick<typeof GetJobs, 'getJobsCommon' | 'getSpoolFiles' | 'getSpoolContentById' | 'getJcl'>;
  DownloadJobs: Pick<typeof DownloadJobs, 'downloadSpoolContentCommon'>;
  DeleteJobs: Pick<typeof DeleteJobs, 'deleteJob'>;
  SubmitJobs: Pick<typeof SubmitJobs, 'submitJob' | 'submitJcl' | 'submitUSSJob'>;
}

/** The SDKs themselves: what a zosmf profile goes through. */
export const ZOSMF_API: ZosApi = {
  List, Get, Download, Upload, Create, Delete, Rename, HRecall, Utilities,
  GetJobs, DownloadJobs, DeleteJobs, SubmitJobs,
};

/** One profile's way in: the session to pass, and the calls to pass it to. */
export interface ZosHost {
  /** The profile type it was made from — `zosmf` or `rse`. */
  type: string;
  session: AbstractSession;
  api: ZosApi;
  /** One TSO command from the command line. */
  tso(command: string): Promise<TsoReply>;
  /** One console command, its messages handed to `write` as they come. */
  console(command: string, write: (lines: string[]) => void): Promise<void>;
}

/** A zosmf profile's way in: the SDKs, and z/OSMF's own TSO and console services. */
export function zosmfHost(session: AbstractSession): ZosHost {
  return {
    type: 'zosmf',
    session,
    api: ZOSMF_API,
    tso: (command) => issueTso(session, command),
    console: (command, write) => issueConsole(session, command, write),
  };
}
