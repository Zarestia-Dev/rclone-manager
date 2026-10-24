import { describe, expect, it } from 'vitest';
import { translateRcloneOption } from './rclone-option-translation';

describe('translateRcloneOption', () => {
  const dictionary: Record<string, unknown> = {
    'providers.drive.shared_with_me.title': 'Benimle Paylaşılanlar',
    'shared_with_me.title': 'Shared files',
    'create_empty_src_dirs.help': 'Create directories',
  };
  const translate = (key: string): unknown => dictionary[key] ?? key;

  it('prefers provider translations and falls back to global translations', () => {
    expect(translateRcloneOption('shared_with_me', 'title', '', translate, 'drive')).toBe(
      'Benimle Paylaşılanlar'
    );
    expect(translateRcloneOption('shared_with_me', 'title', '', translate, 'other')).toBe(
      'Shared files'
    );
  });

  it.each(['createEmptySrcDirs', 'create-empty-src-dirs', 'create_empty_src_dirs'])(
    'resolves the canonical translation key for %s',
    name => expect(translateRcloneOption(name, 'help', '', translate)).toBe('Create directories')
  );

  it('preserves fallbacks for empty names, missing keys and invalid translations', () => {
    expect(translateRcloneOption('', 'title', 'Fallback', translate)).toBe('Fallback');
    expect(translateRcloneOption('missing', 'help', 'Fallback', translate)).toBe('Fallback');
    expect(translateRcloneOption('missing', 'help', 'Fallback', () => null)).toBe('Fallback');
    expect(translateRcloneOption('missing', 'help', 'Fallback', () => ({ title: 'nested' }))).toBe(
      'Fallback'
    );
  });
});
