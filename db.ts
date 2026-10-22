import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Redis } from '@upstash/redis';
import bcrypt from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE = fs.existsSync(path.join(process.cwd(), 'data')) ? process.cwd() : __dirname;

const isServerless = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME || !!process.env.NETLIFY;
const LOCAL_DATA_DIR = isServerless ? path.join('/tmp', 'data') : path.join(BASE, 'data');
const LOCAL_UPLOADS_DIR = isServerless ? path.join('/tmp', 'uploads') : path.join(BASE, 'static', 'uploads');

if (!fs.existsSync(LOCAL_DATA_DIR)) {
  fs.mkdirSync(LOCAL_DATA_DIR, { recursive: true });
}
if (!fs.existsSync(LOCAL_UPLOADS_DIR)) {
  fs.mkdirSync(LOCAL_UPLOADS_DIR, { recursive: true });
}

// Initial seed file copy if in serverless /tmp
if (isServerless) {
  const seedProducts = path.join(BASE, 'data', 'products.json');
  const targetProducts = path.join(LOCAL_DATA_DIR, 'products.json');
  if (fs.existsSync(seedProducts) && !fs.existsSync(targetProducts)) {
    try { fs.copyFileSync(seedProducts, targetProducts); } catch {}
  }

  const seedOrders = path.join(BASE, 'data', 'orders.json');
  const targetOrders = path.join(LOCAL_DATA_DIR, 'orders.json');
  if (fs.existsSync(seedOrders) && !fs.existsSync(targetOrders)) {
    try { fs.copyFileSync(seedOrders, targetOrders); } catch {}
  }

  const seedConfig = path.join(BASE, 'config.json');
  const targetConfig = path.join(LOCAL_DATA_DIR, 'config.json');
  if (fs.existsSync(seedConfig) && !fs.existsSync(targetConfig)) {
    try { fs.copyFileSync(seedConfig, targetConfig); } catch {}
  }
}

const DB_FILE = path.join(LOCAL_DATA_DIR, 'products.json');
const ORDERS_FILE = path.join(LOCAL_DATA_DIR, 'orders.json');
const USERS_FILE = path.join(LOCAL_DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(LOCAL_DATA_DIR, 'sessions.json');
const OTPS_FILE = path.join(LOCAL_DATA_DIR, 'otps.json');
const DARAZ_STORES_FILE = path.join(LOCAL_DATA_DIR, 'daraz-stores.json');
const CFG_FILE = isServerless ? path.join(LOCAL_DATA_DIR, 'config.json') : path.join(BASE, 'config.json');

export const UPLOADS_DIR = LOCAL_UPLOADS_DIR;

// Local JSON file helpers (fallback)
function readJson(file: string, fallback: any = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: any) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn(`WriteJson warning for ${file}:`, err);
  }
}

// --- REDIS CLIENT MANAGER ---
let activeRedisClient: Redis | null = null;
let lastTestedUrl: string = '';
let lastTestedToken: string = '';
let redisAuthErrorDetected = false;

export function markRedisAuthError(err: any) {
  const msg = String(err?.message || err);
  if (msg.includes('WRONGPASS') || msg.includes('unauthorized') || msg.includes('missing auth token')) {
    redisAuthErrorDetected = true;
    activeRedisClient = null;
  }
}

