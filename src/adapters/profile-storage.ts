import { parseProfile } from '../domain/profile.ts';
import type { Profile } from '../domain/profile.ts';
export interface ProfileStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const key = 'verifold.profile.v1';
/** Storage failures propagate so the UI can offer an honest recovery path. */
export function loadProfile(storage: ProfileStorage): Profile | null {
  const value = storage.getItem(key);
  if (value === null) return null;
  const parsed: unknown = JSON.parse(value);
  return parseProfile(parsed);
}
export function saveProfile(storage: ProfileStorage, profile: Profile): void {
  storage.setItem(key, JSON.stringify(parseProfile(profile)));
}
