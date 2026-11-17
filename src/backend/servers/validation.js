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

function toInteger(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * Validasi penuh untuk POST dan PUT (PUT mengganti seluruh field).
 * Mengembalikan { ok: true, value } atau { ok: false, errors }.
 */
export function validateServerInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [{ field: 'body', message: 'Body harus berupa objek JSON.' }] };
  }

  const errors = [];

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > LIMITS.name || !NAME_PATTERN.test(name)) {
    errors.push({
      field: 'name',
      message: `Nama wajib diisi (1-${LIMITS.name} karakter: huruf, angka, titik, garis bawah, atau strip).`,
    });
  }

  const host = typeof input.host === 'string' ? input.host.trim() : '';
  if (!host || host.length > LIMITS.host || !HOST_PATTERN.test(host)) {
    errors.push({
      field: 'host',
      message: `Host wajib diisi (1-${LIMITS.host} karakter, tanpa spasi).`,
    });
  }

  const port = toInteger(input.port);
  if (port === null || port < LIMITS.portMin || port > LIMITS.portMax) {
    errors.push({ field: 'port', message: `Port harus bilangan bulat ${LIMITS.portMin}-${LIMITS.portMax}.` });
  }

  const weight = input.weight === undefined ? 1 : toInteger(input.weight);
  if (weight === null || weight < LIMITS.weightMin || weight > LIMITS.weightMax) {
    errors.push({ field: 'weight', message: `Bobot harus bilangan bulat ${LIMITS.weightMin}-${LIMITS.weightMax}.` });
  }

  const enabled = input.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== 'boolean') {
    errors.push({ field: 'enabled', message: 'Aktif harus boolean true/false.' });
  }

  let note = null;
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== 'string') {
      errors.push({ field: 'note', message: 'Catatan harus teks.' });
    } else {
      const trimmed = input.note.trim();
      if (trimmed.length > LIMITS.note) {
        errors.push({ field: 'note', message: `Catatan maksimal ${LIMITS.note} karakter.` });
      } else {
        note = trimmed || null;
      }
    }
  }

  if (errors.length) return { ok: false, errors };

  return { ok: true, value: { name, host, port, weight, enabled, note } };
}
