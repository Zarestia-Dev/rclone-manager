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
  const { answer } = state;
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
 * Returns a new state object with the given answer applied.
 */
export function updateInteractiveAnswer(
  state: InteractiveFlowState,
  newAnswer: string | number | boolean | null
): InteractiveFlowState {
  return { ...state, answer: newAnswer };
}

/**
 * Builds an rclone path string (e.g. "myRemote:path/to/dir") from a form path group object.
 */
export function buildPathString(pathGroup: any, currentRemoteName: string): string {
  if (pathGroup === null || pathGroup === undefined) return '';

  // Simple string path — e.g. mount dest which is always local
  if (typeof pathGroup === 'string') return pathGroup;

  const { type, path, remote } = pathGroup;
  const p = path || '';

  if (typeof type === 'string' && type.startsWith('otherRemote:')) {
    const remoteName = remote || type.split(':')[1];
    return `${remoteName}:${p}`;
  }

  switch (type) {
    case 'local':
      return p;
    case 'currentRemote':
      return `${currentRemoteName}:${p}`;
    default:
      return '';
  }
}

/**
 * Builds an array of rclone path strings from one or more form path groups.
 */
export function buildPathStrings(pathGroups: any | any[], currentRemoteName: string): string[] {
  if (!pathGroups) return [];
  if (Array.isArray(pathGroups)) {
    return pathGroups.map(pg => buildPathString(pg, currentRemoteName)).filter(p => !!p);
  }
  const single = buildPathString(pathGroups, currentRemoteName);
  return single ? [single] : [];
}

/**
 * Extracts the default answer from an interactive config question response.
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
 * Returns true for Unix absolute paths (/foo) and Windows drive paths (C:\ or C:/).
 */
export function isLocalPath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:([\\/]|$)/.test(path);
}

/**
 * Splits an rclone path into its remote name and relative path components.
 */
export function splitFsPath(fullPath: string): { remote: string; path: string } {
  if (isLocalPath(fullPath)) return { remote: '', path: fullPath };

  const colonIdx = fullPath.indexOf(':');
  if (colonIdx === -1) return { remote: '', path: fullPath };

  return {
    remote: fullPath.substring(0, colonIdx),
    path: fullPath.substring(colonIdx + 1).replace(/^\/+/, ''),
  };
}

/**
 * Splits an absolute local path into its root and remainder.
 * @example "/home/hakan"  → { remote: "/",   remainder: "home/hakan" }
 * @example "C:\\Users\\x" → { remote: "C:\\", remainder: "Users\\x"  }
 */
export function splitLocalPath(path: string): { remote: string; remainder: string } {
  if (path.startsWith('/')) {
    return { remote: '/', remainder: path.substring(1) };
  }
  const windowsMatch = path.match(/^([a-zA-Z]:)([\\/]?)(.*)$/);
  if (windowsMatch) {
    return { remote: windowsMatch[1] + (windowsMatch[2] || '\\'), remainder: windowsMatch[3] };
  }
  return { remote: path, remainder: '' };
}

/**
 * Normalizes an rclone fs value to a string.
 * Handles both plain strings and object formats from backend serve list.
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
 * Strips runtime backend instance suffixes from remote names.
 * @example "Mega{Gyju7}" → "Mega"
 */
export function normalizeRemoteName(remote: string): string {
  return remote
    .trim()
    .replace(/:$/, '')
    .replace(/\{[A-Za-z0-9_-]+\}$/, '');
}

/**
 * Safely extracts the remote name from an rclone fs value.
 */
export function getRemoteNameFromFs(fs: unknown): string {
  const normalized = normalizeFs(fs);
  if (!normalized) return '';
  if (isLocalPath(normalized)) return 'local';
  return normalizeRemoteName(normalized.split(':')[0]);
}

/**
 * Parses an rclone fs string into path components for UI configuration.
 * Classifies the path as local, currentRemote, or otherRemote.
 */
export function parseFsString(
  fullPath: string,
  defaultType: string,
  currentRemoteName: string,
  existingRemotes: string[] = []
): { type: string; path: string; remote?: string } {
  if (!fullPath) return { type: defaultType, path: '' };

  const colonIdx = fullPath.indexOf(':');

  // No colon → relative path; starts with / or drive letter → local filesystem
  if (colonIdx === -1 || isLocalPath(fullPath)) return { type: 'local', path: fullPath };

  const remote = fullPath.substring(0, colonIdx);
  const path = fullPath.substring(colonIdx + 1);

  if (remote === currentRemoteName) return { type: 'currentRemote', path };
  if (existingRemotes.includes(remote)) {
    return { type: `otherRemote:${remote}`, path, remote };
  }

  return { type: defaultType, path: fullPath };
}

/**
 * Normalizes an rclone config key for flexible searching
 * (lowercase, hyphens/spaces → underscores).
 */
export function normalizeRcloneKey(val: string | undefined | null): string {
  if (!val) return '';
  return val.toLowerCase().replace(/[- ]/g, '_');
}

/**
 * Returns true if a config field name or help text matches the given search query.
 */
export function matchesConfigSearch(field: RcConfigOption, query: string): boolean {
  if (!query) return true;

  const trimmedQuery = query.toLowerCase().trim();
  const flexibleQuery = normalizeRcloneKey(trimmedQuery);

  return (
    (field.Name?.toLowerCase() ?? '').includes(trimmedQuery) ||
    (field.FieldName?.toLowerCase() ?? '').includes(trimmedQuery) ||
    (field.Help?.toLowerCase() ?? '').includes(trimmedQuery) ||
    normalizeRcloneKey(field.Name).includes(flexibleQuery) ||
    normalizeRcloneKey(field.FieldName).includes(flexibleQuery)
  );
}

/**
 * Groups an array of items by a derived key.
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
