import { Injectable, inject, WritableSignal, Signal } from '@angular/core';
import {
  FormBuilder,
  FormGroup,
  Validators,
  FormControl,
  AbstractControl,
  FormArray,
} from '@angular/forms';
import {
  FlagType,
  SharedProfileType,
  FLAG_TYPES,
  REMOTE_NAME_REGEX,
  DEFAULT_PROFILE_NAME,
  REMOTE_CONFIG_KEYS,
  RemoteConfigSections,
  RcConfigOption,
  EditTarget,
} from '@app/types';
import { ValidatorRegistryService } from '../ui/validation/validator-registry.service';
import { PathService } from '../infrastructure/platform/path.service';
import { LINKED_PROFILE_TYPES } from './remote-config-profile-manager.service';
import { DialogData } from './remote-config-state.service';

export interface PendingRemoteData {
  name: string;
  type: string;
  [key: string]: unknown;
}

// Shared field list for all sync-like operations (sync, copy, move, bisync)
const OPERATION_FIELDS = [
  'autoStart',
  'cronEnabled',
  'cronExpression',
  'watchEnabled',
  'watchDelay',
  'source',
  'dest',
] as const;

// Default values for known boolean/numeric fields when building form groups
const FIELD_DEFAULTS: Record<string, unknown> = {
  autoStart: false,
  cronEnabled: false,
  watchEnabled: false,
  watchDelay: 5,
};

@Injectable()
export class RemoteConfigFormBuilderService {
  private readonly fb = inject(FormBuilder);
  private readonly validatorRegistry = inject(ValidatorRegistryService);
  private readonly pathService = inject(PathService);

  private static readonly FLAG_TYPE_FIELDS: Partial<Record<string, readonly string[]>> = {
    mount: ['autoStart', 'dest', 'source', 'type'],
    sync: OPERATION_FIELDS,
    copy: OPERATION_FIELDS,
    move: OPERATION_FIELDS,
    bisync: OPERATION_FIELDS,
  };

  private getFieldsForFlagType(type: string): readonly string[] {
    return RemoteConfigFormBuilderService.FLAG_TYPE_FIELDS[type] ?? [];
  }

  createRemoteForm(existingRemotes: string[], isEdit: boolean, isClone: boolean): FormGroup {
    return this.fb.group({
      name: [
        '',
        [
          Validators.required,
          Validators.pattern(REMOTE_NAME_REGEX),
          ...(isEdit && !isClone
            ? []
            : [this.validatorRegistry.createRemoteNameValidator(existingRemotes)]),
        ],
      ],
      type: ['', [Validators.required]],
    });
  }

  createRemoteConfigForm(_dynamicFlagFields: Record<FlagType, RcConfigOption[]>): FormGroup {
    const group: Record<string, AbstractControl> = {};

    for (const flag of FLAG_TYPES) {
      group[`${flag}Config`] =
        flag === 'serve'
          ? this.createServeConfigGroup()
          : this.createConfigGroup(flag, this.getFieldsForFlagType(flag));
    }
    group['runtimeRemoteConfig'] = this.createRuntimeRemoteConfigGroup('');

    return this.fb.group(group);
  }

  createRuntimeRemoteConfigGroup(initialType: string): FormGroup {
    return this.fb.group({
      type: [initialType, Validators.required],
    });
  }

  private createServeConfigGroup(): FormGroup {
    return this.fb.group({
      autoStart: [false],
      cronEnabled: [false],
      cronExpression: [null],
      source: this.fb.group({ type: ['currentRemote'], path: [''], remote: [''] }),
      type: ['http', Validators.required],
      vfsProfile: [DEFAULT_PROFILE_NAME],
      filterProfile: [DEFAULT_PROFILE_NAME],
      backendProfile: [DEFAULT_PROFILE_NAME],
      runtimeRemoteProfile: [DEFAULT_PROFILE_NAME],
      options: this.fb.group({}),
    });
  }

