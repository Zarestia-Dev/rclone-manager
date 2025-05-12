export type FlagType = "mount" | "copy" | "sync" | "filter" | "vfs";
export type EditTarget = FlagType | "remote" | null;

export type FieldType =
  | "bool"
  | "int"
  | "Duration"
  | "string"
  | "stringArray"
  | "CommaSeparatedList"
  | "SizeSuffix"
  | "int64"
  | "uint32"
  | "float"
  | "password"
  | "hidden"
  | "option"
  | "time"
  | "date"
  | "object"
  | "json"
  | string;

export interface RemoteField {
  Name: string;
  Type: string;
  Help: string;
  Value: any;
  Default: any;
  Required: boolean;
  Advanced: boolean;
  Examples: any[];
}

export interface FlagField {
  ValueStr: string;
  Value: any;
  name: string;
  default: any;
  help: string;
  type: string;
  required: boolean;
  examples: any[];
}

export interface LoadingState {
  remoteConfig?: boolean;
  mountConfig?: boolean;
  saving: boolean;
  authDisabled: boolean;
  cancelled: boolean;
  [key: string]: boolean | undefined;
}

export interface RemoteType {
  value: string;
  label: string;
}

export const SENSITIVE_KEYS = [
  "password",
  "secret",
  "endpoint",
  "token",
  "key",
  "credentials",
  "auth",
  "client_secret",
  "client_id",
  "api_key",
];


export interface QuickAddForm {
  remoteName: string;
  remoteType: string;
  autoMount: boolean;
  mountPath: string;
}

export interface RemoteSettings {
  name: string;
  custom_flags: string[];
  vfs_options: {
    CacheMode: string;
    ChunkSize: string;
  };
  mount_options: {
    mount_point: string;
    auto_mount: boolean;
  };
  show_in_tray_menu: boolean;
}

// interface MountType {
//   value: string;
//   label: string;
// }