export function getRedisClient(): Redis | null {
  const envUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  let envToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  // If envToken is accidentally set to the URL (starts with http/https), ignore it!
  if (envToken && (envToken.startsWith('http://') || envToken.startsWith('https://'))) {
    envToken = undefined;
  }

  let url = envUrl;
  let token = envToken;

  if (!url || !token) {
    const cfg = readJson(CFG_FILE, {});
    if (cfg.upstash_redis_rest_url || cfg.kv_rest_api_url) {
      url = url || cfg.upstash_redis_rest_url || cfg.kv_rest_api_url;
      const t = cfg.upstash_redis_rest_token || cfg.kv_rest_api_token;
      if (t && !t.startsWith('http')) token = t;
    }
  }

  if (!url || !token) {
    const baseCfg = readJson(path.join(BASE, 'config.json'), {});
    if (baseCfg.upstash_redis_rest_url || baseCfg.kv_rest_api_url) {
      url = url || baseCfg.upstash_redis_rest_url || baseCfg.kv_rest_api_url;
      const t = baseCfg.upstash_redis_rest_token || baseCfg.kv_rest_api_token;
      if (t && !t.startsWith('http')) token = t;
    }
  }

  if (!url || !token) {
    const cwdCfg = readJson(path.join(process.cwd(), 'config.json'), {});
    if (cwdCfg.upstash_redis_rest_url || cwdCfg.kv_rest_api_url) {
      url = url || cwdCfg.upstash_redis_rest_url || cwdCfg.kv_rest_api_url;
      const t = cwdCfg.upstash_redis_rest_token || cwdCfg.kv_rest_api_token;
      if (t && !t.startsWith('http')) token = t;
    }
  }

  if (!url || !token) {
    activeRedisClient = null;
    return null;
  }

  if (redisAuthErrorDetected && lastTestedUrl === url && lastTestedToken === token) {
    return null;
  }

  if (activeRedisClient && lastTestedUrl === url && lastTestedToken === token) {
    return activeRedisClient;
  }

  try {
    activeRedisClient = new Redis({ url, token });
    lastTestedUrl = url;
    lastTestedToken = token;
    redisAuthErrorDetected = false;
    return activeRedisClient;
  } catch (err) {
    console.error('Failed to initialize Redis client:', err);
    activeRedisClient = null;
    return null;
  }
}

export function isUsingRedis(): boolean {
  return Boolean(getRedisClient());
}

export async function testRedisConnection(customUrl?: string, customToken?: string): Promise<{ success: boolean; latencyMs?: number; error?: string }> {
  try {
    let client: Redis | null = null;
    if (customUrl && customToken) {
      client = new Redis({ url: customUrl.trim(), token: customToken.trim() });
    } else {
      client = getRedisClient();
    }

    if (!client) {
      return { success: false, error: 'No Upstash Redis URL & Token provided' };
    }

    const t0 = Date.now();
    await client.set('supplierdesk:ping', Date.now(), { ex: 60 });
    const pingVal = await client.get('supplierdesk:ping');
    const latencyMs = Date.now() - t0;

    if (!pingVal) {
      return { success: false, error: 'Could not retrieve ping test key from Redis' };
    }

    return { success: true, latencyMs };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

// --- PRODUCTS ---
export async function getProducts(): Promise<Record<string, any>> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const isInit = await redis.get<boolean>('supplierdesk:products:initialized');
      const data = await redis.get<Record<string, any>>('supplierdesk:products');

      // If Redis has already been initialized (even if data is empty {}), respect the user's state!
      if (isInit) {
        return (data && typeof data === 'object') ? data : {};
      }

      // If key exists in Redis and was previously saved
      if (data !== null && data !== undefined && typeof data === 'object') {
        await redis.set('supplierdesk:products:initialized', true);
        return data;
      }

      // Absolute first run: initialize with local seed products if any exist
      const local = readJson(DB_FILE, {});
      await redis.set('supplierdesk:products', local || {});
      await redis.set('supplierdesk:products:initialized', true);
      return local || {};
    } catch (e) {
      console.warn('Redis getProducts failed, fallback to local file:', e);
    }
  }
  return readJson(DB_FILE, {});
}

export async function saveProducts(products: Record<string, any>): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.set('supplierdesk:products', products);
      await redis.set('supplierdesk:products:initialized', true);
    } catch (e) {
      console.warn('Redis saveProducts failed, writing to local file:', e);
    }
  }
  writeJson(DB_FILE, products);
  if (!isServerless) {
    writeJson(path.join(BASE, 'data', 'products.json'), products);
  }
}

