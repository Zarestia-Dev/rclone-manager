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

export interface MountPathCollision {
  remoteName: string;
  profileName: string;
  opType: string;
  path: string;
}

export interface PathInspectionStatus {
  state: 'clean' | 'nonEmpty' | 'colliding' | 'willCreate' | 'checking' | 'unavailable';
  details?: string;
  icon: string;
  badgeClass: string;
  labelKey: string;
}
