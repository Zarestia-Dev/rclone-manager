import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { MatTableDataSource } from '@angular/material/table';
import { MatSort, MatSortModule } from '@angular/material/sort';
import { TransferFile } from '../../../../shared/components/types';

export interface FileTransferPanelConfig {
  dataSource: MatTableDataSource<TransferFile>;
  displayedColumns: string[];
  operationClass: string;
}

@Component({
  selector: 'app-file-transfer-panel',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatIconModule,
    MatTableModule,
    MatSortModule,
    MatSort
  ],
  styleUrls: ['./file-transfer-panel.component.scss'],
  template: `
    <mat-card class="detail-panel file-list-panel">
      <mat-card-header class="panel-header">
        <mat-card-title class="panel-title-content">
          <mat-icon svgIcon="file" class="panel-icon"></mat-icon>
          <span>Transfer Progress</span>
          <span class="file-count">{{ config.dataSource.data.length || 0 }}</span>
        </mat-card-title>
      </mat-card-header>
      
      <mat-card-content class="panel-content">
        <div class="file-list-container">
          <table mat-table [dataSource]="config.dataSource" matSort class="files-table">
            <!-- Filename Column -->
            <ng-container matColumnDef="name">
              <th class="filename-header" mat-header-cell *matHeaderCellDef mat-sort-header>
                Filename
              </th>
              <td class="filename-cell" mat-cell *matCellDef="let file">
                <div class="file-info">
                  <mat-icon [svgIcon]="file.isError ? 'circle-exclamation' : 'file'"
                            [class.error-icon]="file.isError" 
                            class="file-icon"></mat-icon>
                  <span class="file-name">{{ file.name }}</span>
                </div>
              </td>
            </ng-container>

            <!-- Progress Column -->
            <ng-container matColumnDef="percentage">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>
                Progress
              </th>
              <td mat-cell *matCellDef="let file">
                <div class="progress-container">
                  <div class="progress-bar-wrapper">
                    <div class="progress-bar" [ngClass]="config.operationClass">
                      <div class="progress-fill" [style.width.%]="file.percentage || 0"></div>
                    </div>
                  </div>
                  <span class="progress-text">{{ (file.percentage || 0) }}%</span>
                </div>
              </td>
            </ng-container>

            <!-- Speed Column -->
            <ng-container matColumnDef="speed">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>
                Speed
              </th>
              <td mat-cell *matCellDef="let file">
                <span class="speed-value">{{ formatFileSize(file.speed || 0) }}/s</span>
              </td>
            </ng-container>

            <!-- Size Column -->
            <ng-container matColumnDef="size">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>
                Size
              </th>
              <td mat-cell *matCellDef="let file">
                <span class="size-value">{{ formatFileSize(file.size || 0) }}</span>
              </td>
            </ng-container>

            <!-- ETA Column -->
            <ng-container matColumnDef="eta">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>
                ETA
              </th>
              <td mat-cell *matCellDef="let file">
                <span class="eta-value">{{ formatTime(file.eta || 0) }}</span>
              </td>
            </ng-container>

            <tr mat-header-row *matHeaderRowDef="config.displayedColumns" class="file-header-row"></tr>
            <tr mat-row *matRowDef="let file; columns: config.displayedColumns;" 
                class="file-row" [class.error-file]="file.isError"></tr>
            
            <tr class="no-data-row" *matNoDataRow>
              <td class="no-data-cell" [attr.colspan]="config.displayedColumns.length">
                <div class="no-data-content">
                  <mat-icon svgIcon="file" class="no-data-icon"></mat-icon>
                  <span>No transfer files found</span>
                </div>
              </td>
            </tr>
          </table>
        </div>
      </mat-card-content>
    </mat-card>
  `,
})
export class FileTransferPanelComponent {
  @Input() config!: FileTransferPanelConfig;

  formatFileSize(bytes: number): string {
    if (isNaN(parseFloat(String(bytes))) || !isFinite(bytes)) {
      return "0 B";
    }

    const units = ["B", "KB", "MB", "GB", "TB"];
    let unitIndex = 0;
    let size = bytes;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  formatTime(seconds: number): string {
    if (isNaN(seconds) || seconds <= 0) return "-";

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
    parts.push(`${secs}s`);

    return parts.join(" ");
  }
}