export async function getProduct(url: string): Promise<any | null> {
  const all = await getProducts();
  return all[url] || null;
}

export async function saveProduct(product: any): Promise<void> {
  const all = await getProducts();
  all[product.url] = product;
  await saveProducts(all);
}

export async function deleteProduct(url: string): Promise<Record<string, any>> {
  const all = await getProducts();
  delete all[url];
  await saveProducts(all);
  return all;
}

// --- ORDERS ---
export async function getOrders(): Promise<any[]> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const data = await redis.get<any[]>('supplierdesk:orders');
      if (Array.isArray(data)) return data;
    } catch (e) {
      console.warn('Redis getOrders failed, fallback to local file:', e);
    }
  }
  return readJson(ORDERS_FILE, []);
}

export async function saveOrders(orders: any[]): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.set('supplierdesk:orders', orders);
    } catch (e) {
      console.warn('Redis saveOrders failed, writing to local file:', e);
    }
  }
  writeJson(ORDERS_FILE, orders);
  if (!isServerless) {
    writeJson(path.join(BASE, 'data', 'orders.json'), orders);
  }
}

// --- CONFIG ---
export const DEFAULT_CONFIG = {
  delay_seconds: 3,
  markup_percent: 12,
  fixed_add: 0,
  round_to: 10,
  cost_price_mode: {
    ryans: 'special',
    startech: 'regular'
  },
  zenrows_api_key: '',
  daraz_app_key: '',
  daraz_secret: '',
  daraz_access_token: '',
  upstash_redis_rest_url: '',
  upstash_redis_rest_token: '',
  smtp_host: '',
  smtp_port: 587,
  smtp_secure: false,
  smtp_user: '',
  smtp_pass: '',
  smtp_from: ''
};

function sanitizeConfig(cfg: any) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const cleaned = { ...cfg };
  if (typeof cleaned.zenrows_api_key === 'string') cleaned.zenrows_api_key = cleaned.zenrows_api_key.trim();
  if (typeof cleaned.daraz_app_key === 'string') cleaned.daraz_app_key = cleaned.daraz_app_key.trim();
  if (typeof cleaned.daraz_secret === 'string') cleaned.daraz_secret = cleaned.daraz_secret.trim();
  if (typeof cleaned.daraz_access_token === 'string') cleaned.daraz_access_token = cleaned.daraz_access_token.trim();
  if (typeof cleaned.upstash_redis_rest_url === 'string') cleaned.upstash_redis_rest_url = cleaned.upstash_redis_rest_url.trim();
  if (typeof cleaned.upstash_redis_rest_token === 'string') cleaned.upstash_redis_rest_token = cleaned.upstash_redis_rest_token.trim();
  if (typeof cleaned.smtp_host === 'string') cleaned.smtp_host = cleaned.smtp_host.trim();
  if (typeof cleaned.smtp_user === 'string') cleaned.smtp_user = cleaned.smtp_user.trim();
  if (typeof cleaned.smtp_pass === 'string') cleaned.smtp_pass = cleaned.smtp_pass.trim();
  return cleaned;
}

export async function getConfig(): Promise<any> {
  const redis = getRedisClient();
  let merged: any = null;
  if (redis) {
    try {
      const data = await redis.get<any>('supplierdesk:config');
      if (data && typeof data === 'object') {
        merged = { ...DEFAULT_CONFIG, ...data };
      }
    } catch (e) {
      console.warn('Redis getConfig failed, fallback to local file:', e);
    }
  }
  if (!merged) {
    const baseCfg = readJson(path.join(BASE, 'config.json'), {});
    const local = readJson(CFG_FILE, {});
    merged = { ...DEFAULT_CONFIG, ...baseCfg, ...local };
  }
  const sanitized = sanitizeConfig(merged);
  if (!sanitized.zenrows_api_key && process.env.ZENROWS_API_KEY) {
    sanitized.zenrows_api_key = process.env.ZENROWS_API_KEY.trim();
  }
  return sanitized;
}

