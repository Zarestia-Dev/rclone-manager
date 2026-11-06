import { RcCommandInfo } from '@app/types';
import { RcParamInfo, parseRcParams } from './rc-help.util';

/**
 * Parameters rclone refuses to run a call without. rclone publishes no schema, so these were
 * read from its source: a parameter is listed when the handler returns an error if it is missing
 * (`rc.GetFs`, `rc.GetFsAndRemote`, `in.GetString` and friends without a `ParamNotFound` check).
 *
 * Only calls that were checked are here; any other call just shows what its help text lists.
 *
 * - fs/operations/rc.go: `operations/*`
 * - fs/sync/rc.go: `sync/*`
 * - fs/config/rc.go: `config/*`
 * - cmd/mountlib/rc.go: `mount/*`
 * - fs/rc/jobs/job.go: `job/*`
 */
const REQUIRED_PARAMS: Readonly<Record<string, readonly string[]>> = {
  'operations/list': ['fs', 'remote'],
  'operations/stat': ['fs', 'remote'],
  'operations/about': ['fs'],
  'operations/size': ['fs'],
  'operations/fsinfo': ['fs'],
  'operations/publiclink': ['fs', 'remote'],
  'operations/hashsum': ['fs', 'hashType'],
  'operations/hashsumfile': ['fs', 'remote'],
  'operations/getfile': ['fs'],
  'operations/index': ['fs'],
  'operations/mkdir': ['fs', 'remote'],
  'operations/rmdir': ['fs', 'remote'],
  'operations/rmdirs': ['fs', 'remote'],
  'operations/purge': ['fs', 'remote'],
  'operations/deletefile': ['fs', 'remote'],
  'operations/copyurl': ['fs', 'remote', 'url'],
  'operations/delete': ['fs'],
  'operations/cleanup': ['fs'],
  'operations/settier': ['fs'],
  'operations/copyfile': ['srcFs', 'srcRemote', 'dstFs', 'dstRemote'],
  'operations/movefile': ['srcFs', 'srcRemote', 'dstFs', 'dstRemote'],
  'sync/copy': ['srcFs', 'dstFs'],
  'sync/move': ['srcFs', 'dstFs'],
  'sync/sync': ['srcFs', 'dstFs'],
  'config/get': ['name'],
  'config/delete': ['name'],
  'config/create': ['name', 'type', 'parameters'],
  'config/update': ['name', 'parameters'],
  'config/password': ['name', 'parameters'],
  'config/unset': ['name', 'keys'],
  'config/setpath': ['path'],
  'mount/mount': ['fs', 'mountPoint'],
  'mount/unmount': ['mountPoint'],
  'job/status': ['jobid'],
  'job/stop': ['jobid'],
  'job/stopgroup': ['group'],
};

export function requiredParams(command: string): readonly string[] {
  return REQUIRED_PARAMS[command] ?? [];
}

/**
 * The parameters parsed from the help, with the required ones marked and put first. A required
 * parameter the help does not list is added, so it still gets a field and a chip.
 */
export function annotateParams(command: string, parsed: readonly RcParamInfo[]): RcParamInfo[] {
  const required = requiredParams(command);
  if (required.length === 0) return [...parsed];

  const byName = new Map(parsed.map(p => [p.name, p]));
  const marked = required.map((name): RcParamInfo => ({
    name,
    description: byName.get(name)?.description ?? '',
    optional: false,
    required: true,
  }));
  return [...marked, ...parsed.filter(p => !required.includes(p.name))];
}

const paramsCache = new WeakMap<RcCommandInfo, RcParamInfo[]>();

/**
 * The parameters of a call: those its help lists, with the required ones marked. Read once per
 * call, as the help is prose that has to be parsed.
 */
export function paramsOf(command: RcCommandInfo): readonly RcParamInfo[] {
  let params = paramsCache.get(command);
  if (!params) {
    params = annotateParams(command.Path, parseRcParams(command.Help));
    paramsCache.set(command, params);
  }
  return params;
}
