import { Pipe, PipeTransform } from "@angular/core";

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
  copyConfig?: boolean;
  syncConfig?: boolean;
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

export interface MountConfig {
  autoMount: boolean;
  mountPath: string;
  remotePath: string;
  options: string; // JSON string
}

export interface CopyConfig {
  autoCopy: boolean;
  source: string;
  dest: string;
  options: string; // JSON string
}

export interface SyncConfig {
  autoSync: boolean;
  source: string;
  dest: string;
  options: string; // JSON string
}

export interface FilterConfig {
  options: string; // JSON string
}

export interface VfsConfig {
  options: string; // JSON string
}

export interface RemoteSettings {
  name: string;
  mountConfig: {
    autoMount: boolean;
    dest: string;
    source: string;
    [key: string]: any;
  };
  copyConfig: {
    autoCopy: boolean;
    source: string;
    dest: string;
    [key: string]: any;
  };
  syncConfig: {
    autoSync: boolean;
    source: string;
    dest: string;
    [key: string]: any;
  };
  filterConfig: {
    [key: string]: any;
  };
  vfsConfig: {
    [key: string]: any;
  };
  showOnTray?: boolean;
}

export interface QuickAddForm {
  remoteName: string;
  remoteType: string;
  mountPath: string;
  autoMount: boolean;
}

export const REMOTE_NAME_REGEX = /^[A-Za-z0-9_\-.\+@ ]+$/;

export interface Entry {
  ID: string;
  IsDir: boolean;
  MimeType: string;
  ModTime: string;
  Name: string;
  Path: string;
  Size: number;
}

export function getDefaultValueForType(type: FieldType): any {
  switch (type) {
    case "bool":
      return false;
    case "int":
    case "int64":
    case "uint32":
    case "SizeSuffix":
      return 0;
    case "string":
    case "Duration":
    case "FileMode":
    case "CacheMode":
      return "";
    case "stringArray":
      return [""];
    case "Tristate":
      return null;
    case "HARD|SOFT|CAUTIOUS":
      return "HARD";
    default:
      return null;
  }
}

@Pipe({ name: "linebreaks" })
export class LinebreaksPipe implements PipeTransform {
  transform(value: string): string {
    return value ? value.replace(/(?:\r\n|\r|\n)/g, "<br>") : "";
  }
}
