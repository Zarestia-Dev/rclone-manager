import { DestroyRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormArray, FormBuilder, FormControl, FormGroup, Validators } from '@angular/forms';
import { describe, expect, it, vi } from 'vitest';
import { ALL_PRIMARY_ACTIONS, RcConfigOption } from '@app/types';
import {
  createConfigFormGroup,
  patchConfigOptions,
  patchConfigPaths,
  reconcileDynamicControls,
} from './config-form.utils';

const field = (name: string, value: RcConfigOption['Default'] = ''): RcConfigOption => ({
  Name: name,
  FieldName: name,
  Help: '',
  Type: 'string',
  Default: value,
  DefaultStr: String(value ?? ''),
});

describe('configuration forms', () => {
  const create = (
    type: Parameters<typeof createConfigFormGroup>[1],
    values?: Record<string, unknown>
  ): FormGroup =>
    TestBed.runInInjectionContext(() =>
      createConfigFormGroup(new FormBuilder(), type, TestBed.inject(DestroyRef), values)
    );

  it.each(ALL_PRIMARY_ACTIONS)('constructs a usable %s form from the canonical registry', type => {
    const group = create(type);
    expect(group.get('source')).toBeTruthy();
    expect(group.get('options')).toBeInstanceOf(FormGroup);
    expect(group.get('watchDelay')?.value).toBe(5);
  });

  it('uses single paths for archive creation and arrays for cryptcheck', () => {
    expect(create('archivecreate').get('source')).toBeInstanceOf(FormGroup);
    expect(create('cryptcheck').get('source')).toBeInstanceOf(FormArray);
    expect(create('serve').get('dest')).toBeNull();
    expect(create('mount').get('options.mountType')?.value).toBe('mount');
    expect(create('serve').get('options.type')?.value).toBe('http');
  });

  it('revalidates automation requirements when their switches change', () => {
    const group = create('sync');
    group.get('cronEnabled')?.setValue(true);
    expect(group.get('cronExpression')?.hasError('required')).toBe(true);
    group.get('cronExpression')?.setValue('0 * * * *');
    expect(group.valid).toBe(true);
    group.get('watchEnabled')?.setValue(true);
    group.get('watchDelay')?.setValue(0);
    expect(group.valid).toBe(true);
    group.get('watchDelay')?.setValue('');
    expect(group.get('watchDelay')?.hasError('required')).toBe(true);
    group.get('watchEnabled')?.setValue(false);
    expect(group.valid).toBe(true);
  });

  it('preserves seeded option arrays and nulls as control values', () => {
    const group = create('sync', { options: { include: ['a', 'b'], token: null } });
    expect(group.get('options.include')?.value).toEqual(['a', 'b']);
    expect(group.get('options.token')?.value).toBeNull();
  });

  it('preserves matching serve controls, their edits and their validators', () => {
    const user = new FormControl("a'b,c", Validators.required);
    const group = new FormGroup({
      type: new FormControl('webdav'),
      user,
      obsolete: new FormControl('old'),
    });
    const changed = vi.fn();
    group.valueChanges.subscribe(changed);
    reconcileDynamicControls(group, [field('user'), field('pass')], {
      preserveKeys: new Set(['type']),
      prune: true,
    });
    expect(group.get('user')).toBe(user);
    expect(user.value).toBe("a'b,c");
    expect(user.hasValidator(Validators.required)).toBe(true);
    expect(group.get('obsolete')).toBeNull();
    expect(changed).toHaveBeenCalledOnce();
  });

  it('resets provider fields while preserving identity and supports optional runtime overrides', () => {
    const group = new FormGroup({
      name: new FormControl('drive'),
      old: new FormControl('credential'),
    });
    reconcileDynamicControls(group, [{ ...field('token'), Required: true }], {
      reset: true,
      preserveKeys: new Set(['name']),
      required: false,
    });
    expect(group.getRawValue()).toEqual({ name: 'drive', token: '' });
    expect(group.valid).toBe(true);
  });

  it('patches aliases and custom options with a single aggregate update', () => {
    const group = new FormGroup({ ReadOnly: new FormControl(false) });
    const changed = vi.fn();
    group.valueChanges.subscribe(changed);
    patchConfigOptions(group, { read_only: true, header: ['X: a', 'X: b'] }, [
      { ...field('ReadOnly'), FieldName: 'read_only' },
    ]);
    expect(group.getRawValue()).toEqual({ ReadOnly: true, header: ['X: a', 'X: b'] });
    expect(changed).toHaveBeenCalledOnce();
  });

  it('replaces imported multi-source paths and notifies path observers', () => {
    const group = create('sync');
    const changed = vi.fn();
    group.get('source')?.valueChanges.subscribe(changed);
    patchConfigPaths(group, {
      source: [
        { type: 'currentRemote', path: 'photos' },
        { type: 'local', path: '/tmp/a b' },
      ],
      dest: { type: 'otherRemote:backup', remote: 'backup', path: 'saved' },
    });
    expect((group.get('source') as FormArray).length).toBe(2);
    expect(group.get('source.1.path')?.value).toBe('/tmp/a b');
    expect(group.get('dest.remote')?.value).toBe('backup');
    expect(changed).toHaveBeenCalledOnce();
  });
  it('retains one editable source when a profile has no saved paths', () => {
    const group = create('sync');
    patchConfigPaths(group, { source: [] });
    expect((group.get('source') as FormArray).length).toBe(1);
    expect(group.get('source.0.path')?.value).toBe('');
  });
  it('removes obsolete metadata requirements while retaining caller validators', () => {
    const group = new FormGroup({ custom: new FormControl('', Validators.minLength(3)) });
    reconcileDynamicControls(group, [{ ...field('custom'), Required: true }]);
    expect(group.get('custom')?.hasError('required')).toBe(true);
    reconcileDynamicControls(group, [field('custom')]);
    expect(group.get('custom')?.hasError('required')).toBe(false);
    group.get('custom')?.setValue('x');
    expect(group.get('custom')?.hasError('minlength')).toBe(true);
  });

  it.each(['', null])('validates a new required field immediately with value %s', value => {
    const group = new FormGroup({});
    reconcileDynamicControls(group, [{ ...field('credential', value), Required: true }]);

    expect(group.get('credential')?.hasError('required')).toBe(true);
    expect(group.invalid).toBe(true);

    (group.get('credential') as unknown as FormControl<string | null>).setValue('provided');
    expect(group.valid).toBe(true);
  });

  it('accepts a new required field with an existing value', () => {
    const group = new FormGroup({});
    reconcileDynamicControls(group, [{ ...field('credential', 'provided'), Required: true }]);

    expect(group.get('credential')?.valid).toBe(true);
    expect(group.valid).toBe(true);
  });

  it('can make runtime metadata optional without removing explicit caller requirements', () => {
    const group = new FormGroup({ explicit: new FormControl('', Validators.required) });
    reconcileDynamicControls(group, [
      { ...field('explicit'), Required: true },
      { ...field('optional'), Required: true },
    ]);
    reconcileDynamicControls(group, [field('explicit'), field('optional')], { required: false });
    expect(group.get('explicit')?.hasError('required')).toBe(true);
    expect(group.get('optional')?.hasError('required')).toBe(false);
  });
});