  private createConfigGroup(
    flagType: string,
    fields: readonly string[],
    includeProfiles = true
  ): FormGroup {
    const group: Record<string, unknown> = {};

    for (const field of fields) {
      if (field in FIELD_DEFAULTS) {
        group[field] = [FIELD_DEFAULTS[field]];
      } else if (field !== 'source' && field !== 'dest') {
        group[field] = [''];
      }
    }

    if (fields.includes('source')) {
      const sourceGroup = this.fb.group({ type: ['currentRemote'], path: [''], remote: [''] });
      group['source'] =
        flagType === 'mount' || flagType === 'serve' || flagType === 'bisync'
          ? sourceGroup
          : this.fb.array([sourceGroup]);
    }

    if (fields.includes('dest')) {
      group['dest'] = this.fb.group({ type: ['local'], path: [''], remote: [''] });
    }

    if (fields.includes('autoStart') && !fields.includes('type')) {
      group['cronExpression'] = [null];
    }

    if (includeProfiles && LINKED_PROFILE_TYPES.has(flagType)) {
      group['vfsProfile'] = [DEFAULT_PROFILE_NAME];
      group['filterProfile'] = [DEFAULT_PROFILE_NAME];
      group['backendProfile'] = [DEFAULT_PROFILE_NAME];
      group['runtimeRemoteProfile'] = [DEFAULT_PROFILE_NAME];
    }

    group['options'] = this.fb.group({});
    return this.fb.group(group);
  }

  addDynamicFieldsToForm(
    remoteConfigForm: FormGroup,
    dynamicFlagFields: Record<FlagType, RcConfigOption[]>,
    getUniqueControlKey: (flagType: FlagType, field: RcConfigOption) => string,
    optionToFlagTypeMap: Record<string, FlagType>,
    optionToFieldNameMap: Record<string, string>
  ): void {
    for (const flagType of FLAG_TYPES) {
      const optionsGroup = remoteConfigForm.get(`${flagType}Config.options`) as FormGroup;
      if (!optionsGroup || !dynamicFlagFields[flagType]) continue;

      for (const field of dynamicFlagFields[flagType]) {
        const uniqueKey = getUniqueControlKey(flagType, field);
        optionToFlagTypeMap[uniqueKey] = flagType;
        optionToFieldNameMap[uniqueKey] = field.FieldName;
        optionsGroup.addControl(
          uniqueKey,
          new FormControl(field.Value ?? field.Default, field.Required ? [Validators.required] : [])
        );
      }
    }
  }

  replaceDynamicFormControls(remoteForm: FormGroup, dynamicRemoteFields: RcConfigOption[]): void {
    for (const key of Object.keys(remoteForm.controls)) {
      if (key !== 'name' && key !== 'type') remoteForm.removeControl(key);
    }
    for (const field of dynamicRemoteFields) {
      remoteForm.addControl(
        field.Name,
        new FormControl(field.Value ?? field.Default, field.Required ? [Validators.required] : [])
      );
    }
  }

  replaceRuntimeRemoteFormControls(
    remoteConfigForm: FormGroup,
    dynamicRuntimeRemoteFields: RcConfigOption[]
  ): void {
    const group = remoteConfigForm.get('runtimeRemoteConfig') as FormGroup;
    if (!group) return;
    for (const key of Object.keys(group.controls)) {
      if (key !== 'type') group.removeControl(key);
    }
    for (const field of dynamicRuntimeRemoteFields) {
      group.addControl(field.Name, new FormControl(field.Value ?? field.Default));
    }
  }

  rebuildServeOptionsGroup(
    remoteConfigForm: FormGroup,
    dynamicServeFields: RcConfigOption[]
  ): void {
    const optionsGroup = remoteConfigForm.get('serveConfig.options') as FormGroup;
    if (!optionsGroup) return;
    for (const key of Object.keys(optionsGroup.controls)) {
      optionsGroup.removeControl(key);
    }
    for (const field of dynamicServeFields) {
      optionsGroup.addControl(
        field.FieldName || field.Name,
        new FormControl(field.Value ?? field.Default, field.Required ? [Validators.required] : [])
      );
    }
  }

