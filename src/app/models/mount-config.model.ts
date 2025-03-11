export interface MountConfig {
    type: string;
    [key: string]: any;
  }
  
  export class BaseMount implements MountConfig {
    type: string = '';
  }
  
  // Native mount (direct Rclone execution)
  export class NativeMount extends BaseMount {
    mountPoint: string = '';
    remotePath: string = '';
    options: string = ''; // Extra Rclone options
  }
  
  // Systemd-based mount
  export class SystemdMount extends BaseMount {
    serviceName: string = ''; // Name of the systemd service
    mountPoint: string = '';
    remotePath: string = '';
  }
  
  export const MountModels: { [key: string]: new () => BaseMount } = {
    'Native': NativeMount,
    'Systemd': SystemdMount,
  };
  
  export function createMountInstance(type: string): BaseMount | null {
    const MountClass = MountModels[type];
    return MountClass ? new MountClass() : null;
  }
  