export async function saveConfig(cfg: any): Promise<void> {
  const sanitized = sanitizeConfig(cfg);
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.set('supplierdesk:config', sanitized);
    } catch (e) {
      console.warn('Redis saveConfig failed, fallback to local file:', e);
    }
  }
  writeJson(CFG_FILE, sanitized);
  if (!isServerless) {
    writeJson(path.join(BASE, 'config.json'), sanitized);
  }
}

// --- USERS & AUTH ---
export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  role: string;
  createdAt: string;
}

export interface SessionData {
  userId: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
}

export interface DarazStoreRecord {
  id: string;
  ownerUserId: string;
  sellerId: string;
  name: string;
  accessToken: string;
  refreshToken?: string;
  createdAt: string;
  updatedAt: string;
}

export async function getUserByEmail(email: string): Promise<UserRecord | null> {
  const normalized = email.trim().toLowerCase();
  const redis = getRedisClient();
  if (redis) {
    try {
      const user = await redis.get<UserRecord>(`supplierdesk:user:${normalized}`);
      if (user) return user;
    } catch (e) {
      console.warn('Redis getUserByEmail failed, checking local file:', e);
    }
  }
  const users = readJson(USERS_FILE, {}) as Record<string, UserRecord>;
  return users[normalized] || null;
}

export async function createUser(user: UserRecord): Promise<UserRecord> {
  const normalized = user.email.trim().toLowerCase();
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.set(`supplierdesk:user:${normalized}`, user);
      await redis.sadd('supplierdesk:users:all', normalized);
      return user;
    } catch (e) {
      console.warn('Redis createUser failed, writing to local file:', e);
    }
  }
  const users = readJson(USERS_FILE, {}) as Record<string, UserRecord>;
  users[normalized] = user;
  writeJson(USERS_FILE, users);
  return user;
}

export async function createSession(token: string, sessionData: SessionData): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    try {
      // 7 days expiration (604800 seconds)
      await redis.set(`supplierdesk:session:${token}`, sessionData, { ex: 604800 });
      return;
    } catch (e) {
      console.warn('Redis createSession failed, writing to local file:', e);
    }
  }
  const sessions = readJson(SESSIONS_FILE, {}) as Record<string, SessionData>;
  sessions[token] = sessionData;
  writeJson(SESSIONS_FILE, sessions);
}

export async function getSession(token: string): Promise<SessionData | null> {
  if (!token) return null;
  const redis = getRedisClient();
  if (redis) {
    try {
      const session = await redis.get<SessionData>(`supplierdesk:session:${token}`);
      if (session) return session;
    } catch (e) {
      console.warn('Redis getSession failed, checking local file:', e);
    }
  }
  const sessions = readJson(SESSIONS_FILE, {}) as Record<string, SessionData>;
  return sessions[token] || null;
}

export async function deleteSession(token: string): Promise<void> {
  if (!token) return;
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.del(`supplierdesk:session:${token}`);
      return;
    } catch (e) {
      console.warn('Redis deleteSession failed, removing from local file:', e);
    }
  }
  const sessions = readJson(SESSIONS_FILE, {}) as Record<string, SessionData>;
  delete sessions[token];
  writeJson(SESSIONS_FILE, sessions);
}

export async function updateUser(user: UserRecord): Promise<UserRecord> {
  const normalized = user.email.trim().toLowerCase();
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.set(`supplierdesk:user:${normalized}`, user);
      await redis.sadd('supplierdesk:users:all', normalized);
      return user;
    } catch (e) {
      console.warn('Redis updateUser failed, writing to local file:', e);
    }
  }
  const users = readJson(USERS_FILE, {}) as Record<string, UserRecord>;
  users[normalized] = user;
  writeJson(USERS_FILE, users);
  return user;
}