  isDefaultValue(value: unknown, field: RcConfigOption): boolean {
    if (value === null || value === undefined) return true;
    const strVal = String(value);
    return strVal === String(field.Default) || strVal === String(field.DefaultStr) || strVal === '';
  }

  private cleanServeOptions(
    options: Record<string, unknown>,
    dynamicServeFields: RcConfigOption[]
  ): Record<string, unknown> {
    return dynamicServeFields.reduce(
      (cleaned, field) => {
        const key = field.FieldName || field.Name;
        const value = options[key];
        if (value !== undefined && !this.isDefaultValue(value, field)) cleaned[key] = value;
        return cleaned;
      },
      {} as Record<string, unknown>
    );
  }

  private cleanData(
    formData: Record<string, unknown>,
    fieldDefinitions: RcConfigOption[],
    flagType: FlagType,
    getUniqueControlKey: (flagType: FlagType, field: RcConfigOption) => string
  ): Record<string, unknown> {
    const fieldMap = new Map(fieldDefinitions.map(f => [getUniqueControlKey(flagType, f), f]));

    return Object.entries(formData).reduce(
      (acc, [key, value]) => {
        const field = fieldMap.get(key);
        if (field) {
          if (!this.isDefaultValue(value, field)) acc[field.FieldName] = value;
        } else if (value !== undefined && value !== null && value !== '') {
          const prefix = `${flagType}---`;
          acc[key.startsWith(prefix) ? key.slice(prefix.length) : key] = value;
        }
        return acc;
      },
      {} as Record<string, unknown>
    );
  }

  getRuntimeRemoteOptions(
    remoteName: string,
    config: Record<string, unknown>
  ): Record<string, unknown> {
    const options = (config['options'] as Record<string, unknown>) ?? {};
    const remoteOptions = options[remoteName];
    return remoteOptions && typeof remoteOptions === 'object' && !Array.isArray(remoteOptions)
      ? (remoteOptions as Record<string, unknown>)
      : options;
  }

  private buildRuntimeRemoteOptions(
    remoteName: string,
    configData: Record<string, unknown>,
    dynamicRuntimeRemoteFields: RcConfigOption[]
  ): Record<string, unknown> {
    const options = dynamicRuntimeRemoteFields.reduce(
      (acc, field) => {
        if (!Object.prototype.hasOwnProperty.call(configData, field.Name)) return acc;
        const value = configData[field.Name];
        if (!this.isDefaultValue(value, field)) acc[field.FieldName || field.Name] = value;
        return acc;
      },
      {} as Record<string, unknown>
    );
    return { [remoteName]: options };
  }

