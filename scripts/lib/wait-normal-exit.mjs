import { sameProcessIdentity } from '../../lib/process-identity.mjs';

// Called only after normal termination was accepted for an exact owned identity.
// A failed read is never absence; allow the OS exit transition to settle.
export async function waitForNormalExit({ identity, readIdentity, readRegistration, now = Date.now,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)), deadline }) {
  const lookupWarnings = [];
  while (now() < deadline) {
    let observed;
    try { observed = await readIdentity(identity.pid); }
    catch (error) {
      if (error.name !== 'ProcessIdentityError' || error.code === 'PROCESS_CHANGED') throw error;
      if (lookupWarnings.length < 16) lookupWarnings.push({ at: new Date(now()).toISOString(), code: error.code, message: error.message });
      await pause(250);
      continue;
    }
    if (observed && !sameProcessIdentity(observed, identity)) throw new Error('PID was reused; no further action was taken.');
    const registered = await readRegistration();
    if (registered.some(row => row.pid !== identity.pid)) throw new Error('A replacement app appeared; it was left running.');
    if (!observed && registered.length === 0) return { normalQuit: true, identity,
      exitedAt: new Date(now()).toISOString(), ...(lookupWarnings.length ? { lookupWarnings } : {}) };
    await pause(250);
  }
  throw new Error('App exit was not confirmed within 30 seconds; no force or reopen was attempted.');
}