export async function getAllUsers(): Promise<UserRecord[]> {
  const userMap = new Map<string, UserRecord>();

  // 1. Check local users
  const local = readJson(USERS_FILE, {}) as Record<string, UserRecord>;
  for (const u of Object.values(local)) {
    if (u && u.email) {
      userMap.set(u.email.toLowerCase().trim(), u);
    }
  }

  // 2. Check Redis
  const redis = getRedisClient();
  if (redis) {
    try {
      const emails = await redis.smembers<string[]>('supplierdesk:users:all');
      if (Array.isArray(emails)) {
        for (const email of emails) {
          if (email) {
            const normalized = email.toLowerCase().trim();
            if (!userMap.has(normalized)) {
              const u = await redis.get<UserRecord>(`supplierdesk:user:${normalized}`);
              if (u && u.email) {
                userMap.set(normalized, u);
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn('Redis getAllUsers failed, falling back to local file:', e);
    }
  }

  return Array.from(userMap.values());
}

export async function findUsersByName(query: string): Promise<UserRecord[]> {
  const all = await getAllUsers();
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return all.filter(u => {
    const name = (u.name || '').toLowerCase();
    const emailPrefix = (u.email || '').split('@')[0].toLowerCase();
    return name.includes(q) || q.includes(name) || emailPrefix.includes(q);
  });
}

export async function ensureDefaultUser(): Promise<void> {
  try {
    const existing = await getUserByEmail('admin@supplierdesk.com');
    if (!existing) {
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash('admin123', salt);
      await createUser({
        id: 'usr_admin',
        email: 'admin@supplierdesk.com',
        name: 'Admin Seller',
        passwordHash,
        role: 'admin',
        createdAt: new Date().toISOString()
      });
    } else {
      const redis = getRedisClient();
      if (redis) {
        await redis.sadd('supplierdesk:users:all', 'admin@supplierdesk.com');
      }
    }
  } catch (err) {
    console.warn('Failed to seed default admin user:', err);
  }
}

export async function getUserById(id: string): Promise<UserRecord | null> {
  const all = await getAllUsers();
  return all.find(u => u.id === id) || null;
}

export async function getDarazStores(ownerUserId: string): Promise<DarazStoreRecord[]> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const data = await redis.get<DarazStoreRecord[]>(`supplierdesk:daraz:stores:${ownerUserId}`);
      if (Array.isArray(data)) return data;
    } catch (e) {
      console.warn('Redis getDarazStores failed, checking local file:', e);
    }
  }
  const stores = readJson(DARAZ_STORES_FILE, {}) as Record<string, DarazStoreRecord[]>;
  return Array.isArray(stores[ownerUserId]) ? stores[ownerUserId] : [];
}

export async function getAllDarazStores(): Promise<DarazStoreRecord[]> {
  const users = await getAllUsers();
  const stores = await Promise.all(users.map(user => getDarazStores(user.id)));
  return stores.flat();
}

export async function saveDarazStore(store: DarazStoreRecord): Promise<void> {
  const stores = await getDarazStores(store.ownerUserId);
  const index = stores.findIndex(existing => existing.id === store.id);
  if (index >= 0) stores[index] = store;
  else stores.push(store);

  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.set(`supplierdesk:daraz:stores:${store.ownerUserId}`, stores);
    } catch (e) {
      console.warn('Redis saveDarazStore failed, writing to local file:', e);
    }
  }
  const allStores = readJson(DARAZ_STORES_FILE, {}) as Record<string, DarazStoreRecord[]>;
  allStores[store.ownerUserId] = stores;
  writeJson(DARAZ_STORES_FILE, allStores);
}

