import { AuthPrincipal } from '../types/domain.js';

declare global {
  namespace Express {
    interface Request {
      correlationId?: string;
      auth?: AuthPrincipal;
    }
  }
}

export {};

