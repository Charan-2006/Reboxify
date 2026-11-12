export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function unauthorized(message = 'Authentication required.'): AppError {
  return new AppError(401, 'UNAUTHORIZED', message);
}

export function forbidden(message = 'You do not have permission to perform this action.'): AppError {
  return new AppError(403, 'FORBIDDEN', message);
}

export function badRequest(message: string, details?: unknown): AppError {
  return new AppError(400, 'BAD_REQUEST', message, details);
}

export function conflict(message: string, code = 'CONFLICT', details?: unknown): AppError {
  return new AppError(409, code, message, details);
}

export function notFound(message = 'Requested resource was not found.'): AppError {
  return new AppError(404, 'NOT_FOUND', message);
}

export function serviceUnavailable(message: string): AppError {
  return new AppError(503, 'SERVICE_UNAVAILABLE', message);
}

