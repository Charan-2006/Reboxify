import crypto from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const headerVal = req.header('x-correlation-id');
  const correlationId = headerVal && headerVal.trim().length > 0 ? headerVal.trim() : crypto.randomUUID();
  req.correlationId = correlationId;
  res.setHeader('X-Correlation-Id', correlationId);
  next();
}

