import { computed } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigSearchService } from './config-search.service';

describe('ConfigSearchService', () => {
  const field = {
    Name: 'shared_with_me',
    FieldName: '',
    Help: 'Only show files that are shared with me.',
    Type: 'bool',
    DefaultStr: 'false',
  };
  let service: ConfigSearchService;
  let translate: TranslateService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideTranslateService({ lang: 'tr' })] });
    translate = TestBed.inject(TranslateService);
    translate.setTranslation('tr', {
      providers: {
        drive: {
          shared_with_me: { title: 'Benimle Paylaşılanlar', help: 'Paylaşılan dosyaları göster.' },
        },
      },
      create_empty_src_dirs: { title: 'Boş kaynak dizinleri oluştur' },
      settings: { source: 'Kaynak yolu' },
    });
    translate.setTranslation('en', {
      providers: { drive: { shared_with_me: { title: 'Shared with me' } } },
    });
    translate.use('tr');
    service = TestBed.inject(ConfigSearchService);
  });

  it('finds translated titles and help while retaining raw names and English help', () => {
    for (const query of [
      'Benimle Paylaşılanlar',
      'dosyaları göster',
      'shared_with_me',
      'only files',
      '--drive-shared-with-me',
    ]) {
      expect(service.matches(field, query, 'drive')).toBe(true);
    }
    expect(service.matches(field, 'providers.drive.shared_with_me', 'drive')).toBe(false);
    expect(service.matches(field, '--s3-shared-with-me', 'drive')).toBe(false);
  });

  it('does not resolve translations for empty searches or CLI flags', () => {
    const instant = vi.spyOn(translate, 'instant');
    expect(service.matches(field, ' \t ', 'drive')).toBe(true);
    expect(service.matches(field, '--drive-shared-with-me', 'drive')).toBe(true);
    expect(service.matches(field, '--s3-shared-with-me', 'drive')).toBe(false);
    expect(service.matchesText(' \t ', [], ['settings.source'])).toBe(true);
    expect(instant).not.toHaveBeenCalled();
  });

  it('uses global translations for camelCase options', () => {
    expect(service.matches({ ...field, Name: 'createEmptySrcDirs' }, 'kaynak dizinleri')).toBe(
      true
    );
  });

  it('recomputes cached matches after changing language', () => {
    const match = computed(() => service.matches(field, 'Benimle Paylaşılanlar', 'drive'));
    expect(match()).toBe(true);
    translate.use('en');
    expect(match()).toBe(false);
  });

  it('recomputes cached matches when translations load in the same language', () => {
    const match = computed(() => service.matches(field, 'Yeni başlık', 'drive'));
    expect(match()).toBe(false);
    translate.setTranslation(
      'tr',
      { providers: { drive: { shared_with_me: { title: 'Yeni başlık' } } } },
      true
    );
    expect(match()).toBe(true);
  });

  it('refreshes option and metadata matches when the fallback language changes', () => {
    translate.setTranslation(
      'en',
      {
        fallback_only: { title: 'Fallback label' },
        fallbackLabel: 'Fallback label',
      },
      true
    );
    translate.setTranslation('de', {
      fallback_only: { title: 'Ausweichtext' },
      fallbackLabel: 'Ausweichtext',
    });
    translate.setFallbackLang('en');
    const optionMatch = computed(() =>
      service.matches({ ...field, Name: 'fallback_only' }, 'Ausweichtext')
    );
    const metadataMatch = computed(() =>
      service.matchesText('Ausweichtext', [], ['fallbackLabel'])
    );
    expect(optionMatch()).toBe(false);
    expect(metadataMatch()).toBe(false);
    translate.setFallbackLang('de');
    expect(optionMatch()).toBe(true);
    expect(metadataMatch()).toBe(true);
  });

  it('shares word matching for metadata, translated labels and category context', () => {
    expect(
      service.matchesText('  kaynak  yolu ', ['general.source_path'], ['settings.source'])
    ).toBe(true);
    expect(service.matchesText('source path', ['general.source_path'])).toBe(true);
    expect(service.matchesText('unrelated  query', ['source', 'path'])).toBe(false);
    expect(service.matches(field, 'general shared', null, ['vfs', 'General'])).toBe(true);
    expect(service.matches(field, ' \t ')).toBe(true);
  });
});
