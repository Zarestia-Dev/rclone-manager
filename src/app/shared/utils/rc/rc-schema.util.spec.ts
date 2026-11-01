import { describe, it, expect } from 'vitest';
import { RcCommandInfo } from '@app/types';
import { RcParamInfo } from './rc-help.util';
import { annotateParams, paramsOf, requiredParams } from './rc-schema.util';

const param = (name: string, optional = false): RcParamInfo => ({
  name,
  description: `${name} text`,
  optional,
});

describe('rc-schema.util', () => {
  describe('requiredParams', () => {
    it('knows the checked calls and nothing else', () => {
      expect(requiredParams('operations/list')).toEqual(['fs', 'remote']);
      expect(requiredParams('sync/copy')).toEqual(['srcFs', 'dstFs']);
      expect(requiredParams('vfs/refresh')).toEqual([]);
      expect(requiredParams('made/up')).toEqual([]);
    });
  });

  describe('annotateParams', () => {
    it('marks required parameters, keeps their description and puts them first', () => {
      const out = annotateParams('operations/list', [
        param('opt', true),
        param('remote'),
        param('fs'),
      ]);
      expect(out.map(p => p.name)).toEqual(['fs', 'remote', 'opt']);
      expect(out.map(p => p.required === true)).toEqual([true, true, false]);
      expect(out[0].description).toBe('fs text');
    });

    it('adds a required parameter the help does not list', () => {
      const out = annotateParams('operations/copyurl', [param('fs'), param('remote')]);
      expect(out.map(p => p.name)).toEqual(['fs', 'remote', 'url']);
      expect(out[2]).toEqual({ name: 'url', description: '', optional: false, required: true });
    });

    it('returns the parsed list unchanged for an unchecked call', () => {
      const parsed = [param('a'), param('b', true)];
      expect(annotateParams('vfs/refresh', parsed)).toEqual(parsed);
      expect(annotateParams('vfs/refresh', parsed)).not.toBe(parsed);
    });
  });

  describe('paramsOf', () => {
    const command: RcCommandInfo = {
      Path: 'operations/list',
      Title: 'List',
      Help: 'Parameters:\n\n- fs - a remote name\n- opt - options (optional)\n',
    };

    it('marks the required parameters of the call and puts them first', () => {
      const params = paramsOf(command);
      expect(params.map(p => p.name)).toEqual(['fs', 'remote', 'opt']);
      expect(params[0].required).toBe(true);
    });

    it('parses the help once per call', () => {
      expect(paramsOf(command)).toBe(paramsOf(command));
      expect(paramsOf({ ...command })).not.toBe(paramsOf(command));
    });
  });
});
