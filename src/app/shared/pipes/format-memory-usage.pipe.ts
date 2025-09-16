import { Pipe, PipeTransform } from '@angular/core';

interface MemoryStats {
  HeapAlloc?: number;
}

@Pipe({
  name: 'formatMemoryUsage',
  standalone: true,
  pure: true,
})
export class FormatMemoryUsagePipe implements PipeTransform {
  transform(memoryStats: MemoryStats | null): string {
    return memoryStats?.HeapAlloc
      ? `${Math.round(memoryStats.HeapAlloc / 1024 / 1024)} MB`
      : 'Unknown';
  }
}
