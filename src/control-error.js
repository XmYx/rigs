const STATUS = { off: 403, 'input-off': 403, 'not-allowed': 403, busy: 409, locked: 423, rate: 429, 'needs-permission': 412, unsupported: 501, 'no-session': 503, timeout: 504, 'bad-args': 400 };

export class ControlError extends Error {
  constructor(code, message, fix) {
    super(message);
    this.name = 'ControlError';
    this.code = code;
    this.status = STATUS[code] || 500;
    if (fix) this.fix = fix;
  }
}