export async function deleteDarazStore(ownerUserId: string, storeId: string): Promise<boolean> {
  const stores = await getDarazStores(ownerUserId);
  const filtered = stores.filter(store => store.id !== storeId);
  if (filtered.length === stores.length) return false;

  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.set(`supplierdesk:daraz:stores:${ownerUserId}`, filtered);
    } catch (e) {
      console.warn('Redis deleteDarazStore failed, writing to local file:', e);
    }
  }
  const allStores = readJson(DARAZ_STORES_FILE, {}) as Record<string, DarazStoreRecord[]>;
  allStores[ownerUserId] = filtered;
  writeJson(DARAZ_STORES_FILE, allStores);
  return true;
}

// --- OTP (ONE-TIME PASSWORD) SYSTEM ---
export interface OtpRecord {
  otp: string;
  purpose: string;
  identifier: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
}

export async function createOtp(purpose: string, identifier: string): Promise<{ otp: string; expiresAt: number }> {
  const normId = identifier.trim().toLowerCase();
  // Generate secure 6-digit numeric OTP (100000 - 999999)
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const now = Date.now();
  const expiresAt = now + 10 * 60 * 1000; // 10 minutes lifetime

  const record: OtpRecord = {
    otp,
    purpose,
    identifier: normId,
    createdAt: now,
    expiresAt,
    attempts: 0
  };

  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.set(`supplierdesk:otp:${purpose}:${normId}`, record, { ex: 600 });
    } catch (e) {
      console.warn('Redis createOtp failed:', e);
    }
  }

  const otps = readJson(OTPS_FILE, {}) as Record<string, OtpRecord>;
  otps[`${purpose}:${normId}`] = record;
  writeJson(OTPS_FILE, otps);

  return { otp, expiresAt };
}

export async function verifyOtp(purpose: string, identifier: string, code: string): Promise<{ valid: boolean; error?: string }> {
  const normId = identifier.trim().toLowerCase();
  const cleanCode = (code || '').trim();
  const now = Date.now();

  let record: OtpRecord | null = null;
  const redis = getRedisClient();
  if (redis) {
    try {
      record = await redis.get<OtpRecord>(`supplierdesk:otp:${purpose}:${normId}`);
    } catch (e) {
      console.warn('Redis verifyOtp get failed:', e);
    }
  }

  if (!record) {
    const otps = readJson(OTPS_FILE, {}) as Record<string, OtpRecord>;
    record = otps[`${purpose}:${normId}`] || null;
  }

  if (!record) {
    return { valid: false, error: 'No verification code requested or code has expired. Please request a new code.' };
  }

  if (now > record.expiresAt) {
    await deleteOtp(purpose, normId);
    return { valid: false, error: 'Verification code has expired. Please request a new code.' };
  }

  if (record.attempts >= 5) {
    await deleteOtp(purpose, normId);
    return { valid: false, error: 'Too many failed attempts. Please request a new verification code.' };
  }

  if (record.otp !== cleanCode) {
    record.attempts = (record.attempts || 0) + 1;
    if (redis) {
      try {
        const remainingTtl = Math.max(1, Math.floor((record.expiresAt - now) / 1000));
        await redis.set(`supplierdesk:otp:${purpose}:${normId}`, record, { ex: remainingTtl });
      } catch {}
    }
    const otps = readJson(OTPS_FILE, {}) as Record<string, OtpRecord>;
    otps[`${purpose}:${normId}`] = record;
    writeJson(OTPS_FILE, otps);

    const remaining = 5 - record.attempts;
    return { valid: false, error: `Invalid verification code (${remaining} attempt${remaining === 1 ? '' : 's'} remaining).` };
  }

  // Verification succeeded - consume the OTP so it cannot be re-used
  await deleteOtp(purpose, normId);
  return { valid: true };
}

export async function deleteOtp(purpose: string, identifier: string): Promise<void> {
  const normId = identifier.trim().toLowerCase();
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.del(`supplierdesk:otp:${purpose}:${normId}`);
    } catch {}
  }
  const otps = readJson(OTPS_FILE, {}) as Record<string, OtpRecord>;
  delete otps[`${purpose}:${normId}`];
  writeJson(OTPS_FILE, otps);
}
