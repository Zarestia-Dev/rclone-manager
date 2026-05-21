import { Injectable, inject, WritableSignal } from '@angular/core';
import { FormBuilder, FormGroup, FormArray } from '@angular/forms';
import {
  SharedProfileType,
  FlagType,
  RcConfigOption,
  DEFAULT_PROFILE_NAME,
  EditTarget,
} from '@app/types';
import { PathService } from '../infrastructure/platform/path.service';
import { ImportResult } from './cli-flag-mapper.service';
import {
  RemoteConfigProfileManagerService,
  StepConfig,
} from './remote-config-profile-manager.service';

export interface ApplyImportContext {
  remoteConfigForm: FormGroup;
  currentRemoteName: string;
  existingRemotes: string[];
  stepConfigs: StepConfig[];
  dynamicRuntimeRemoteFields: RcConfigOption[];
  dynamicFlagFields: Record<FlagType, RcConfigOption[]>;
  editTarget: WritableSignal<EditTarget>;
  currentStep: WritableSignal<number>;
  showCliImport: WritableSignal<boolean>;
  dirtyProfileTypes: Set<SharedProfileType>;
  profileManager: RemoteConfigProfileManagerService;
  setProfileMode: (type: SharedProfileType, mode: 'view' | 'edit' | 'add') => void;
  onServeTypeChange: (type: string) => Promise<void>;
  getUniqueControlKey: (flagType: FlagType, field: RcConfigOption) => string;
  selectLinkedProfileFn: (type: SharedProfileType, name: string) => Promise<void>;
}

const ARRAY_TYPES = new Set([
  'stringArray',
  'CommaSepList',
  'SpaceSepList',
  'Bits',
  'Encoding',
  'DumpFlags',
]);
const LINKED_TYPES = new Set(['vfs', 'filter', 'backend', 'runtimeRemote']);

@Injectable()
export class RemoteConfigCliImporterService {
  private readonly fb = inject(FormBuilder);
  private readonly pathService = inject(PathService);

