import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { UserModel } from '../models/User.js';
import { signAuthToken } from '../middleware/auth.js';
import { AuthPrincipal, UserRole } from '../types/domain.js';
import { conflict, forbidden, notFound, serviceUnavailable, unauthorized } from '../utils/errors.js';
import { AuditWriter, defaultAuditWriter } from './auditService.js';

export interface StoredUserRecord {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  status: 'ACTIVE' | 'SUSPENDED' | 'INVITED';
  businessId?: string;
  collectionCenterId?: string;
}

export interface UserRepository {
  findByEmail(email: string): Promise<StoredUserRecord | null>;
  findById(id: string): Promise<StoredUserRecord | null>;
  create(input: Omit<StoredUserRecord, 'id'>): Promise<StoredUserRecord>;
}

export class MongooseUserRepository implements UserRepository {
  private ensureDbReady(): void {
    if (mongoose.connection.readyState !== 1) {
      throw serviceUnavailable('Database connection is not active. Configure MONGODB_URI.');
    }
  }

  private toRecord(doc: {
    _id: mongoose.Types.ObjectId;
    name: string;
    email: string;
    passwordHash: string;
    role: UserRole;
    status: 'ACTIVE' | 'SUSPENDED' | 'INVITED';
    businessId?: mongoose.Types.ObjectId;
    collectionCenterId?: mongoose.Types.ObjectId;
  }): StoredUserRecord {
    return {
      id: doc._id.toString(),
      name: doc.name,
      email: doc.email,
      passwordHash: doc.passwordHash,
      role: doc.role,
      status: doc.status,
      businessId: doc.businessId?.toString(),
      collectionCenterId: doc.collectionCenterId?.toString(),
    };
  }

  async findByEmail(email: string): Promise<StoredUserRecord | null> {
    this.ensureDbReady();
    const doc = await UserModel.findOne({ email: email.toLowerCase().trim() }).lean();
    return doc ? this.toRecord(doc) : null;
  }

  async findById(id: string): Promise<StoredUserRecord | null> {
    this.ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    const doc = await UserModel.findById(id).lean();
    return doc ? this.toRecord(doc) : null;
  }

  async create(input: Omit<StoredUserRecord, 'id'>): Promise<StoredUserRecord> {
    this.ensureDbReady();
    const doc = await UserModel.create({
      name: input.name,
      email: input.email.toLowerCase().trim(),
      passwordHash: input.passwordHash,
      role: input.role,
      status: input.status,
      ...(input.businessId ? { businessId: new mongoose.Types.ObjectId(input.businessId) } : {}),
      ...(input.collectionCenterId
        ? { collectionCenterId: new mongoose.Types.ObjectId(input.collectionCenterId) }
        : {}),
    });
    return this.toRecord(doc);
  }
}

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
  role?: UserRole;
  businessId?: string;
  collectionCenterId?: string;
}

export interface PublicUserDto {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  status: 'ACTIVE' | 'SUSPENDED' | 'INVITED';
  businessId?: string;
  collectionCenterId?: string;
}

export interface AuthResponse {
  token: string;
  user: PublicUserDto;
}

function toPublicUser(record: StoredUserRecord): PublicUserDto {
  return {
    userId: record.id,
    name: record.name,
    email: record.email,
    role: record.role,
    status: record.status,
    ...(record.businessId ? { businessId: record.businessId } : {}),
    ...(record.collectionCenterId ? { collectionCenterId: record.collectionCenterId } : {}),
  };
}

function toPrincipal(record: StoredUserRecord): AuthPrincipal {
  return {
    userId: record.id,
    email: record.email,
    name: record.name,
    role: record.role,
    businessId: record.businessId,
    collectionCenterId: record.collectionCenterId,
  };
}

export class AuthService {
  constructor(
    private readonly users: UserRepository = new MongooseUserRepository(),
    private readonly audit: AuditWriter = defaultAuditWriter
  ) {}

  async register(
    input: RegisterInput,
    caller?: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<AuthResponse> {
    const requestedRole: UserRole = input.role ?? 'CUSTOMER';

    // Enforce least-privilege registration boundaries.
    if (requestedRole !== 'CUSTOMER') {
      if (!caller) {
        throw forbidden('Self-registration is restricted to CUSTOMER accounts.');
      }
      if (caller.role === 'MERCHANT_ADMIN') {
        if (requestedRole !== 'MERCHANT_STAFF') {
          throw forbidden('Merchant admins may only invite MERCHANT_STAFF accounts.');
        }
        if (!caller.businessId) {
          throw forbidden('Merchant admin is not associated with a business.');
        }
      } else if (caller.role !== 'ADMIN') {
        throw forbidden('Insufficient permissions to create privileged role accounts.');
      }
    }

    const normalizedEmail = input.email.toLowerCase().trim();
    const existing = await this.users.findByEmail(normalizedEmail);
    if (existing) {
      throw conflict('An account with this email already exists.', 'EMAIL_ALREADY_EXISTS');
    }

    const scopedBusinessId =
      caller?.role === 'MERCHANT_ADMIN' ? caller.businessId : input.businessId;

    const passwordHash = await bcrypt.hash(input.password, 10);
    const created = await this.users.create({
      name: input.name.trim(),
      email: normalizedEmail,
      passwordHash,
      role: requestedRole,
      status: 'ACTIVE',
      businessId: scopedBusinessId,
      collectionCenterId: input.collectionCenterId,
    });

    await this.audit.record({
      actor: {
        userId: caller?.userId ?? created.id,
        role: caller?.role ?? created.role,
        ip: meta?.ip,
      },
      action: 'USER_REGISTERED',
      entityType: 'User',
      entityId: created.id,
      businessId: created.businessId,
      afterSummary: { role: created.role, email: created.email },
      correlationId: meta?.correlationId,
    });

    const token = signAuthToken(toPrincipal(created));
    return { token, user: toPublicUser(created) };
  }

  async login(
    email: string,
    password: string,
    expectedRole?: UserRole,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<AuthResponse> {
    const normalizedEmail = email.toLowerCase().trim();
    const user = await this.users.findByEmail(normalizedEmail);
    if (!user) {
      throw unauthorized('Invalid email or password.');
    }

    if (user.status !== 'ACTIVE') {
      throw forbidden(`Account status is ${user.status}. Please contact support.`);
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw unauthorized('Invalid email or password.');
    }

    if (expectedRole && user.role !== expectedRole) {
      throw forbidden(`This portal requires role ${expectedRole}.`);
    }

    await this.audit.record({
      actor: { userId: user.id, role: user.role, ip: meta?.ip },
      action: 'USER_LOGGED_IN',
      entityType: 'User',
      entityId: user.id,
      businessId: user.businessId,
      correlationId: meta?.correlationId,
    });

    const token = signAuthToken(toPrincipal(user));
    return { token, user: toPublicUser(user) };
  }

  async getProfile(userId: string): Promise<PublicUserDto> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw notFound('User profile not found.');
    }
    return toPublicUser(user);
  }

  async recordLogout(
    principal: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<void> {
    await this.audit.record({
      actor: { userId: principal.userId, role: principal.role, ip: meta?.ip },
      action: 'USER_LOGGED_OUT',
      entityType: 'User',
      entityId: principal.userId,
      businessId: principal.businessId,
      correlationId: meta?.correlationId,
    });
  }
}

