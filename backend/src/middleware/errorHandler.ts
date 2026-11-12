import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { config } from '../config/env.js';
import { AppError } from '../utils/errors.js';

export function errorHandlerMiddleware(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const correlationId = req.correlationId;

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
        correlationId,
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Input validation failed.',
        details: err.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
        correlationId,
      },
    });
    return;
  }

  const mongoCode = (err as { code?: number })?.code;
  if (mongoCode === 11000) {
    res.status(409).json({
      error: {
        code: 'DUPLICATE_KEY',
        message: 'A record with the provided unique identifier already exists.',
        correlationId,
      },
    });
    return;
  }

  const message =
    config.nodeEnv === 'production'
      ? 'An unexpected internal error occurred.'
      : err instanceof Error
        ? err.message
        : 'Unknown server error';

  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message,
      correlationId,
    },
  });
}

