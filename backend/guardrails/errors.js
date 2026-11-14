// An error the HTTP layer turns into `status` with `{ "error": message }`
// (docs/api-contract.md, Conventions).
export class GuardrailError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GuardrailError';
    this.status = status;
  }
}

export const hasOwn = (obj, key) => obj != null && Object.prototype.hasOwnProperty.call(obj, key);
export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