  async applyImportResult(
    event: { result: ImportResult; profileName: string; isNew: boolean },
    ctx: ApplyImportContext
  ): Promise<void> {
    const { result, profileName, isNew } = event;
    const {
      remoteConfigForm,
      currentRemoteName,
      existingRemotes,
      stepConfigs,
      dynamicRuntimeRemoteFields,
      dynamicFlagFields,
      editTarget,
      currentStep,
      showCliImport,
      dirtyProfileTypes,
      profileManager,
      setProfileMode,
      onServeTypeChange,
      getUniqueControlKey,
      selectLinkedProfileFn,
    } = ctx;

    const targetType = (result.verb || editTarget() || 'sync') as SharedProfileType;

    if (isNew) setProfileMode(targetType, 'view');
    if (editTarget() && editTarget() !== targetType) editTarget.set(targetType);

    const stepIdx = stepConfigs.findIndex(s => s.type === targetType);
    if (stepIdx !== -1) currentStep.set(stepIdx + 1);

    const group = remoteConfigForm.get(`${targetType}Config`) as FormGroup;
    if (!group) return;

    if (targetType === 'serve' && result.serveSubtype) await onServeTypeChange(result.serveSubtype);
    if (targetType === 'mount' && result.mountSubtype)
      group.get('type')?.setValue(result.mountSubtype);

    // Contextual handling of absolute paths
    if (result.sourcePath) {
      const sourceCtrl = group.get('source');
      const parsedSource = this.pathService.parseFsString(
        result.sourcePath,
        'currentRemote',
        currentRemoteName,
        existingRemotes
      );

      if (sourceCtrl instanceof FormArray) {
        sourceCtrl.clear();
        sourceCtrl.push(this.fb.group(parsedSource));
      } else {
        sourceCtrl?.patchValue(parsedSource);
      }
    }

    if (result.destPath) {
      group
        .get('dest')
        ?.patchValue(
          this.pathService.parseFsString(
            result.destPath,
            'local',
            currentRemoteName,
            existingRemotes
          )
        );
    }

    // Process linked sub-profiles safely without structured clone performance traps
    const processedLinkedTypes = new Set<SharedProfileType>();

    for (const cls of result.classified) {
      if (cls.status !== 'mapped' || !cls.fieldName) continue;

      const targetFlagType = (cls.flagType || targetType) as SharedProfileType;
      if (targetFlagType === targetType || processedLinkedTypes.has(targetFlagType)) continue;

      processedLinkedTypes.add(targetFlagType);
      const profileCtrl = group.get(`${targetFlagType}Profile`);
      if (!profileCtrl) continue;

      const currentProfileVal = profileCtrl.value || DEFAULT_PROFILE_NAME;
      if (currentProfileVal === DEFAULT_PROFILE_NAME) {
        const targetProfiles = profileManager.profiles()[targetFlagType] ?? {};
        if (!targetProfiles[profileName]) {
          const defaultData = targetProfiles[DEFAULT_PROFILE_NAME] ?? {};
          profileManager.profiles.update(p => ({
            ...p,
            [targetFlagType]: {
              ...p[targetFlagType],
              [profileName]: structuredClone(defaultData),
            },
          }));
        }
        profileCtrl.setValue(profileName);
        await selectLinkedProfileFn(targetFlagType, profileName);
      } else {
        await selectLinkedProfileFn(targetFlagType, currentProfileVal);
      }
    }

    // Write flags directly using atomic assignments
    const processedKeys = new Set<string>();

    for (const cls of result.classified) {
      if (cls.status !== 'mapped' || !cls.fieldName) continue;

      const fieldNameLower = cls.fieldName.toLowerCase();
      const targetFlagType = (cls.flagType || targetType) as SharedProfileType;
      const targetGroup = remoteConfigForm.get(`${targetFlagType}Config`) as FormGroup;
      const isRuntimeRemote = targetFlagType === 'runtimeRemote';

      const targetOptionsGroup = isRuntimeRemote
        ? targetGroup
        : (targetGroup?.get('options') as FormGroup);

      if (!targetOptionsGroup) continue;

      const fields = isRuntimeRemote
        ? dynamicRuntimeRemoteFields
        : (dynamicFlagFields[targetFlagType as FlagType] ?? []);
      const matchedField = fields.find(
        f =>
          f.Name?.toLowerCase() === fieldNameLower || f.FieldName?.toLowerCase() === fieldNameLower
      );
      if (!matchedField) continue;

      const uniqueKey = isRuntimeRemote
        ? matchedField.Name
        : getUniqueControlKey(targetFlagType as FlagType, matchedField);
      const control = targetOptionsGroup.get(uniqueKey);
      if (!control) continue;

      if (ARRAY_TYPES.has(matchedField.Type)) {
        let newArray: unknown[] = [];

        if (processedKeys.has(uniqueKey)) {
          const currentVal = control.value;
          if (Array.isArray(currentVal)) {
            newArray = [...currentVal];
          } else if (typeof currentVal === 'string' && currentVal) {
            newArray = currentVal
              .split(matchedField.Type === 'SpaceSepList' ? /\s+/ : ',')
              .map(v => v.trim())
              .filter(Boolean);
          }
        }

        const coerced = cls.coercedValue;
        if (Array.isArray(coerced)) {
          coerced.forEach(v => {
            if (!newArray.includes(v)) newArray.push(v);
          });
        } else if (coerced != null && coerced !== '') {
          if (!newArray.includes(coerced)) newArray.push(coerced);
        }
        control.setValue(newArray);
      } else {
        control.setValue(cls.coercedValue);
      }

      control.markAsDirty();
      control.markAsTouched();
      processedKeys.add(uniqueKey);

      const targetProfileName = LINKED_TYPES.has(targetFlagType)
        ? group.get(`${targetFlagType}Profile`)?.value || DEFAULT_PROFILE_NAME
        : profileName;

      profileManager.highlightField(uniqueKey, targetFlagType, targetProfileName);
    }

    processedLinkedTypes.forEach(flagType => dirtyProfileTypes.add(flagType));
    dirtyProfileTypes.add(targetType);
    showCliImport.set(false);
  }
}
