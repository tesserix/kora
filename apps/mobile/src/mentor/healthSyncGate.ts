let generation = 0;
let pauseCount = 0;
let activeUploads = 0;
let idleWaiters: (() => void)[] = [];

export function mentorHealthSyncGeneration(): number | null {
  return pauseCount > 0 ? null : generation;
}

export function beginMentorHealthUpload(expectedGeneration: number): boolean {
  if (pauseCount > 0 || expectedGeneration !== generation) return false;
  activeUploads++;
  return true;
}

export function finishMentorHealthUpload(): void {
  activeUploads = Math.max(0, activeUploads - 1);
  if (activeUploads !== 0) return;
  const waiters = idleWaiters;
  idleWaiters = [];
  waiters.forEach((resolve) => resolve());
}

export function pauseMentorHealthSync(): { waitForIdle: Promise<void>; resume: () => void } {
  generation++;
  pauseCount++;
  let resumed = false;
  return {
    waitForIdle: activeUploads === 0
      ? Promise.resolve()
      : new Promise((resolve) => idleWaiters.push(resolve)),
    resume: () => {
      if (resumed) return;
      resumed = true;
      pauseCount = Math.max(0, pauseCount - 1);
    },
  };
}
