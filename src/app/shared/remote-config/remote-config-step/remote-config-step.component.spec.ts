import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { FormControl, FormGroup, Validators } from '@angular/forms';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteConfigStepComponent } from './remote-config-step.component';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';

describe('RemoteConfigStepComponent field state', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [RemoteConfigStepComponent],
      providers: [
        {
          provide: RemoteManagementService,
          useValue: { isInteractiveRemote: (): boolean => false },
        },
        { provide: IconService, useValue: { getIconName: (): string => 'cloud' } },
        { provide: UiStateService, useValue: { showJsonMode: signal(false) } },
      ],
    }).overrideComponent(RemoteConfigStepComponent, { set: { template: '', imports: [] } });
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('excludes hidden provider requirements from the parent form', () => {
    const fixture = TestBed.createComponent(RemoteConfigStepComponent);
    const form = new FormGroup({
      type: new FormControl('s3'),
      name: new FormControl('drive'),
      provider: new FormControl('aws'),
      aws_secret: new FormControl('value', Validators.required),
      other_secret: new FormControl('', Validators.required),
    });
    fixture.componentRef.setInput('form', form);
    fixture.componentRef.setInput('remoteFields', [
      {
        Name: 'provider',
        FieldName: 'provider',
        Type: 'string',
        DefaultStr: '',
        Help: '',
        Examples: [{ Value: 'aws' }, { Value: 'other' }],
      },
      {
        Name: 'aws_secret',
        FieldName: 'aws_secret',
        Type: 'string',
        DefaultStr: '',
        Help: '',
        Provider: 'aws',
        Required: true,
      },
      {
        Name: 'other_secret',
        FieldName: 'other_secret',
        Type: 'string',
        DefaultStr: '',
        Help: '',
        Provider: 'other',
        Required: true,
      },
    ]);
    fixture.detectChanges();
    expect(form.controls.other_secret.disabled).toBe(true);
    expect(form.valid).toBe(true);
    form.controls.provider.setValue('other');
    fixture.detectChanges();
    expect(form.controls.aws_secret.disabled).toBe(true);
    expect(form.controls.other_secret.enabled).toBe(true);
    expect(form.invalid).toBe(true);
  });

  it('accepts an explicitly empty command-options input', () => {
    const fixture = TestBed.createComponent(RemoteConfigStepComponent);
    fixture.componentRef.setInput('form', new FormGroup({ type: new FormControl('drive') }));
    fixture.componentRef.setInput('initialCommandOptions', []);
    fixture.detectChanges();
    expect(fixture.componentInstance.commandOptions()).toEqual([]);
  });

  it('updates decorative suggestions without scheduling a timer', () => {
    const fixture = TestBed.createComponent(RemoteConfigStepComponent);
    fixture.componentRef.setInput('form', new FormGroup({ type: new FormControl('') }));
    fixture.detectChanges();

    fixture.componentRef.setInput('remoteTypes', [{ value: 'a', label: 'A' }]);
    fixture.detectChanges();
    expect(fixture.componentInstance.suggestedRemotes()).toEqual([
      { value: 'a', label: 'A', icon: 'cloud' },
    ]);
  });
});
