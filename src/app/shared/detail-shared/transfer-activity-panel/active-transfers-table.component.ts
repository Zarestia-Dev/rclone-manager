import { Component, input, ChangeDetectionStrategy } from '@angular/core';
import { NgClass } from '@angular/common';
import { MatTableModule } from '@angular/material/table';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import { FormatFileSizePipe } from '../../pipes/format-file-size.pipe';
import { FormatTimePipe } from '../../pipes/format-time.pipe';
import { TransferFile } from '@app/types';
import { inject } from '@angular/core';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';

@Component({
  selector: 'app-active-transfers-table',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgClass,
    MatTableModule,
    MatProgressBarModule,
    MatIconModule,
    MatTooltipModule,
    TranslateModule,
    FormatFileSizePipe,
    FormatTimePipe,
  ],
  template: `
    <div class="transfer-table-container">
      @if (transfers().length > 0) {
        <table mat-table [dataSource]="transfers()" [trackBy]="trackByName" class="transfer-table">
          <ng-container matColumnDef="name">
            <th mat-header-cell *matHeaderCellDef>
              {{ 'shared.transferActivity.table.file' | translate }}
            </th>
            <td mat-cell *matCellDef="let transfer" class="name-cell">
              <div class="file-info">
                <mat-icon svgIcon="file" class="file-icon" [matTooltip]="transfer.name"></mat-icon>
                <span class="file-name" [title]="transfer.name">{{ transfer.name }}</span>
                @if (transfer.isError) {
                  <mat-icon
                    svgIcon="circle-exclamation"
                    class="error-icon warn"
                    [matTooltip]="'shared.transferActivity.status.transferError' | translate"
                  ></mat-icon>
                }
                @if (transfer.isCompleted) {
                  <mat-icon
                    svgIcon="circle-check"
                    class="success-icon primary"
                    [matTooltip]="'shared.transferActivity.status.transferCompleted' | translate"
                  ></mat-icon>
                }
              </div>
            </td>
          </ng-container>

          <ng-container matColumnDef="progress">
            <th mat-header-cell *matHeaderCellDef>
              {{ 'shared.transferActivity.table.progress' | translate }}
            </th>
            <td mat-cell *matCellDef="let transfer" class="progress-cell">
              <div class="progress-info">
                <div class="progress-header">
                  @if (isPreparing(transfer.percentage)) {
                    <span class="progress-text">{{
                      'shared.transferActivity.status.preparing' | translate
                    }}</span>
                  } @else if (transfer.percentage === 100) {
                    <span class="progress-text">{{
                      'shared.transferActivity.status.finalizing' | translate
                    }}</span>
                  } @else {
                    <span class="progress-text">{{ transfer.percentage }}%</span>
                  }
                  <span class="size-text">
                    {{ transfer.bytes ?? 0 | formatFileSize }} /
                    {{ transfer.size | formatFileSize }}
                  </span>
                </div>
                <mat-progress-bar
                  [mode]="isPreparing(transfer.percentage) ? 'indeterminate' : 'determinate'"
                  [value]="isPreparing(transfer.percentage) ? 0 : transfer.percentage"
                ></mat-progress-bar>
              </div>
            </td>
          </ng-container>

          <ng-container matColumnDef="speed">
            <th mat-header-cell *matHeaderCellDef>
              {{ 'shared.transferActivity.table.speed' | translate }}
            </th>
            <td mat-cell *matCellDef="let transfer" class="speed-cell">
              <div class="speed-info">
                @if (transfer.speed > 0) {
                  <span class="speed-value">{{ transfer.speed | formatFileSize }}/s</span>
                  <div class="speed-indicator" [ngClass]="getSpeedClass(transfer.speed)"></div>
                } @else {
                  <span class="speed-idle">-</span>
                }
              </div>
            </td>
          </ng-container>

          <ng-container matColumnDef="eta">
            <th mat-header-cell *matHeaderCellDef>
              {{ 'shared.transferActivity.table.eta' | translate }}
            </th>
            <td mat-cell *matCellDef="let transfer" class="eta-cell">
              @if (transfer.eta > 0 && !transfer.isCompleted) {
                <span class="eta-value">{{ transfer.eta | formatTime }}</span>
              } @else {
                <span class="eta-complete">-</span>
              }
            </td>
          </ng-container>

          <ng-container matColumnDef="path">
            <th mat-header-cell *matHeaderCellDef>
              {{ 'shared.transferActivity.table.path' | translate }}
            </th>
            <td mat-cell *matCellDef="let transfer" class="path-cell">
              <div class="path-info">
                @if (transfer.srcFs || transfer.dstFs) {
                  <span
                    class="src"
                    [matTooltip]="pathService.joinFsPath(transfer.srcFs, transfer.name)"
                    >{{ transfer.srcFs || '?' }}</span
                  >
                  <mat-icon svgIcon="right-arrow" class="arrow-icon"></mat-icon>
                  <span
                    class="dst"
                    [matTooltip]="pathService.joinFsPath(transfer.dstFs, transfer.name)"
                    >{{ transfer.dstFs || '?' }}</span
                  >
                } @else {
                  <span class="no-path">-</span>
                }
              </div>
            </td>
          </ng-container>

          <tr mat-header-row *matHeaderRowDef="displayedColumns; sticky: true"></tr>
          <tr
            mat-row
            *matRowDef="let row; columns: displayedColumns"
            class="transfer-row"
            [ngClass]="{
              completed: row.isCompleted,
              error: row.isError,
              active: !row.isCompleted && !row.isError,
            }"
          ></tr>
        </table>
      } @else {
        <div class="empty-state">
          <mat-icon svgIcon="download" class="placeholder-icon"></mat-icon>
          <span>{{ 'shared.transferActivity.empty.noActive' | translate }}</span>
          <p>{{ 'shared.transferActivity.empty.activeHint' | translate }}</p>
        </div>
      }
    </div>
  `,
  styleUrls: ['./transfer-tables.scss'],
})
export class ActiveTransfersTableComponent {
  protected readonly pathService = inject(PathService);

  readonly transfers = input.required<TransferFile[]>();

  readonly displayedColumns = ['name', 'path', 'progress', 'speed', 'eta'];

  trackByName(_index: number, transfer: TransferFile): string {
    return transfer.name;
  }
  getSpeedClass(speed: number): string {
    if (speed > 10 * 1024 * 1024) return 'speed-fast';
    if (speed > 1 * 1024 * 1024) return 'speed-medium';
    return 'speed-slow';
  }
  isPreparing(percentage: number | undefined | null): boolean {
    return percentage === undefined || percentage === null || isNaN(percentage);
  }
}
