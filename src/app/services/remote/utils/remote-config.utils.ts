import { RcConfigQuestionResponse, InteractiveFlowState, RcConfigOption } from '@app/types';

/**
 * Creates the initial/reset state for interactive flow.
 */
export function createInitialInteractiveFlowState(): InteractiveFlowState {
  return {
    isActive: false,
    question: null,
    answer: null,
    isProcessing: false,
  };
}

/**
 * Checks if the interactive continue button should be disabled.
 */
export function isInteractiveContinueDisabled(
  state: InteractiveFlowState,
  isAuthCancelled: boolean
): boolean {
  if (isAuthCancelled || state.isProcessing) return true;
  if (!state.question?.Option?.Required) return false;
  const answer = state.answer;
  return (
    answer === null || answer === undefined || (typeof answer === 'string' && answer.trim() === '')
  );
}

/**
 * Converts a boolean answer to the string format expected by rclone API.
 */
export function convertBoolAnswerToString(answer: unknown): string {
  if (typeof answer === 'boolean') return answer ? 'true' : 'false';
  return String(answer).toLowerCase() === 'true' ? 'true' : 'false';
}

/**
 * Updates the interactive flow state with a new answer value.
 */
export function updateInteractiveAnswer(
  state: InteractiveFlowState,
  newAnswer: string | number | boolean | null
): InteractiveFlowState {
  return { ...state, answer: newAnswer };
}

/**
 * Builds a path string (e.g., "myRemote:path") from a form path group object.
 * Handles various path types: local, currentRemote, otherRemote.
 */
export function buildPathString(pathGroup: any, currentRemoteName: string): string {
  if (pathGroup === null || pathGroup === undefined) return '';

  // Handle simple string path (e.g., mount dest which is always local)
  if (typeof pathGroup === 'string') return pathGroup;

  const { pathType, path, otherRemoteName } = pathGroup;
  const p = path || '';

  // Handle "otherRemote:remoteName" format
  if (typeof pathType === 'string' && pathType.startsWith('otherRemote:')) {
    const remote = otherRemoteName || pathType.split(':')[1];
    return `${remote}:${p}`;
  }

  switch (pathType) {
    case 'local':
      return p;
    case 'currentRemote':
      return `${currentRemoteName}:${p}`;
    default:
      return '';
  }
}

/**
 * Extracts the default answer from an interactive config question response.
 * Handles boolean, string, and numeric types.
 */
export function getDefaultAnswerFromQuestion(
  q: RcConfigQuestionResponse
): string | boolean | number {
  const opt = q.Option;
  if (!opt) return '';

  if (opt.Type === 'bool') {
    if (typeof opt.Value === 'boolean') return opt.Value;
    if (opt.ValueStr !== undefined) return opt.ValueStr.toLowerCase() === 'true';
    if (opt.DefaultStr !== undefined) return opt.DefaultStr.toLowerCase() === 'true';
    return typeof opt.Default === 'boolean' ? opt.Default : true;
  }

  return (
    opt.ValueStr || opt.DefaultStr || String(opt.Default || '') || opt.Examples?.[0]?.Value || ''
  );
}

/**
 * Checks if a given path is a local filesystem path.
 * Recognizes Unix-style absolute paths (starting with '/') and Windows-style paths (e.g., 'C:\', 'C:/' or 'C:').
 */
export function isLocalPath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:([\\/]|$)/.test(path);
}

/**
 * Splits an absolute local path into its root (remote) and remainder (path).
 * Example: "/home/hakan" -> { remote: "/", remainder: "home/hakan" }
 * Example: "C:\Users\hakan" -> { remote: "C:\", remainder: "Users\hakan" }
 */
export function splitLocalPath(path: string): { remote: string; remainder: string } {
  if (path.startsWith('/')) {
    return { remote: '/', remainder: path.substring(1) };
  }
  const windowsMatch = path.match(/^([a-zA-Z]:)([\\/]?)(.*)$/);
  if (windowsMatch) {
    const drive = windowsMatch[1];
    const slash = windowsMatch[2] || '\\';
    return { remote: drive + slash, remainder: windowsMatch[3] };
  }
  return { remote: path, remainder: '' };
}