  buildProfileConfig(
    type: SharedProfileType,
    remoteName: string,
    configData: Record<string, unknown>,
    runtimeRemoteProfileNames: string[],
    dynamicFlagFields: Record<FlagType, RcConfigOption[]>,
    dynamicRuntimeRemoteFields: RcConfigOption[],
    dynamicServeFields: RcConfigOption[],
    getUniqueControlKey: (flagType: FlagType, field: RcConfigOption) => string
  ): Record<string, unknown> {
    if (type === 'serve') {
      const sourcePaths = this.pathService.buildPathStrings(
        configData['source'] as any[],
        remoteName
      );
      const fs = sourcePaths[0] ?? '';
      const serveOptions = this.cleanServeOptions(
        (configData['options'] as Record<string, unknown>) ?? {},
        dynamicServeFields
      );
      return {
        autoStart: configData['autoStart'] as boolean,
        cronEnabled: configData['cronEnabled'] as boolean,
        cronExpression: configData['cronExpression'] as string | null,
        source: fs,
        vfsProfile: configData['vfsProfile'] ?? DEFAULT_PROFILE_NAME,
        filterProfile: configData['filterProfile'] ?? DEFAULT_PROFILE_NAME,
        backendProfile: configData['backendProfile'] ?? DEFAULT_PROFILE_NAME,
        runtimeRemoteProfile: configData['runtimeRemoteProfile'] ?? DEFAULT_PROFILE_NAME,
        options: { type: configData['type'], fs, ...serveOptions },
      };
    }

    if (type === 'runtimeRemote') {
      return {
        options: this.buildRuntimeRemoteOptions(remoteName, configData, dynamicRuntimeRemoteFields),
      };
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(configData)) {
      if (key === 'source') {
        result[key] = Array.isArray(value)
          ? this.pathService.buildPathStrings(value as any[], remoteName)
          : this.pathService.buildPathString(value as any, remoteName);
      } else if (key === 'dest') {
        result[key] = this.pathService.buildPathString(value as any, remoteName);
      } else {
        result[key] = value;
      }
    }

    const isMainOp = LINKED_PROFILE_TYPES.has(type);
    if (isMainOp) {
      const selectedProfile = String(result['runtimeRemoteProfile'] ?? '').trim();
      result['runtimeRemoteProfile'] = runtimeRemoteProfileNames.includes(selectedProfile)
        ? selectedProfile
        : DEFAULT_PROFILE_NAME;
    } else {
      delete result['vfsProfile'];
      delete result['filterProfile'];
      delete result['backendProfile'];
      delete result['runtimeRemoteProfile'];
    }

    result['options'] = this.cleanData(
      configData['options'] as Record<string, unknown>,
      dynamicFlagFields[type as FlagType] ?? [],
      type as FlagType,
      getUniqueControlKey
    );
    return result;
  }

  cleanFormData(
    formData: Record<string, unknown>,
    dynamicRemoteFields: RcConfigOption[],
    changedRemoteFields: Set<string>
  ): PendingRemoteData {
    const fieldsByName = new Map(dynamicRemoteFields.map(f => [f.Name, f]));
    const result: PendingRemoteData = {
      name: formData['name'] as string,
      type: formData['type'] as string,
    };

    for (const [key, value] of Object.entries(formData)) {
      if (key === 'name' || key === 'type') continue;
      const field = fieldsByName.get(key);
      if (field) {
        if (!this.isDefaultValue(value, field) || changedRemoteFields.has(key)) {
          result[field.FieldName || key] = value;
        }
      } else if (value !== null && value !== undefined && value !== '') {
        result[key] = value;
      }
    }

    return result;
  }

