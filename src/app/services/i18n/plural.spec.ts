import { TestBed } from '@angular/core/testing';
import {
  provideTranslateCompiler,
  provideTranslateService,
  TranslateService,
} from '@ngx-translate/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { PluralCompiler, pluralCategory } from './plural';

describe('plural', () => {
  describe('pluralCategory', () => {
    // The forms the compiler tests below do not reach: Russian and Ukrainian `many`.
    it('uses Russian and Ukrainian one/few/many', () => {
      for (const lang of ['ru-RU', 'uk-UA']) {
        expect(pluralCategory(lang, 21)).toBe('one');
        expect(pluralCategory(lang, 22)).toBe('few');
        expect(pluralCategory(lang, 11)).toBe('many');
        expect(pluralCategory(lang, 25)).toBe('many');
      }
    });

    it('falls back to English for a missing or invalid language', () => {
      expect(pluralCategory(null, 1)).toBe('one');
      expect(pluralCategory('not a lang!', 1)).toBe('one');
    });
  });

  describe('PluralCompiler', () => {
    let translate: TranslateService;

    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [
          provideTranslateService({ compiler: provideTranslateCompiler(PluralCompiler) }),
        ],
      });
      translate = TestBed.inject(TranslateService);
      translate.setTranslation('en-US', {
        files: { one: '{{count}} file', other: '{{count}} files' },
        plain: 'Hello {{name}}',
        nested: { deep: { jobs: { one: '{{count}} job', other: '{{count}} jobs' } } },
      });
      translate.setTranslation('sk-SK', {
        files: { one: '{{count}} súbor', few: '{{count}} súbory', other: '{{count}} súborov' },
      });
      translate.setTranslation('ja-JP', { files: { other: '{{count}} 個のファイル' } });
      translate.setTranslation('sk-OTHER', { files: { other: '{{count}} súborov' } });
    });

    it('shows the form of the current language for count', () => {
      translate.use('sk-SK');
      expect(translate.instant('files', { count: 1 })).toBe('1 súbor');
      expect(translate.instant('files', { count: 3 })).toBe('3 súbory');
      expect(translate.instant('files', { count: 5 })).toBe('5 súborov');
      expect(translate.instant('files', { count: 0 })).toBe('0 súborov');
    });

    it('follows a language change', () => {
      translate.use('en-US');
      expect(translate.instant('files', { count: 1 })).toBe('1 file');
      translate.use('sk-SK');
      expect(translate.instant('files', { count: 3 })).toBe('3 súbory');
    });

    it('reads a count that arrives as text, like a backend message parameter', () => {
      translate.use('en-US');
      expect(translate.instant('files', { count: '1' })).toBe('1 file');
      expect(translate.instant('files', { count: '4' })).toBe('4 files');
    });

    it('falls back to other when the form is not translated or count is missing', () => {
      translate.use('sk-OTHER');
      expect(translate.instant('files', { count: 1 })).toBe('1 súborov');
      translate.use('en-US');
      expect(translate.instant('files')).toBe('{{count}} files');
      expect(translate.instant('files', { count: 'many' })).toBe('many files');
    });

    it('keeps a language with one form working', () => {
      translate.use('ja-JP');
      expect(translate.instant('files', { count: 1 })).toBe('1 個のファイル');
    });

    it('leaves plain strings and nested objects alone', () => {
      translate.use('en-US');
      expect(translate.instant('plain', { name: 'x' })).toBe('Hello x');
      const nestedKey = ['nested', 'deep', 'jobs'].join('.');
      expect(translate.instant(nestedKey, { count: 1 })).toBe('1 job');
      expect(translate.instant(nestedKey, { count: 2 })).toBe('2 jobs');
    });
  });
});
