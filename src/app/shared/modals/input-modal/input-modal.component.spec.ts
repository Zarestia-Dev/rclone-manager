import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { InputModalComponent, InputModalData } from './input-modal.component';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { ValidatorRegistryService } from 'src/app/services/ui/validation/validator-registry.service';

describe('InputModalComponent', () => {
  let fixture: ComponentFixture<InputModalComponent>;
  let component: InputModalComponent;
  let dialogRefSpy: { close: ReturnType<typeof vi.fn> };
  let pathServiceSpy: { getFilename: ReturnType<typeof vi.fn> };
  let validatorRegistrySpy: {
    createUniqueNameValidator: ReturnType<typeof vi.fn>;
    createForbiddenCharsValidator: ReturnType<typeof vi.fn>;
  };

  const defaultMockData: InputModalData = {
    title: 'Create Folder',
    icon: 'folder',
    label: 'Folder Name',
    placeholder: 'Enter name',
    initialValue: 'New Folder',
  };

  async function setupTestBed(data: InputModalData = defaultMockData): Promise<void> {
    dialogRefSpy = { close: vi.fn() };
    pathServiceSpy = {
      getFilename: vi.fn((p: string) => p.split('/').pop() || ''),
    };
    validatorRegistrySpy = {
      createUniqueNameValidator: vi.fn().mockReturnValue(() => null),
      createForbiddenCharsValidator: vi.fn().mockReturnValue(() => null),
    };

    await TestBed.configureTestingModule({
      imports: [InputModalComponent],
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: dialogRefSpy },
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: PathService, useValue: pathServiceSpy },
        { provide: ValidatorRegistryService, useValue: validatorRegistrySpy },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(InputModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  describe('Initialization with default field', () => {
    beforeEach(async () => {
      await setupTestBed();
    });

    it('should create component', () => {
      expect(component).toBeTruthy();
    });

    it('should initialize with a single default field', () => {
      expect(component.fields.length).toBe(1);
      expect(component.fields[0].key).toBe('single');
      expect(component.form.get('single')?.value).toBe('New Folder');
    });

    it('should render header, main, and footer elements', () => {
      const element: HTMLElement = fixture.nativeElement;
      expect(element.querySelector('header')).toBeTruthy();
      expect(element.querySelector('main')).toBeTruthy();
      expect(element.querySelector('footer')).toBeTruthy();
    });

    it('should close dialog with trimmed string on confirm', () => {
      component.form.get('single')?.setValue('  My Folder  ');
      component.onConfirm();
      expect(dialogRefSpy.close).toHaveBeenCalledWith('My Folder');
    });

    it('should close dialog with null on cancel', () => {
      component.onCancel();
      expect(dialogRefSpy.close).toHaveBeenCalledWith(null);
    });

    it('should close dialog with null on escape key', () => {
      component.onEscapeKey();
      expect(dialogRefSpy.close).toHaveBeenCalledWith(null);
    });
  });

  describe('Initialization with multiple fields (copy URL)', () => {
    const multiFieldData: InputModalData = {
      title: 'Download from URL',
      icon: 'download',
      fields: [
        {
          key: 'url',
          label: 'URL',
          type: 'url',
          required: true,
        },
        {
          key: 'filename',
          label: 'File Name',
          required: false,
        },
      ],
      showUrlPreview: true,
    };

    beforeEach(async () => {
      await setupTestBed(multiFieldData);
    });

    it('should initialize multiple fields and identify URL field', () => {
      expect(component.fields.length).toBe(2);
      expect(component.hasUrlField()).toBe(true);
      expect(component.form.get('url')).toBeTruthy();
      expect(component.form.get('filename')).toBeTruthy();
    });

    it('should close dialog with full object on confirm', () => {
      component.form.get('url')?.setValue('https://example.com/test.zip');
      component.form.get('filename')?.setValue('custom.zip');
      component.onConfirm();
      expect(dialogRefSpy.close).toHaveBeenCalledWith({
        url: 'https://example.com/test.zip',
        filename: 'custom.zip',
      });
    });

    it('should automatically infer filename when URL changes and filename is pristine', () => {
      component.form.get('url')?.setValue('https://example.com/files/archive.tar.gz');
      expect(component.form.get('filename')?.value).toBe('archive.tar.gz');
    });
  });
});
