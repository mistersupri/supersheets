import { prisma } from '../db';

export interface SystemSettings {
  registrationEnabled: boolean;
  linkSharingEnabled: boolean;
}

const DEFAULTS: SystemSettings = { registrationEnabled: true, linkSharingEnabled: true };

export async function getSettings(): Promise<SystemSettings> {
  const rows = await prisma.systemSetting.findMany();
  const out = { ...DEFAULTS };
  for (const r of rows) {
    if (r.key in out) (out as Record<string, unknown>)[r.key] = r.value;
  }
  return out;
}

export async function updateSettings(patch: Partial<SystemSettings>): Promise<SystemSettings> {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    await prisma.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
  return getSettings();
}
