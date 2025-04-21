import { Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ConfirmDialogData, ConfirmModalComponent } from '../modals/confirm-modal/confirm-modal.component';

@Injectable({
  providedIn: 'root'
})
export class InfoService {

  constructor(
    private snackBar: MatSnackBar,
    private dialog: MatDialog
  ) { }

  confirmModal(title: string, message: string) {
    // Create the confirmation dialog data
    const dialogData: ConfirmDialogData = {
      title: title,
      message: message,
      cancelText: "No",
      confirmText: "Yes",
    };

    return new Promise((resolve) => {
      const dialogRef = this.dialog.open(ConfirmModalComponent, {
        width: "300px",
        data: dialogData,
      });
      dialogRef.afterClosed().subscribe((result) => {
        resolve(result);
      });
    });
  }

  alertModal(title: string, message: string) {
    // Create the confirmation dialog data
    const dialogData: ConfirmDialogData = {
      title: title,
      message: message,
      cancelText: "OK",
    };

    // Open the confirmation dialog
    this.dialog.open(ConfirmModalComponent, {
      width: "300px",
      data: dialogData,
    });
  }

  openSnackBar(message: string, action: string) {
    this.snackBar.open(message, action, {
      duration: 2000,
    });
  }
}
