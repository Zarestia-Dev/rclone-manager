import { describe, expect, it } from 'vitest';
import { extractCommandOutput } from './log-output';

describe('extractCommandOutput', () => {
  it('shows a failed command even when the enclosing RC job succeeded', () => {
    const text = 'INFO: Checking\n\nNOTICE: destination is not a crypt remote\n';
    expect(
      extractCommandOutput({
        jobid: 2387,
        status: { success: true, error: '', output: { error: true, result: text } },
      })
    ).toEqual({ text, failed: true });
  });

  it('reads successful command output from a serialized response', () => {
    expect(
      extractCommandOutput({
        response: JSON.stringify({
          status: { success: true, output: { error: false, result: 'OK\n' } },
        }),
      })
    ).toEqual({ text: 'OK\n', failed: false });
  });

  it('preserves bisync output, whitespace, ANSI sequences and HTML as plain text', () => {
    const text = '\u001b[31m<error> & failure\u001b[0m\n\tmore details\n';
    expect(extractCommandOutput({ status: { success: false, output: { output: text } } })).toEqual({
      text,
      failed: true,
    });
  });

  it('supports direct output and direct core/command responses', () => {
    expect(extractCommandOutput({ output: 'plain output' })).toEqual({
      text: 'plain output',
      failed: false,
    });
    expect(extractCommandOutput({ output: { result: 'command output', error: false } })).toEqual({
      text: 'command output',
      failed: false,
    });
    expect(extractCommandOutput({ result: 'command output', error: true })).toEqual({
      text: 'command output',
      failed: true,
    });
  });

  it('falls back to RC errors when no command output is available', () => {
    expect(
      extractCommandOutput({ status: { error: 'connection failed', success: false } })
    ).toEqual({ text: 'connection failed', failed: true });
  });

  it('ignores missing, malformed and non-text output', () => {
    for (const value of [
      null,
      undefined,
      '',
      'invalid JSON',
      [],
      42,
      {},
      { output: 1 },
      { output: '' },
      { output: { error: false, result: null } },
      { response: '{broken' },
    ]) {
      expect(extractCommandOutput(value)).toBeNull();
    }
  });

  it('bounds recursion for cyclic data', () => {
    const value: Record<string, unknown> = {};
    value['status'] = value;
    expect(extractCommandOutput(value)).toBeNull();
  });
});
