import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { FormControl, FormGroup, Validators } from '@angular/forms';
import { MatIconRegistry } from '@angular/material/icon';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { Observable, of } from 'rxjs';
import { RemoteProviderOverview } from '@app/types';
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

  it('populates decorative suggestions from the available remote types', () => {
    const fixture = TestBed.createComponent(RemoteConfigStepComponent);
    fixture.componentRef.setInput('form', new FormGroup({ type: new FormControl('') }));
    fixture.detectChanges();

    fixture.componentRef.setInput('remoteTypes', [{ value: 'a', label: 'A' }]);
    fixture.detectChanges();
    expect(fixture.componentInstance.suggestedRemotes()).toEqual([
      { value: 'a', label: 'A', icon: 'cloud' },
    ]);
  });

  it('cycles the empty-state icon and stops on selection and destruction', () => {
    vi.useFakeTimers();
    vi.spyOn(TestBed.inject(IconService), 'getIconName').mockImplementation(
      name => name ?? 'cloud'
    );
    const fixture = TestBed.createComponent(RemoteConfigStepComponent);
    const form = new FormGroup({ type: new FormControl('') });
    fixture.componentRef.setInput('form', form);
    fixture.componentRef.setInput('remoteTypes', [
      { value: 'drive', label: 'Drive' },
      { value: 's3', label: 'S3' },
    ]);
    fixture.detectChanges();

    const component = fixture.componentInstance;
    vi.advanceTimersByTime(3000);
    expect(component.animTrigger()).toBe(1);
    expect(['drive', 's3']).toContain(component.randomIcon());
    const previousIcon = component.randomIcon();
    vi.advanceTimersByTime(3000);
    expect(component.randomIcon()).not.toBe(previousIcon);

    form.controls.type.setValue('drive');
    fixture.detectChanges();
    vi.advanceTimersByTime(3000);
    expect(component.animTrigger()).toBe(0);

    form.controls.type.setValue('');
    fixture.detectChanges();
    vi.advanceTimersByTime(3000);
    expect(component.animTrigger()).toBe(1);
    fixture.destroy();
    vi.advanceTimersByTime(3000);
    expect(component.animTrigger()).toBe(1);
  });
});

