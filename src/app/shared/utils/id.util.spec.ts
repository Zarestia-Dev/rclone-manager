import { generatePrefixedId } from './id.util';

describe('generatePrefixedId', () => {
  it('should generate an ID containing the provided prefix', () => {
    const id = generatePrefixedId('test-prefix');
    expect(id.startsWith('test-prefix-')).toBe(true);
  });

  it('should generate an ID without leading separator when prefix is omitted or empty', () => {
    const idWithoutArg = generatePrefixedId();
    const idWithEmpty = generatePrefixedId('');

    expect(idWithoutArg.startsWith('-')).toBe(false);
    expect(idWithEmpty.startsWith('-')).toBe(false);

    // Format: time-seq-rand (3 segments)
    expect(idWithoutArg.split('-').length).toBe(3);
    expect(idWithEmpty.split('-').length).toBe(3);
  });

  it('should generate 1000 unique IDs consecutively without collision', () => {
    const generated = new Set<string>();
    const count = 1000;

    for (let i = 0; i < count; i++) {
      generated.add(generatePrefixedId('qr'));
    }

    expect(generated.size).toBe(count);
  });

  it('should contain a decodable timestamp that matches approximately current time', () => {
    const before = Date.now();
    const id = generatePrefixedId('item');
    const after = Date.now();

    const parts = id.split('-');
    // prefix is 'item' (parts[0]), timestamp is parts[1]
    const timestamp = parseInt(parts[1], 36);

    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  it('should format sequence counter as a 3-character padded base36 string', () => {
    const id = generatePrefixedId('seq-test');
    const parts = id.split('-');
    // Sequence counter is the second to last element regardless of hyphens in prefix
    const seqPart = parts[parts.length - 2];

    expect(seqPart.length).toBe(3);
    expect(/^[0-9a-z]{3}$/.test(seqPart)).toBe(true);
  });

  it('should produce URL-safe characters only', () => {
    const id = generatePrefixedId('ui/nautilus/list-left');
    // Prefix can have '/', the rest is alphanumeric and hyphens
    expect(/^[a-zA-Z0-9_\-/]+$/.test(id)).toBe(true);
  });
});