  async populateFormIfEditingOrCloning(
    dialogData: DialogData,
    editTarget: Signal<EditTarget>,
    cloneTarget: Signal<boolean>,
    remoteForm: FormGroup,
    remoteConfigForm: FormGroup,
    existingRemotes: Signal<string[]>,
    selectedProfileName: Signal<Record<SharedProfileType, string>>,
    profiles: Signal<Record<SharedProfileType, Record<string, unknown>>>,
    selectedServeType: WritableSignal<string>,
    dynamicRuntimeRemoteFields: Signal<RcConfigOption[]>,
    dynamicFlagFields: Signal<Record<FlagType, RcConfigOption[]>>,
    isPopulatingForm: WritableSignal<boolean>,
    syncRuntimeRemoteType: () => Promise<void>,
    loadServeFields: () => Promise<void>,
    loadRuntimeRemoteFields: (type: string) => Promise<void>,
    selectLinkedProfile: (type: SharedProfileType, name: string) => Promise<void>,
    getUniqueControlKey: (flagType: FlagType, field: RcConfigOption) => string,
    onRemoteTypeChange: () => Promise<void>
  ): Promise<void> {
    if (!dialogData?.existingConfig) return;

    if (editTarget() === 'remote' || cloneTarget()) {
      const remoteSpecs = cloneTarget()
        ? dialogData.existingConfig['config']
        : dialogData.existingConfig;
      await this.populateRemoteForm(remoteSpecs, remoteForm, isPopulatingForm, onRemoteTypeChange);

      if (cloneTarget()) {
        const clonePromises: Promise<void>[] = [];

        for (const type of FLAG_TYPES) {
          const configKey = REMOTE_CONFIG_KEYS[
            type as keyof typeof REMOTE_CONFIG_KEYS
          ] as keyof RemoteConfigSections;
          const configs = dialogData.existingConfig?.[configKey] as
            | Record<string, unknown>
            | undefined;
          if (configs && Object.keys(configs).length > 0) {
            clonePromises.push(
              this.populateProfileForm(
                type,
                Object.values(configs)[0] as Record<string, unknown>,
                remoteConfigForm,
                remoteForm,
                remoteForm.get('name')?.value || '',
                existingRemotes,
                selectedServeType,
                dynamicRuntimeRemoteFields,
                dynamicFlagFields,
                isPopulatingForm,
                loadServeFields,
                loadRuntimeRemoteFields,
                selectLinkedProfile,
                getUniqueControlKey
              )
            );
          }
        }

        const runtimeConfigs = dialogData.existingConfig?.[REMOTE_CONFIG_KEYS.runtimeRemote] as
          | Record<string, unknown>
          | undefined;
        if (runtimeConfigs && Object.keys(runtimeConfigs).length > 0) {
          clonePromises.push(
            this.populateProfileForm(
              'runtimeRemote',
              Object.values(runtimeConfigs)[0] as Record<string, unknown>,
              remoteConfigForm,
              remoteForm,
              remoteForm.get('name')?.value || '',
              existingRemotes,
              selectedServeType,
              dynamicRuntimeRemoteFields,
              dynamicFlagFields,
              isPopulatingForm,
              loadServeFields,
              loadRuntimeRemoteFields,
              selectLinkedProfile,
              getUniqueControlKey
            )
          );
        }

        await Promise.all(clonePromises);
      }
    } else if (editTarget()) {
      if (dialogData?.remoteType) {
        remoteForm.get('type')?.setValue(dialogData.remoteType);
      }
      await syncRuntimeRemoteType();

      const type = editTarget() as SharedProfileType;
      const profileName = selectedProfileName()[type];
      const profile = profiles()[type]?.[profileName] as Record<string, unknown>;

      if (type === 'runtimeRemote') {
        const remoteType =
          dialogData?.remoteType ||
          (Object.values(
            profiles()['runtimeRemote'] as Record<string, Record<string, unknown>>
          ).find(p => p?.['type'])?.['type'] as string) ||
          '';
        remoteForm.get('type')?.setValue(remoteType);
      }

      if (profile) {
        await this.populateProfileForm(
          type,
          profile,
          remoteConfigForm,
          remoteForm,
          remoteForm.get('name')?.value || '',
          existingRemotes,
          selectedServeType,
          dynamicRuntimeRemoteFields,
          dynamicFlagFields,
          isPopulatingForm,
          loadServeFields,
          loadRuntimeRemoteFields,
          selectLinkedProfile,
          getUniqueControlKey
        );
      }
    }

    if (cloneTarget()) {
      this.generateNewCloneName(remoteForm, existingRemotes);
    }
  }

  async populateRemoteForm(
    config: Record<string, unknown>,
    remoteForm: FormGroup,
    isPopulatingForm: WritableSignal<boolean>,
    onRemoteTypeChange: () => Promise<void>
  ): Promise<void> {
    isPopulatingForm.set(true);
    remoteForm.patchValue({ name: config['name'], type: config['type'] });
    await onRemoteTypeChange();
    for (const [key, value] of Object.entries(config)) {
      if (key !== 'name' && key !== 'type' && !remoteForm.contains(key)) {
        remoteForm.addControl(key, new FormControl(value));
      }
    }
    remoteForm.patchValue(config);
    isPopulatingForm.set(false);
  }

