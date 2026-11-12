import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { requireAuth } from '../src/middleware/auth.js';
import { requireRoles, resolveMerchantScope } from '../src/middleware/rbac.js';
import { AuditWriter } from '../src/services/auditService.js';
import { AuthService, StoredUserRecord, UserRepository } from '../src/services/authService.js';

class InMemoryUserRepository implements UserRepository {
  private users = new Map<string, StoredUserRecord>();

  async findByEmail(email: string): Promise<StoredUserRecord | null> {
    for (const user of this.users.values()) {
      if (user.email === email.toLowerCase().trim()) return user;
    }
    return null;
  }

  async findById(id: string): Promise<StoredUserRecord | null> {
    return this.users.get(id) ?? null;
  }

  async create(input: Omit<StoredUserRecord, 'id'>): Promise<StoredUserRecord> {
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
    const created: StoredUserRecord = { id, ...input };
    this.users.set(id, created);
    return created;
  }
}

class InMemoryAuditWriter implements AuditWriter {
  public entries: unknown[] = [];
  async record(entry: unknown): Promise<void> {
    this.entries.push(entry);
  }
}

describe('Phase 1 Config, Auth, RBAC & Tenant Isolation', () => {
  it('starts safely with missing optional credentials and rejects weak secrets in production', () => {
    const devCfg = loadConfig({ NODE_ENV: 'development' });
    expect(devCfg.defaultCurrency).toBe('USD');
    expect(devCfg.integrations.paypalConfigured).toBe(false);
    expect(devCfg.integrations.geminiConfigured).toBe(false);
    expect(devCfg.integrations.elasticsearchConfigured).toBe(false);

    expect(() =>
      loadConfig({ NODE_ENV: 'production', MONGODB_URI: 'mongodb://localhost/test' })
    ).toThrow(/JWT_SECRET/);
  });

  it('serves /api/health without exposing secrets', async () => {
    const app = createApp();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.currency).toBe('USD');
    expect(res.body.integrations).toBeDefined();
    expect(JSON.stringify(res.body)).not.toContain('JWT_SECRET');
  });

  it('registers CUSTOMER, blocks self-registration of ADMIN, logs in, and enforces /me', async () => {
    const repo = new InMemoryUserRepository();
    const audit = new InMemoryAuditWriter();
    const authService = new AuthService(repo, audit);
    const app = createApp({ authService });

    const blocked = await request(app).post('/api/auth/register').send({
      name: 'Mallory',
      email: 'mallory@example.com',
      password: 'Password123!',
      role: 'ADMIN',
    });
    expect(blocked.status).toBe(403);

    const reg = await request(app).post('/api/auth/register').send({
      name: 'Alice Customer',
      email: 'alice@example.com',
      password: 'Password123!',
    });
    expect(reg.status).toBe(201);
    expect(reg.body.token).toBeTypeOf('string');
    expect(reg.body.user.role).toBe('CUSTOMER');
    expect(reg.body.user.passwordHash).toBeUndefined();

    const wrongRole = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123!',
      expectedRole: 'MERCHANT_ADMIN',
    });
    expect(wrongRole.status).toBe(403);

    const login = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123!',
      expectedRole: 'CUSTOMER',
    });
    expect(login.status).toBe(200);

    const meNoAuth = await request(app).get('/api/auth/me');
    expect(meNoAuth.status).toBe(401);

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('alice@example.com');
    expect(audit.entries.length).toBeGreaterThanOrEqual(2);
  });

  it('enforces RBAC and strict merchant tenant isolation', async () => {
    const repo = new InMemoryUserRepository();
    const audit = new InMemoryAuditWriter();
    const authService = new AuthService(repo, audit);

    // Seed an admin and merchant admin directly in test repo
    const adminAuth = await authService.register(
      { name: 'Root', email: 'admin@reboxify.test', password: 'Password123!', role: 'ADMIN' },
      { userId: 'seed', email: 'seed', name: 'Seed', role: 'ADMIN' }
    );
    const merchantAuth = await authService.register(
      {
        name: 'Merchant One',
        email: 'm1@reboxify.test',
        password: 'Password123!',
        role: 'MERCHANT_ADMIN',
        businessId: '507f1f77bcf86cd799439011',
      },
      { userId: adminAuth.user.userId, email: 'admin@reboxify.test', name: 'Root', role: 'ADMIN' }
    );

    const testApp = express();
    testApp.get(
      '/scoped/:merchantId',
      requireAuth,
      requireRoles('MERCHANT_ADMIN', 'ADMIN'),
      (req, res) => {
        const scopedId = resolveMerchantScope(req.auth!, req.params.merchantId);
        res.json({ scopedId });
      }
    );

    const ownRes = await request(testApp)
      .get('/scoped/507f1f77bcf86cd799439011')
      .set('Authorization', `Bearer ${merchantAuth.token}`);
    expect(ownRes.status).toBe(200);
    expect(ownRes.body.scopedId).toBe('507f1f77bcf86cd799439011');

    const crossTenant = await request(testApp)
      .get('/scoped/507f1f77bcf86cd799439099')
      .set('Authorization', `Bearer ${merchantAuth.token}`);
    expect(crossTenant.status).toBe(403);
  });
});