describe('RemoteConfigStepComponent provider overview', () => {
  let fixture: ComponentFixture<RemoteConfigStepComponent>;
  let form: FormGroup;
  let element: HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [RemoteConfigStepComponent],
      providers: [
        provideTranslateService({ lang: 'en' }),
        {
          provide: RemoteManagementService,
          useValue: { isInteractiveRemote: (): boolean => false },
        },
        { provide: IconService, useValue: { getIconName: (): string => 'cloud' } },
        { provide: UiStateService, useValue: { showJsonMode: signal(false) } },
        {
          provide: MatIconRegistry,
          useValue: {
            getNamedSvgIcon: (): Observable<SVGElement> =>
              of(document.createElementNS('http://www.w3.org/2000/svg', 'svg')),
          },
        },
      ],
    });
    TestBed.inject(TranslateService).setTranslation('en', {
      wizards: { remoteConfig: { providerOverview: { title: 'Provider features' } } },
    });
    fixture = TestBed.createComponent(RemoteConfigStepComponent);
    form = new FormGroup({ type: new FormControl('drive') });
    fixture.componentRef.setInput('form', form);
    fixture.componentRef.setInput('visibility', {
      type: false,
      name: false,
      commands: false,
      advanced: false,
    });
    element = fixture.nativeElement;
  });

  afterEach(() => TestBed.resetTestingModule());

  function setOverview(overview?: RemoteProviderOverview | null): void {
    fixture.componentRef.setInput('remoteTypes', [{ value: 'drive', label: 'Drive', overview }]);
    fixture.detectChanges();
  }

  function infoButton(): HTMLButtonElement | null {
    return element.querySelector('button[aria-label="Provider features"]');
  }

  function requiredElement<T extends HTMLElement>(selector: string): T {
    const found = element.querySelector<T>(selector);
    if (!found) throw new Error(`Missing element: ${selector}`);
    return found;
  }

  it('opens a collapsed panel from the header without submitting the form', () => {
    setOverview({ Tier: 'Tier 1', Hashes: ['md5', 'sha1'], Features: ['Copy', 'PublicLink'] });
    const submit = vi.fn();
    element.querySelector('form')?.addEventListener('submit', submit);
    const button = requiredElement<HTMLButtonElement>('button[aria-label="Provider features"]');
    expect(button.closest('.fields-mode-header')).not.toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(element.querySelector('.fields-mode-header .app-pill')?.textContent?.trim()).toBe(
      'Tier 1'
    );
    expect(element.querySelector('.provider-overview')).toBeNull();

    button.click();
    fixture.detectChanges();
    const panel = requiredElement('.provider-overview');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.textContent).toContain('md5');
    expect(panel.textContent).toContain('sha1');
    expect(panel.querySelector('a')?.getAttribute('href')).toBe('https://rclone.org/overview/');
    expect(submit).not.toHaveBeenCalled();

    button.click();
    fixture.detectChanges();
    expect(element.querySelector('.provider-overview')).toBeNull();
  });

  it.each([undefined, null])('hides the controls when overview is %s', overview => {
    setOverview(overview);
    expect(infoButton()).toBeNull();
    expect(element.querySelector('.fields-mode-header .app-pill')).toBeNull();
  });

  it.each([
    ['Tier 1', 'p-primary'],
    ['Tier 2', 'p-yellow'],
    ['Tier 3', 'p-orange'],
    ['Tier 4', 'p-warn'],
    ['Tier 5', 'p-warn'],
  ])('places %s beside the field count with the %s theme colour', (tier, colour) => {
    setOverview({ Tier: tier });
    const pill = requiredElement('.fields-mode-header > .app-pill');
    expect(pill.textContent?.trim()).toBe(tier);
    expect(Array.from(pill.classList).filter(name => name.startsWith('p-'))).toEqual([colour]);
    expect(element.querySelector('.mode-actions .app-pill')).toBeNull();
  });

  it('shows only selected provider capabilities and closes when the type changes', () => {
    setOverview({ Features: ['Copy', 'WriteMetadata', 'InternalFeature'], Hashes: [] });
    expect(fixture.componentInstance.providerCapabilities()).toEqual([
      'wizards.remoteConfig.providerOverview.copy',
      'wizards.remoteConfig.providerOverview.writeMetadata',
    ]);
    infoButton()?.click();
    fixture.detectChanges();
    form.get('type')?.setValue('other');
    fixture.detectChanges();
    expect(infoButton()).toBeNull();
    expect(element.querySelector('.provider-overview')).toBeNull();
    form.get('type')?.setValue('drive');
    fixture.detectChanges();
    expect(infoButton()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('handles null capability lists and unrecognised tiers without inventing support', () => {
    setOverview({ Tier: 'Unknown', Features: null, Hashes: null });
    infoButton()?.click();
    fixture.detectChanges();
    expect(element.querySelector('.fields-mode-header .app-pill')).toBeNull();
    const panel = requiredElement('.provider-overview');
    expect(panel.textContent).toContain('wizards.remoteConfig.providerOverview.noHashes');
    expect(panel.textContent).toContain('wizards.remoteConfig.providerOverview.noFeatures');
  });

  it('explains inherited capabilities for virtual providers', () => {
    setOverview({ Tier: 'Tier 1', Virtual: true, Features: ['Copy'], Hashes: ['md5'] });
    infoButton()?.click();
    fixture.detectChanges();
    const panel = requiredElement('.provider-overview');
    expect(panel.textContent).toContain('wizards.remoteConfig.providerOverview.virtualNote');
    expect(panel.querySelector('.provider-capabilities')).toBeNull();
    expect(fixture.componentInstance.providerCapabilities()).toEqual([]);
  });
});
