import { describe, expect, it } from 'vitest';
import { formatCronHumanReadable, getCronstrueLocale } from './cron-locale.mapper';

describe('cron-locale.mapper', () => {
  describe('getCronstrueLocale', () => {
    it('should return default en when appLocale is empty', () => {
      expect(getCronstrueLocale('')).toBe('en');
    });

    it('should correctly map Chinese locales (zh-TW and zh-CN)', () => {
      expect(getCronstrueLocale('zh-TW')).toBe('zh_TW');
      expect(getCronstrueLocale('zh-tw')).toBe('zh_TW');
      expect(getCronstrueLocale('zh-CN')).toBe('zh_CN');
      expect(getCronstrueLocale('zh-cn')).toBe('zh_CN');
      expect(getCronstrueLocale('zh')).toBe('zh_CN');
    });

    it('should correctly map Portuguese locales (pt-BR and pt-PT)', () => {
      expect(getCronstrueLocale('pt-BR')).toBe('pt_BR');
      expect(getCronstrueLocale('pt-br')).toBe('pt_BR');
      expect(getCronstrueLocale('pt-PT')).toBe('pt_PT');
    });

    it('should extract two-letter language codes for standard languages', () => {
      expect(getCronstrueLocale('en-US')).toBe('en');
      expect(getCronstrueLocale('tr-TR')).toBe('tr');
      expect(getCronstrueLocale('es-ES')).toBe('es');
      expect(getCronstrueLocale('fr-FR')).toBe('fr');
      expect(getCronstrueLocale('ja-JP')).toBe('ja');
      expect(getCronstrueLocale('ru-RU')).toBe('ru');
      expect(getCronstrueLocale('uk-UA')).toBe('uk');
    });
  });

  describe('formatCronHumanReadable', () => {
    it('should return empty string for empty cron expression', () => {
      expect(formatCronHumanReadable('', 'zh-TW')).toBe('');
    });

    it('should format cron expression in Traditional Chinese', () => {
      const result = formatCronHumanReadable('0 0 * * *', 'zh-TW');
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });

    it('should fallback gracefully on invalid cron expression', () => {
      expect(formatCronHumanReadable('invalid-cron', 'zh-TW')).toBe('invalid-cron');
    });
  });
});
