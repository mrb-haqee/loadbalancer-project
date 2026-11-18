const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const LIMITS = {
  name: 64,
  host: 255,
  note: 255,
  portMin: 1,
  portMax: 65535,
  weightMin: 1,
  weightMax: 100,
};

export type ServerInput = {
  name: string;
  host: string;
  port: number;
  weight: number;
  enabled: boolean;
  note: string | null;
};

export type ValidationIssue = { field: string; message: string };

export type ValidationResult =
  | { ok: true; value: ServerInput }
  | { ok: false; errors: ValidationIssue[] };

function toInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * Validasi penuh untuk POST dan PUT (PUT mengganti seluruh field).
 * Mengembalikan { ok: true, value } atau { ok: false, errors }.
 */
export function validateServerInput(input: unknown): ValidationResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [{ field: 'body', message: 'Body harus berupa objek JSON.' }] };
  }

  const body = input as Record<string, unknown>;
  const errors: ValidationIssue[] = [];

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > LIMITS.name || !NAME_PATTERN.test(name)) {
    errors.push({
      field: 'name',
      message: `Nama wajib diisi (1-${LIMITS.name} karakter: huruf, angka, titik, garis bawah, atau strip).`,
    });
  }

  const host = typeof body.host === 'string' ? body.host.trim() : '';
  if (!host || host.length > LIMITS.host || !HOST_PATTERN.test(host)) {
    errors.push({ field: 'host', message: `Host wajib diisi (1-${LIMITS.host} karakter, tanpa spasi).` });
  }

  const port = toInteger(body.port);
  if (port === null || port < LIMITS.portMin || port > LIMITS.portMax) {
    errors.push({ field: 'port', message: `Port harus bilangan bulat ${LIMITS.portMin}-${LIMITS.portMax}.` });
  }

  const weight = body.weight === undefined ? 1 : toInteger(body.weight);
  if (weight === null || weight < LIMITS.weightMin || weight > LIMITS.weightMax) {
    errors.push({ field: 'weight', message: `Bobot harus bilangan bulat ${LIMITS.weightMin}-${LIMITS.weightMax}.` });
  }

  const enabled = body.enabled === undefined ? true : body.enabled;
  if (typeof enabled !== 'boolean') {
    errors.push({ field: 'enabled', message: 'Aktif harus boolean true/false.' });
  }

  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string') {
      errors.push({ field: 'note', message: 'Catatan harus teks.' });
    } else {
      const trimmed = body.note.trim();
      if (trimmed.length > LIMITS.note) {
        errors.push({ field: 'note', message: `Catatan maksimal ${LIMITS.note} karakter.` });
      } else {
        note = trimmed || null;
      }
    }
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: { name, host, port: port as number, weight: weight as number, enabled: enabled as boolean, note },
  };
}
