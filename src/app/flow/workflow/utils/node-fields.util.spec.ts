import { describe, it, expect } from 'vitest';
import { getNodeFieldsForType } from './node-fields.util';

describe('node-fields.util', () => {
  it('returns stdout, exitCode, success, stderr for script and command nodes', () => {
    const cmdFields = getNodeFieldsForType('command');
    expect(cmdFields.map(f => f.key)).toEqual(['exitCode', 'success', 'stdout', 'stderr']);

    const scriptFields = getNodeFieldsForType('exec_script');
    expect(scriptFields.map(f => f.key)).toEqual(['exitCode', 'success', 'stdout', 'stderr']);
  });

  it('returns transfer fields for sync, copy, move, etc.', () => {
    for (const type of [
      'sync',
      'copy',
      'move',
      'bisync',
      'check',
      'delete',
      'copyurl',
      'archivecreate',
      'cryptcheck',
    ]) {
      const fields = getNodeFieldsForType(type);
      expect(fields.map(f => f.key)).toEqual([
        'status',
        'bytesTransferred',
        'totalBytes',
        'jobId',
        'error',
      ]);
    }
  });

  it('returns mount-specific fields for mount node', () => {
    const fields = getNodeFieldsForType('mount');
    expect(fields.map(f => f.key)).toEqual(['mountPoint', 'remote', 'status', 'jobId']);
  });

  it('returns serve-specific fields for serve node', () => {
    const fields = getNodeFieldsForType('serve');
    expect(fields.map(f => f.key)).toEqual(['addr', 'remote', 'status', 'jobId']);
  });

  it('returns condition-specific fields for condition node', () => {
    const fields = getNodeFieldsForType('condition');
    expect(fields.map(f => f.key)).toEqual(['conditionMet', 'branch']);
  });

  it('returns rc_command-specific fields for rc_command node', () => {
    const fields = getNodeFieldsForType('rc_command');
    expect(fields.map(f => f.key)).toEqual(['status', 'result']);
  });

  it('returns fallback status/jobId/error fields for unknown or undefined type', () => {
    const fieldsUnknown = getNodeFieldsForType('unknown_type');
    expect(fieldsUnknown.map(f => f.key)).toEqual(['status', 'jobId', 'error']);

    const fieldsUndefined = getNodeFieldsForType(undefined);
    expect(fieldsUndefined.map(f => f.key)).toEqual(['status', 'jobId', 'error']);
  });
});
