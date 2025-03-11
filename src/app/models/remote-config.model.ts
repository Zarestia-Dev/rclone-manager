// Define a base interface for remote configurations
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
  clientId: string = '';
  refreshToken: string = '';
}

// AWS S3 remote configuration
export class AwsS3Remote extends BaseRemote {
  accessKey: string = '';
  secretKey: string = '';
  bucket: string = '';
}

// OneDrive remote configuration
export class OneDriveRemote extends BaseRemote {
  clientId: string = '';
  clientSecret: string = '';
}

// Dropbox remote configuration
export class DropboxRemote extends BaseRemote {
  clientId: string = '';
  clientSecret: string = '';
}

// Map remote types to their respective classes
export const RemoteModels: { [key: string]: new () => BaseRemote } = {
  'Google Drive': GoogleDriveRemote,
  'AWS S3': AwsS3Remote,
  'OneDrive': OneDriveRemote,
  'Dropbox': DropboxRemote,
};

// Utility function to get an instance of a remote configuration
export function createRemoteInstance(type: string): BaseRemote | null {
  const RemoteClass = RemoteModels[type];
  return RemoteClass ? new RemoteClass() : null;
}