  async populateProfileForm(
    type: SharedProfileType,
    config: Record<string, unknown>,
    remoteConfigForm: FormGroup,
    remoteForm: FormGroup,
    currentRemoteName: string,
    existingRemotes: Signal<string[]>,
    selectedServeType: WritableSignal<string>,
    dynamicRuntimeRemoteFields: Signal<RcConfigOption[]>,
    dynamicFlagFields: Signal<Record<FlagType, RcConfigOption[]>>,
    isPopulatingForm: WritableSignal<boolean>,
    loadServeFields: () => Promise<void>,
    loadRuntimeRemoteFields: (type: string) => Promise<void>,
    selectLinkedProfile: (type: SharedProfileType, name: string) => Promise<void>,
    getUniqueControlKey: (flagType: FlagType, field: RcConfigOption) => string
  ): Promise<void> {
    isPopulatingForm.set(true);
    const group = remoteConfigForm.get(`${type}Config`);
    if (!group) {
      isPopulatingForm.set(false);
      return;
    }

    if (type === 'serve') {
      const options = (config?.['options'] as Record<string, unknown>) ?? {};
      const serveType = (options?.['type'] as string) ?? 'http';
      selectedServeType.set(serveType);
      await loadServeFields();

      const vfsVal = (config['vfsProfile'] as string) ?? DEFAULT_PROFILE_NAME;
      const filterVal = (config['filterProfile'] as string) ?? DEFAULT_PROFILE_NAME;
      const backendVal = (config['backendProfile'] as string) ?? DEFAULT_PROFILE_NAME;
      const runtimeRemoteVal = (config['runtimeRemoteProfile'] as string) ?? DEFAULT_PROFILE_NAME;

      group.patchValue({
        autoStart: config['autoStart'] ?? false,
        cronEnabled: config['cronEnabled'] ?? false,
        cronExpression: config['cronExpression'] ?? null,
        source: this.pathService.parseFsString(
          (config['source'] as string) ?? '',
          'currentRemote',
          currentRemoteName,
          existingRemotes()
        ),
        type: serveType,
        vfsProfile: vfsVal,
        filterProfile: filterVal,
        backendProfile: backendVal,
        runtimeRemoteProfile: runtimeRemoteVal,
      });

      const optionsGroup = group.get('options') as FormGroup;
      if (optionsGroup) {
        for (const [key, value] of Object.entries(options)) {
          if (key === 'type' || key === 'fs') continue;
          const existing = optionsGroup.get(key);
          if (existing) {
            existing.setValue(value, { emitEvent: false });
          } else {
            optionsGroup.addControl(key, new FormControl(value), { emitEvent: false });
          }
        }
      }

      await selectLinkedProfile('vfs', vfsVal);
      await selectLinkedProfile('filter', filterVal);
      await selectLinkedProfile('backend', backendVal);
      await selectLinkedProfile('runtimeRemote', runtimeRemoteVal);
    } else if (type === 'runtimeRemote') {
      const options = this.getRuntimeRemoteOptions(currentRemoteName, config);
      const runtimeType =
        String(remoteForm.get('type')?.value ?? '').trim() ||
        (options['type'] as string) ||
        (config['type'] as string) ||
        '';
      group.get('type')?.setValue(runtimeType, { emitEvent: false });
      await loadRuntimeRemoteFields(runtimeType);
      for (const field of dynamicRuntimeRemoteFields()) {
        const value =
          options[field.FieldName] ?? options[field.Name] ?? field.Value ?? field.Default;
        group.get(field.Name)?.setValue(value, { emitEvent: false });
      }
    } else {
      const flagType = type as FlagType;
      const vfsVal = (config['vfsProfile'] as string) ?? DEFAULT_PROFILE_NAME;
      const filterVal = (config['filterProfile'] as string) ?? DEFAULT_PROFILE_NAME;
      const backendVal = (config['backendProfile'] as string) ?? DEFAULT_PROFILE_NAME;
      const runtimeRemoteVal = (config['runtimeRemoteProfile'] as string) ?? DEFAULT_PROFILE_NAME;

      const patchData: Record<string, unknown> = {
        autoStart: config['autoStart'] ?? false,
        cronEnabled: config['cronEnabled'] ?? false,
        cronExpression: config['cronExpression'] ?? null,
        watchEnabled: config['watchEnabled'] ?? false,
        watchDelay: config['watchDelay'] ?? 5,
        vfsProfile: vfsVal,
        filterProfile: filterVal,
        backendProfile: backendVal,
        runtimeRemoteProfile: runtimeRemoteVal,
      };

      if (flagType === 'mount') {
        patchData['type'] = config['type'] ?? '';
      }

      const sourceVal = config['source'];
      const configSources = (
        Array.isArray(sourceVal) ? sourceVal : sourceVal ? [sourceVal] : []
      ) as string[];

      const sourceCtrl = group.get('source');

      if (sourceCtrl instanceof FormArray) {
        sourceCtrl.clear();
        if (configSources.length > 0) {
          for (const s of configSources) {
            sourceCtrl.push(
              this.fb.group(
                this.pathService.parseFsString(
                  s,
                  'currentRemote',
                  currentRemoteName,
                  existingRemotes()
                )
              )
            );
          }
        } else {
          sourceCtrl.push(
            this.fb.group({ type: ['currentRemote'], path: [''], remote: [currentRemoteName] })
          );
        }
      } else if (sourceCtrl instanceof FormGroup) {
        sourceCtrl.patchValue(
          this.pathService.parseFsString(
            configSources[0] ?? '',
            'currentRemote',
            currentRemoteName,
            existingRemotes()
          )
        );
      }

      const destCtrl = group.get('dest');
      if (destCtrl instanceof FormGroup) {
        destCtrl.patchValue(
          this.pathService.parseFsString(
            (config['dest'] as string) ?? '',
            'local',
            currentRemoteName,
            existingRemotes()
          )
        );
      }

      group.patchValue(patchData);

      const options = (config['options'] as Record<string, unknown>) ?? {};
      const optionsGroup = group.get('options') as FormGroup;
      if (optionsGroup) {
        const fields = dynamicFlagFields()[flagType] || [];
        for (const field of fields) {
          const uniqueKey = getUniqueControlKey(flagType, field);
          optionsGroup.get(uniqueKey)?.setValue(field.Value ?? field.Default, { emitEvent: false });
        }

        for (const [key, value] of Object.entries(options)) {
          const controlKey = getUniqueControlKey(flagType, {
            FieldName: key,
            Name: key,
          } as RcConfigOption);
          const existing = optionsGroup.get(controlKey);
          if (existing) {
            existing.setValue(value, { emitEvent: false });
          } else {
            optionsGroup.addControl(controlKey, new FormControl(value), { emitEvent: false });
          }
        }
      }

      if (LINKED_PROFILE_TYPES.has(flagType)) {
        await selectLinkedProfile('vfs', vfsVal);
        await selectLinkedProfile('filter', filterVal);
        await selectLinkedProfile('backend', backendVal);
        await selectLinkedProfile('runtimeRemote', runtimeRemoteVal);
      }
    }

    isPopulatingForm.set(false);
  }

  generateNewCloneName(remoteForm: FormGroup, existingRemotes: Signal<string[]>): void {
    const base = `${remoteForm.get('name')?.value || 'remote'}-clone`;
    let name = base;
    let counter = 1;
    while (existingRemotes().includes(name)) {
      name = `${base}-${counter++}`;
    }
    remoteForm.get('name')?.setValue(name);
  }
}
