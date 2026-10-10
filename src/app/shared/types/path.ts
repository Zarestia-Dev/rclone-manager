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

export interface PathInspectionStatus {
  state: 'clean' | 'nonEmpty' | 'colliding' | 'willCreate' | 'checking';
  details?: string;
  icon: string;
  badgeClass: string;
  labelKey: string;
}
