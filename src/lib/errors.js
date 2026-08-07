export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg = 'Bad request', details) =>
  new AppError(400, 'bad_request', msg, details);

export const unauthorized = (msg = 'Authentication required') =>
  new AppError(401, 'unauthorized', msg);

export const forbidden = (msg = 'Not permitted') =>
  new AppError(403, 'forbidden', msg);

export const notFound = (msg = 'Not found') =>
  new AppError(404, 'not_found', msg);

export const conflict = (msg = 'Conflict', code = 'conflict') =>
  new AppError(409, code, msg);

export const gone = (msg = 'No longer available') =>
  new AppError(410, 'gone', msg);

export const tooManyRequests = (msg = 'Too many requests', details) =>
  new AppError(429, 'rate_limited', msg, details);

export const unprocessable = (msg = 'Unprocessable', details) =>
  new AppError(422, 'unprocessable', msg, details);
