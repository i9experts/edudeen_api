import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { createClient, RedisClientType } from 'redis';

// Releases a lock only if we still own it (value matches our token), so a job
// that outlived its TTL can never delete a lock another instance now holds.
const RELEASE_LOCK_SCRIPT = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client: RedisClientType;
  private _isConnected = false;

  constructor() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    this.client = createClient({ url: redisUrl });
    this.client.on('error', (err) => {
      console.error('Redis Client Error', err);
      this._isConnected = false;
    });
    // node-redis reconnects on its own; without these the flag stayed false
    // forever after one transient error and every cron was skipped until restart.
    this.client.on('ready', () => {
      this._isConnected = true;
    });
    this.client.on('end', () => {
      this._isConnected = false;
    });
  }

  async onModuleInit() {
    try {
      await this.client.connect();
      this._isConnected = true;
      console.log('[RedisService] Redis connected');
    } catch (err) {
      this._isConnected = false;
      console.error('[RedisService] Redis connection failed:', err);
    }
  }

  async onModuleDestroy() {
    await this.client.quit();
    this._isConnected = false;
    console.log('[RedisService] Redis disconnected');
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  async set(key: string, value: string, ttl: number): Promise<void> {
    if (!this._isConnected) return;
    await this.client.set(key, value, { EX: ttl });
  }

  async get(key: string): Promise<string | null> {
    if (!this._isConnected) return null;
    return await this.client.get(key);
  }

  async del(key: string): Promise<void> {
    if (!this._isConnected) return;
    await this.client.del(key);
  }

  async incrWithTtl(key: string, ttl: number): Promise<number> {
    if (!this._isConnected) return 0;
    const count = await this.client.incr(key);
    if (count === 1) {
      await this.client.expire(key, ttl);
    }
    return count;
  }

  async withLock(
    lockKey: string,
    ttlMs: number,
    fn: () => Promise<void>,
  ): Promise<'ran' | 'lock_not_acquired'> {
    if (!this._isConnected) return 'lock_not_acquired';
    const ttlSeconds = Math.ceil(ttlMs / 1000);
    const token = randomUUID();
    const acquired = await this.client.set(lockKey, token, {
      NX: true,
      EX: ttlSeconds,
    });
    if (!acquired) return 'lock_not_acquired';
    try {
      await fn();
      return 'ran';
    } finally {
      await this.client
        .eval(RELEASE_LOCK_SCRIPT, { keys: [lockKey], arguments: [token] })
        .catch((err) => console.error(`[RedisService] failed to release lock ${lockKey}:`, err));
    }
  }
}
