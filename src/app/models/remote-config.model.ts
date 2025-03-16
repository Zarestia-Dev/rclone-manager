export interface RemoteConfig {
  name: string;
  type: string;
  [key: string]: any; // Allow additional dynamic properties
}

// Base class for all remote configurations
export class BaseRemote implements RemoteConfig {
  name: string = '';
  type: string = '';
}

// Google Drive remote configuration
export class GoogleDriveRemote extends BaseRemote {
  client_id: string = '';
  client_secret: string = '';
  scope: Array<string> = [];
  service_account_file: string = '';
  token: string = '';
  team_drive: string = '';
}

// AWS S3 remote configuration
export class AwsS3Remote extends BaseRemote {
  access_key: string = '';
  secret_key: string = '';
  bucket: string = '';
}

// OneDrive remote configuration
export class OneDriveRemote extends BaseRemote {
  client_id: string = '';
  client_secret: string = '';
}

// Dropbox remote configuration
export class DropboxRemote extends BaseRemote {
  client_id: string = '';
  client_secret: string = '';
}

// Map remote types to their respective classes
export const RemoteModels: { [key: string]: new () => BaseRemote } = {
  'drive': GoogleDriveRemote,
  's3': AwsS3Remote,
  'onedrive': OneDriveRemote,
  'dropbox': DropboxRemote,
};

// Utility function to get an instance of a remote configuration
export function createRemoteInstance(type: string): BaseRemote | null {
  const RemoteClass = RemoteModels[type];
  return RemoteClass ? new RemoteClass() : null;
}