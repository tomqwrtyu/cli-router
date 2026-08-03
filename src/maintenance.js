import fs from 'node:fs/promises';
import { HttpError } from './errors.js';

export function createMaintenanceStateReader(stateFile) {
  return async () => {
    try {
      const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      if (state?.version !== 1 || typeof state.maintenance !== 'boolean') {
        throw new Error('Invalid maintenance state');
      }
      return state;
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, maintenance: false, phase: 'open' };
      return { version: 1, maintenance: true, phase: 'control_unavailable' };
    }
  };
}

export async function assertAdmissionOpen(readMaintenanceState) {
  const state = await readMaintenanceState();
  if (state.maintenance) {
    throw new HttpError(503, 'UNAVAILABLE', 'Application maintenance in progress', {
      reason: 'app_maintenance',
      retryAfter: 15
    });
  }
}
