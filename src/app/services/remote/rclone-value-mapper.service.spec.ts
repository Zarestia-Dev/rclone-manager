import { TestBed } from '@angular/core/testing';
import { RcloneValueMapperService } from './rclone-value-mapper.service';
import { RcConfigOption } from '@app/types';

describe('RcloneValueMapperService', () => {
  let service: RcloneValueMapperService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [RcloneValueMapperService],
    });
    service = TestBed.inject(RcloneValueMapperService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('machineToHuman', () => {
    it('should return fallback if value is null or undefined', () => {
      expect(service.machineToHuman(null, 'string', 'fallback')).toBe('fallback');
      expect(service.machineToHuman(undefined, 'string', 'fallback')).toBe('fallback');
      expect(service.machineToHuman(null, 'string')).toBe('');
    });

    it('should format duration type correctly', () => {
      expect(service.machineToHuman(60000000000, 'Duration')).toBe('1m0s');
    });

    it('should format size types correctly', () => {
      expect(service.machineToHuman(1024, 'SizeSuffix')).toBe('1Ki');
      expect(service.machineToHuman(1024, 'BwTimetable')).toBe('1Ki');
    });

    it('should format FileMode type correctly', () => {
      expect(service.machineToHuman(18, 'FileMode')).toBe('022');
    });

    it('should return stringified value for other types', () => {
      expect(service.machineToHuman(true, 'bool')).toBe('true');
      expect(service.machineToHuman(123.45, 'float')).toBe('123.45');
    });
  });

  describe('nanosecondsToDuration', () => {
    it('should format 0 as 0s', () => {
      expect(service.nanosecondsToDuration(0)).toBe('0s');
    });

    it('should return fallback for negative values or >= 9e18', () => {
      expect(service.nanosecondsToDuration(-100, 'fallback')).toBe('fallback');
      expect(service.nanosecondsToDuration(9.1e18, 'fallback')).toBe('fallback');
      expect(service.nanosecondsToDuration(-100)).toBe('off');
    });

    it('should format standard time increments correctly', () => {
      expect(service.nanosecondsToDuration(1000000000)).toBe('1s');
      expect(service.nanosecondsToDuration(60000000000)).toBe('1m0s');
      expect(service.nanosecondsToDuration(3600000000000)).toBe('1h0m0s');
      expect(service.nanosecondsToDuration(3661000000000)).toBe('1h1m1s');
    });

    it('should format sub-second increments only if no larger units exist', () => {
      expect(service.nanosecondsToDuration(1000000)).toBe('1ms');
      expect(service.nanosecondsToDuration(1000)).toBe('1us');
      expect(service.nanosecondsToDuration(1)).toBe('1ns');
      expect(service.nanosecondsToDuration(1001000)).toBe('1ms1us');
    });
  });

  describe('bytesToSize', () => {
    it('should return off for -1', () => {
      expect(service.bytesToSize(-1)).toBe('off');
    });

    it('should return 0 for 0', () => {
      expect(service.bytesToSize(0)).toBe('0');
    });

    it('should return fallback for negative values', () => {
      expect(service.bytesToSize(-5, 'fallback')).toBe('fallback');
    });

    it('should format sizes correctly with binary units', () => {
      expect(service.bytesToSize(1024)).toBe('1Ki');
      expect(service.bytesToSize(1048576)).toBe('1Mi');
      expect(service.bytesToSize(1073741824)).toBe('1Gi');
      expect(service.bytesToSize(1099511627776)).toBe('1Ti');
      expect(service.bytesToSize(1125899906842624)).toBe('1Pi');
    });

    it('should round decimal parts to 3 decimal places', () => {
      expect(service.bytesToSize(1536)).toBe('1.5Ki');
      expect(service.bytesToSize(1200)).toBe('1.172Ki');
    });
  });

  describe('fileModeToString', () => {
    it('should return fallback for null or undefined', () => {
      expect(service.fileModeToString(null, 'fallback')).toBe('fallback');
      expect(service.fileModeToString(undefined)).toBe('');
    });

    it('should convert number modes to padded octal strings', () => {
      expect(service.fileModeToString(18)).toBe('022');
      expect(service.fileModeToString(511)).toBe('777');
    });

    it('should return fallback for negative values', () => {
      expect(service.fileModeToString(-5, 'fallback')).toBe('fallback');
    });

    it('should pad string values if needed', () => {
      expect(service.fileModeToString('22')).toBe('022');
      expect(service.fileModeToString('777')).toBe('777');
      expect(service.fileModeToString(' ')).toBe('');
    });
  });

  describe('parseFileMode', () => {
    it('should parse octal strings to number', () => {
      expect(service.parseFileMode('777')).toBe(511);
      expect(service.parseFileMode('022')).toBe(18);
    });

    it('should return original value if it is already a number or not parseable', () => {
      expect(service.parseFileMode(18)).toBe(18);
      expect(service.parseFileMode('invalid')).toBe('invalid');
      expect(service.parseFileMode(true)).toBe(true);
    });
  });

  describe('parseTristate', () => {
    it('should return null for null, undefined, empty, or un-parseable strings', () => {
      expect(service.parseTristate(null)).toBeNull();
      expect(service.parseTristate(undefined)).toBeNull();
      expect(service.parseTristate('')).toBeNull();
      expect(service.parseTristate('unset')).toBeNull();
      expect(service.parseTristate('null')).toBeNull();
      expect(service.parseTristate('[object object]')).toBeNull();
      expect(service.parseTristate('invalid')).toBeNull();
    });

    it('should parse boolean values directly', () => {
      expect(service.parseTristate(true)).toBeTrue();
      expect(service.parseTristate(false)).toBeFalse();
    });

    it('should parse valid rclone Tristate objects', () => {
      expect(service.parseTristate({ Valid: true, Value: true })).toBeTrue();
      expect(service.parseTristate({ Valid: true, Value: false })).toBeFalse();
      expect(service.parseTristate({ Valid: false, Value: true })).toBeNull();
    });

    it('should parse string representations of boolean', () => {
      expect(service.parseTristate('true')).toBeTrue();
      expect(service.parseTristate('TRUE')).toBeTrue();
      expect(service.parseTristate('false')).toBeFalse();
    });
  });

  describe('normalizeOption', () => {
    it('should parse Tristate default and value if option type is Tristate', () => {
      const opt: RcConfigOption = {
        Name: 'test',
        FieldName: 'test',
        Help: '',
        DefaultStr: 'true',
        Type: 'Tristate',
        Default: { Valid: true, Value: true },
        Value: { Valid: true, Value: false },
        Advanced: false,
      };

      const normalized = service.normalizeOption(opt);
      expect(normalized.Default).toBeTrue();
      expect(normalized.Value).toBeFalse();
    });

    it('should keep other option types identical', () => {
      const opt: RcConfigOption = {
        Name: 'test',
        FieldName: 'test',
        Help: '',
        DefaultStr: 'def',
        Type: 'string',
        Default: 'def',
        Value: 'val',
        Advanced: false,
      };

      const normalized = service.normalizeOption(opt);
      expect(normalized).toEqual(opt);
    });
  });

  describe('isDefaultValue', () => {
    it('should return true for null or undefined', () => {
      const field = { Type: 'string', Default: 'def' } as RcConfigOption;
      expect(service.isDefaultValue(null, field)).toBeTrue();
      expect(service.isDefaultValue(undefined, field)).toBeTrue();
    });

    it('should handle Tristate values correctly', () => {
      const field = {
        Type: 'Tristate',
        Default: { Valid: true, Value: true },
      } as unknown as RcConfigOption;
      expect(service.isDefaultValue(true, field)).toBeTrue();
      expect(service.isDefaultValue(false, field)).toBeFalse();
      expect(
        service.isDefaultValue(null, { ...field, Default: null, DefaultStr: 'unset' })
      ).toBeTrue();
    });

    it('should handle arrays correctly', () => {
      const field = {
        Type: 'CommaSepList',
        Default: [],
        DefaultStr: '',
      } as unknown as RcConfigOption;
      expect(service.isDefaultValue([], field)).toBeTrue();
      expect(service.isDefaultValue(['a'], field)).toBeFalse();

      const commaField = {
        Type: 'CommaSepList',
        Default: 'html, md',
        DefaultStr: 'html, md',
      } as RcConfigOption;
      expect(service.isDefaultValue(['html', 'md'], commaField)).toBeTrue();
      expect(service.isDefaultValue(['html'], commaField)).toBeFalse();
      expect(service.isDefaultValue(['md', 'html'], commaField)).toBeFalse();

      const spaceField = {
        Type: 'SpaceSepList',
        Default: 'html md',
        DefaultStr: 'html md',
      } as RcConfigOption;
      expect(service.isDefaultValue(['html', 'md'], spaceField)).toBeTrue();
    });

    it('should compare standard defaults correctly', () => {
      const field = { Type: 'string', Default: 'def', DefaultStr: 'def' } as RcConfigOption;
      expect(service.isDefaultValue('def', field)).toBeTrue();
      expect(service.isDefaultValue('', field)).toBeTrue();
      expect(service.isDefaultValue('other', field)).toBeFalse();
    });
  });

  describe('humanToMachine', () => {
    it('should parse integers correctly', () => {
      expect(service.humanToMachine('123', 'int')).toBe(123);
      expect(service.humanToMachine('123', 'uint64')).toBe(123);
      expect(service.humanToMachine('invalid', 'int')).toBe('invalid');
      expect(service.humanToMachine('', 'int')).toBe('');
    });

    it('should parse floats correctly', () => {
      expect(service.humanToMachine('123.45', 'float')).toBe(123.45);
      expect(service.humanToMachine('123.45', 'float32')).toBe(123.45);
      expect(service.humanToMachine('invalid', 'float')).toBe('invalid');
      expect(service.humanToMachine('', 'float')).toBe('');
    });

    it('should parse booleans correctly', () => {
      expect(service.humanToMachine(true, 'bool')).toBeTrue();
      expect(service.humanToMachine('true', 'bool')).toBeTrue();
      expect(service.humanToMachine('false', 'bool')).toBeFalse();
      expect(service.humanToMachine('invalid', 'bool')).toBe('invalid');
    });

    it('should parse Tristate using parseTristate', () => {
      expect(service.humanToMachine('true', 'Tristate')).toBeTrue();
      expect(service.humanToMachine('unset', 'Tristate')).toBeNull();
    });

    it('should parse FileMode using parseFileMode', () => {
      expect(service.humanToMachine('777', 'FileMode')).toBe(511);
    });

    it('should join array configurations for Encoding/Bits/DumpFlags', () => {
      expect(service.humanToMachine(['a', 'b'], 'Encoding')).toBe('a,b');
      expect(service.humanToMachine('a,b', 'Encoding')).toBe('a,b');
    });

    it('should handle CommaSepList correctly', () => {
      expect(service.humanToMachine(['a', 'b'], 'CommaSepList')).toBe('a,b');
      expect(service.humanToMachine(' a , b ', 'CommaSepList')).toBe('a,b');
    });

    it('should handle SpaceSepList correctly', () => {
      expect(service.humanToMachine(['a', 'b'], 'SpaceSepList')).toBe('a b');
      expect(service.humanToMachine(' a   b ', 'SpaceSepList')).toBe('a b');
    });

    it('should return original value for unhandled types', () => {
      expect(service.humanToMachine('val', 'string')).toBe('val');
    });
  });
});
