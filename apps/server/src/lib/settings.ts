import { prisma } from '../db';
import { invalidate, onInvalidate } from './bus';

export interface SystemSettings {
  registrationEnabled: boolean;
  linkSharingEnabled: boolean;
}

const DEFAULTS: SystemSettings = { registrationEnabled: true, linkSharingEnabled: true };

let cached: { v: SystemSettings; exp: number } | null = null;
onInvalidate('settings', () => {
  cached = null;
});

export async function getSettings(): Promise<SystemSettings> {
  if (cached && cached.exp > Date.now()) return cached.v;
  const rows = await prisma.systemSetting.findMany();
  const out = { ...DEFAULTS };
  for (const r of rows) {
    if (r.key in out) (out as Record<string, unknown>)[r.key] = r.value;
  }
  cached = { v: out, exp: Date.now() + 30_000 };
  return out;
}

export async function updateSettings(patch: Partial<SystemSettings>): Promise<SystemSettings> {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    await prisma.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
  invalidate('settings');
  return getSettings();
}
