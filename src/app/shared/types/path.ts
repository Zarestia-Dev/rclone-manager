export interface PathSegment {
  name: string;
  path: string;
}

export type PathStyle = 'posix' | 'windows';

export type PathGroupType = 'local' | 'currentRemote' | `otherRemote:${string}`;

export interface PathGroup {
  type: PathGroupType;
  path: string;
  remote: string;
}

export type DefaultPathOp = 'mount' | 'bisync';

/** What already uses a folder: a saved profile of a remote, or a Quick Run. */
export interface MountPathCollision {
  kind: 'profile' | 'quick_run';
  /** The remote the profile belongs to, or the one the Quick Run is bound to. */
  remoteName: string;
  /** The name of the profile or of the Quick Run. */
  name: string;
  opType: string;
  path: string;
}

export interface PathInspectionStatus {
  state:
    | 'clean'
    | 'nonEmpty'
    | 'exists'
    | 'colliding'
    | 'willCreate'
    | 'checking'
    | 'unavailable'
    | 'notDirectory';
  icon: string;
  badgeClass: string;
  labelKey: string;
  /** Values for the placeholders of `labelKey`. */
  labelParams?: Readonly<Record<string, string>>;
}