/**
 * Normalizes an rclone fs value to a string.
 * Handles both plain strings and object formats (e.g. from backend serve list).
 */
export function normalizeFs(fs: unknown): string {
  if (typeof fs === 'string') return fs;
  if (!fs || typeof fs !== 'object') return '';

  const fsObj = fs as Record<string, unknown>;
  const root = typeof fsObj['_root'] === 'string' ? fsObj['_root'] : '';

  if (typeof fsObj['_name'] === 'string') return `${fsObj['_name']}:${root}`;
  if (typeof fsObj['type'] === 'string') return `:${fsObj['type']}:${root}`;

  return '';
}

/**
 * Removes runtime backend instance suffixes from remote names.
 * Example: Mega{Gyju7} -> Mega
 */
export function normalizeRemoteName(remote: string): string {
  return remote
    .trim()
    .replace(/:$/, '')
    .replace(/\{[A-Za-z0-9_-]+\}$/, '');
}

/**
 * Safely extracts the remote name from an rclone fs value.
 * Handles local paths, Windows drive letters, and object formats.
 */
export function getRemoteNameFromFs(fs: unknown): string {
  const normalized = normalizeFs(fs);
  if (!normalized) return '';
  if (isLocalPath(normalized)) return 'local';
  return normalizeRemoteName(normalized.split(':')[0]);
}

/**
 * Parses an rclone fs string into its components for UI configuration.
 * Identifies if the path is local, on the current remote, or another remote.
 */
export function parseFsString(
  fullPath: string,
  defaultType: string,
  currentRemoteName: string,
  existingRemotes: string[] = []
): { pathType: string; path: string; otherRemoteName?: string } {
  if (!fullPath) return { pathType: defaultType, path: '' };

  const colonIdx = fullPath.indexOf(':');
  const isLocal = colonIdx === -1 || colonIdx === 1 || fullPath.startsWith('/');

  if (isLocal) return { pathType: 'local', path: fullPath };

  const remote = fullPath.substring(0, colonIdx);
  const path = fullPath.substring(colonIdx + 1);

  if (remote === currentRemoteName) return { pathType: 'currentRemote', path };
  if (existingRemotes.includes(remote)) {
    return { pathType: `otherRemote:${remote}`, path, otherRemoteName: remote };
  }

  return { pathType: defaultType, path: fullPath };
}

/**
 * Normalizes an rclone configuration key/flag for flexible searching.
 * Converts to lowercase and replaces hyphens and spaces with underscores.
 */
export function normalizeRcloneKey(val: string | undefined | null): string {
  if (!val) return '';
  return val.toLowerCase().replace(/[- ]/g, '_');
}

/**
 * Checks if a configuration field matches a given search query.
 * Performs both raw substring matching and flexible matching (hyphens/spaces as underscores).
 */
export function matchesConfigSearch(field: RcConfigOption, query: string): boolean {
  if (!query) return true;

  const trimmedQuery = query.toLowerCase().trim();
  const flexibleQuery = normalizeRcloneKey(trimmedQuery);

  const name = field.Name?.toLowerCase() ?? '';
  const fieldName = field.FieldName?.toLowerCase() ?? '';
  const help = field.Help?.toLowerCase() ?? '';

  const flexibleName = normalizeRcloneKey(field.Name);
  const flexibleFieldName = normalizeRcloneKey(field.FieldName);

  return (
    name.includes(trimmedQuery) ||
    fieldName.includes(trimmedQuery) ||
    help.includes(trimmedQuery) ||
    flexibleName.includes(flexibleQuery) ||
    flexibleFieldName.includes(flexibleQuery)
  );
}
/**
 * Groups an array of items by a key extracted from each item.
 */
export function groupBy<T, K extends PropertyKey>(
  array: T[],
  keyGetter: (item: T) => K
): Record<K, T[]> {
  return array.reduce(
    (acc, item) => {
      const key = keyGetter(item);
      (acc[key] ??= []).push(item);
      return acc;
    },
    {} as Record<K, T[]>
  );
}
