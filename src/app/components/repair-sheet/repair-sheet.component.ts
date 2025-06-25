import { Component, Inject, NgZone } from '@angular/core';
import { MAT_BOTTOM_SHEET_DATA, MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { MatListModule } from '@angular/material/list';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { RepairData } from '../../shared/components/types';
import { RepairService } from '../../services/features/repair.service';

@Component({
  selector: 'app-repair-sheet',
  standalone: true,
  imports: [MatListModule, MatButtonModule, MatIconModule],
  templateUrl: './repair-sheet.component.html',
  styleUrl: './repair-sheet.component.scss'
})
export class RepairSheetComponent {
  installing = false;

  constructor(
    @Inject(MAT_BOTTOM_SHEET_DATA) public data: RepairData,
    private sheetRef: MatBottomSheetRef<RepairSheetComponent>,
    private zone: NgZone,
    private repairService: RepairService
  ) {}

  async repair() {
    this.zone.run(() => (this.installing = true)); // ✅ triggers Angular update

    try {
      await this.repairService.executeRepair(this.data);
      
      // Close the sheet after successful repair
      setTimeout(() => {
        this.sheetRef.dismiss('success');
      }, 1000);

    } catch (error) {
      console.error("Repair failed:", error);
      // Show error state or keep sheet open for retry
    }

    this.zone.run(() => (this.installing = false)); // ✅ for future attempts
  }

  getRepairIcon(): string {
    return this.repairService.getRepairButtonIcon(this.data.type);
  }

  getRepairDetails(): Array<{icon: string, label: string, value: string}> | null {
    return this.repairService.getRepairDetails(this.data.type);
  }

  dismiss(): void {
    this.sheetRef.dismiss();
  }

  getRepairProgressText(): string {
    return this.repairService.getRepairProgressText(this.data.type);
  }

  getRepairButtonIcon(): string {
    return this.repairService.getRepairButtonIcon(this.data.type);
  }

  getRepairButtonText(): string {
    return this.repairService.getRepairButtonText(this.data.type);
  }
}
