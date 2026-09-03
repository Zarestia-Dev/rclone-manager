export interface NodeVariableField {
  key: string;
  label: string;
}

/**
 * Returns available runtime variable fields for a given node type,
 * used in variable picker dropdowns and template token resolution.
 */
export function getNodeFieldsForType(type?: string): NodeVariableField[] {
  switch (type) {
    case 'command':
    case 'exec_script':
      return [
        { key: 'exitCode', label: 'Exit Code (exitCode)' },
        { key: 'success', label: 'Success (success)' },
        { key: 'stdout', label: 'Standard Output (stdout)' },
        { key: 'stderr', label: 'Standard Error (stderr)' },
      ];
    case 'sync':
    case 'copy':
    case 'move':
    case 'bisync':
    case 'check':
    case 'delete':
    case 'copyurl':
    case 'archivecreate':
    case 'cryptcheck':
      return [
        { key: 'status', label: 'Status (status)' },
        { key: 'bytesTransferred', label: 'Bytes Transferred (bytesTransferred)' },
        { key: 'totalBytes', label: 'Total Bytes (totalBytes)' },
        { key: 'jobId', label: 'Job ID (jobId)' },
        { key: 'error', label: 'Error Message (error)' },
      ];
    case 'mount':
      return [
        { key: 'mountPoint', label: 'Mount Point Path (mountPoint)' },
        { key: 'remote', label: 'Remote Name (remote)' },
        { key: 'status', label: 'Mount Status (status)' },
        { key: 'jobId', label: 'Job ID (jobId)' },
      ];
    case 'serve':
      return [
        { key: 'addr', label: 'Server Address (addr)' },
        { key: 'remote', label: 'Remote Name (remote)' },
        { key: 'status', label: 'Server Status (status)' },
        { key: 'jobId', label: 'Job ID (jobId)' },
      ];
    case 'condition':
      return [
        { key: 'conditionMet', label: 'Condition Met (conditionMet)' },
        { key: 'branch', label: 'Selected Branch (branch)' },
      ];
    case 'rc_command':
      return [
        { key: 'status', label: 'Status (status)' },
        { key: 'result', label: 'Command Result (result)' },
      ];
    default:
      return [
        { key: 'status', label: 'Status (status)' },
        { key: 'jobId', label: 'Job ID (jobId)' },
        { key: 'error', label: 'Error Message (error)' },
      ];
  }
}
