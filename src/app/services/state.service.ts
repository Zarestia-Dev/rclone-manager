import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs/internal/BehaviorSubject';

@Injectable({
  providedIn: 'root'
})
export class StateService {
  private selectedRemoteSource = new BehaviorSubject<any>(null);
  selectedRemote$ = this.selectedRemoteSource.asObservable();

  resetSelectedRemote(): void {
    this.selectedRemoteSource.next(null);
  }

  setSelectedRemote(remote: any): void {
    this.selectedRemoteSource.next(remote);
  }

  private remotesSubject = new BehaviorSubject<any[]>([]);
  remotes$ = this.remotesSubject.asObservable();

  updateRemotes(newRemotes: any[]) {
    this.remotesSubject.next(newRemotes);
  }

  addRemote(remote: any) {
    const currentRemotes = this.remotesSubject.getValue();
    this.remotesSubject.next([...currentRemotes, remote]);
  }

  removeRemote(remoteName: string) {
    const currentRemotes = this.remotesSubject.getValue().filter(r => r.remoteSpecs.name !== remoteName);
    this.remotesSubject.next(currentRemotes);
  }

  updateRemote(remoteName: string, updatedData: any) {
    const currentRemotes = this.remotesSubject.getValue().map(r => 
      r.remoteSpecs.name === remoteName ? { ...r, ...updatedData } : r
    );
    this.remotesSubject.next(currentRemotes);
  }
}
