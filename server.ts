import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import axios from 'axios';
import * as cheerio from 'cheerio';
import sharp from 'sharp';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import {
  getProducts,
  saveProducts,
  getProduct,
  deleteProduct,
  getOrders,
  saveOrders,
  getConfig,
  saveConfig,
  getUserByEmail,
  getUserById,
  createUser,
  updateUser,
  getAllUsers,
  findUsersByName,
  createSession,
  getSession,
  deleteSession,
  createOtp,
  verifyOtp,
  deleteOtp,
  getDarazStores,
  getAllDarazStores,
  saveDarazStore,
  deleteDarazStore,
  isUsingRedis,
  testRedisConnection,
  ensureDefaultUser,
  UPLOADS_DIR,
  DEFAULT_CONFIG
} from './db.js';
import {
  sendOtpEmail,
  testSmtp,
  isSmtpConfigured
} from './mailer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE = fs.existsSync(path.join(process.cwd(), 'static')) ? process.cwd() : __dirname;

interface AppConfig {
  delay_seconds: number;
  markup_percent: number;
  fixed_add: number;
  round_to: number;
  cost_price_mode: {
    ryans: 'special' | 'regular';
    startech: 'special' | 'regular';
    [key: string]: 'special' | 'regular';
  };
  zenrows_api_key?: string;
  daraz_app_key?: string;
  daraz_secret?: string;
  daraz_access_token?: string;
  upstash_redis_rest_url?: string;
  upstash_redis_rest_token?: string;
  smtp_host?: string;
  smtp_port?: number;
  smtp_secure?: boolean;
  smtp_user?: string;
  smtp_pass?: string;
  smtp_from?: string;
}

async function getCfg(): Promise<AppConfig> {
  const cfg = await getConfig();
  if (Object.prototype.hasOwnProperty.call(cfg, 'gemini_api_key')) {
    const legacyCfg = { ...cfg } as AppConfig & { gemini_api_key?: string };
    delete legacyCfg.gemini_api_key;
    await saveConfig(legacyCfg);
    return legacyCfg;
  }
  return cfg;
}

async function saveCfg(cfg: AppConfig): Promise<void> {
  await saveConfig(cfg);
}

async function loadDb(): Promise<Record<string, any>> {
  return await getProducts();
}

async function saveDb(db: Record<string, any>): Promise<void> {
  await saveProducts(db);
}

async function loadOrdersList(): Promise<any[]> {
  return await getOrders();
}

async function saveOrdersList(orders: any[]): Promise<void> {
  await saveOrders(orders);
}

function nowString(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
];

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function toNumber(text: any): number | null {
  if (text === null || text === undefined) return null;
  const str = String(text);
  const match = str.match(/\d[\d,]*\.?\d*/);
  if (!match) return null;
  const num = parseFloat(match[0].replace(/,/g, ''));
  return isNaN(num) ? null : num;
}

function firstNonNegativeMetric(...values: unknown[]): number | undefined {
  for (const value of values) {
    if ((typeof value !== 'number' && typeof value !== 'string') || value === '') continue;
    const number = typeof value === 'string' ? Number(value.replace(/,/g, '').trim()) : value;
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return undefined;
}

function getDarazResponseError(response: any): { code: string; message: string } | null {
  const errorResponse = response?.error_response || response?.data?.error_response;
  const code = errorResponse?.code ?? response?.code ?? response?.data?.code;
  const error = response?.error || response?.data?.error;
  if (!errorResponse && !error && (code === undefined || String(code) === '0')) return null;
  return {
    code: String(code ?? 'API_ERROR'),
    message: String(errorResponse?.message || response?.message || response?.data?.message || error || 'Daraz API request failed')
  };
}

function getDarazItemMetricSources(response: any): any[] {
  return [
    response?.data?.item,
    response?.data?.product,
    response?.data?.traffic,
    response?.data,
    response?.item,
    response?.product,
    response
  ].filter((value) => value && typeof value === 'object' && !Array.isArray(value));
}

function clean(text: any): string {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function siteOf(urlStr: string): 'ryans' | 'startech' {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error('Link must start with https://');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Link must start with https://');
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'ryans.com' || host.endsWith('.ryans.com')) {
    return 'ryans';
  }
  if (host === 'startech.com.bd' || host.endsWith('.startech.com.bd')) {
    return 'startech';
  }
  throw new Error(`Unsupported site: ${host || urlStr}`);
}

function inStock(val: any): boolean | null {
  if (!val) return null;
  const s = String(val).replace(/\s+/g, '').toLowerCase();
  if (s === 'instock' || s === 'in_stock') return true;
  if (s === 'outofstock' || s === 'out_of_stock') return false;
  return null;
}

function parsePairs($: cheerio.CheerioAPI): Record<string, string> {
  const specs: Record<string, string> = {};
  $('tr').each((_, el) => {
    const cells = $(el).children('td, th');
    if (cells.length === 2) {
      const k = clean($(cells[0]).text());
      const v = clean($(cells[1]).text());
      if (k && v && k.length < 80 && !specs[k]) {
        specs[k] = v;
      }
    }
  });
  $('dl').each((_, el) => {
    $(el).find('dt').each((_, dt) => {
      const dd = $(dt).next('dd');
      if (dd.length) {
        const k = clean($(dt).text());
        const v = clean(dd.text());
        if (k && v && k.length < 80 && !specs[k]) {
          specs[k] = v;
        }
      }
    });
  });
  return specs;
}

function findPriceAfter($: cheerio.CheerioAPI, label: string): number | null {
  const labelRegex = new RegExp(`^\\s*${label}\\s*:?\\s*$`, 'i');
  let foundPrice: number | null = null;

  $('*').each((_, el) => {
    if (foundPrice !== null) return false;
    const text = $(el).clone().children().remove().end().text();
    if (labelRegex.test(text)) {
      const parent = $(el).parent();
      const parentText = parent.text();
      const after = parentText.slice(parentText.indexOf(text) + text.length);
      const num = toNumber(after);
      if (num !== null) {
        foundPrice = num;
        return false;
      }
    }
  });

  return foundPrice;
}

function getMeta($: cheerio.CheerioAPI, key: string): string | null {
  const tag = $(`meta[property="${key}"], meta[name="${key}"]`).first();
  const content = tag.attr('content');
  return content ? clean(content) : null;
}

function collectImages($: cheerio.CheerioAPI, site: 'ryans' | 'startech'): string[] {
  const urls: string[] = [];
  const og = getMeta($, 'og:image');

  $('img').each((_, el) => {
    const src = $(el).attr('data-src') || $(el).attr('src') || '';
    if (site === 'ryans' && src.includes('/storage/products/main/')) {
      urls.push(src);
    }
    if (site === 'startech' && src.includes('/image/cache/catalog/')) {
      urls.push(src.replace(/-\d+x\d+(\.\w+)$/, '-500x500$1'));
    }
  });

  if (urls.length === 0 && og) {
    urls.push(og);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (!seen.has(u) && !u.includes('logo')) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

function parseRyansSpecs($: cheerio.CheerioAPI): Record<string, string> {
  const specs: Record<string, string> = {};

  // Method 1: Ryans attribute layout (.att-title and .att-value)
  $('.att-title').each((_, el) => {
    const k = clean($(el).text());
    const row = $(el).closest('.row');
    const v = clean(row.find('.att-value').first().text());
    if (k && v && k.length < 100 && !specs[k]) {
      specs[k] = v;
    }
  });

  // Method 2: Standard HTML table rows
  $('tr').each((_, el) => {
    const cells = $(el).children('td, th');
    if (cells.length === 2) {
      const k = clean($(cells[0]).text());
      const v = clean($(cells[1]).text());
      if (k && v && k.length < 100 && !specs[k]) {
        specs[k] = v;
      }
    }
  });

  // Method 3: Definition lists (dl, dt, dd)
  $('dl').each((_, el) => {
    $(el).find('dt').each((_, dt) => {
      const dd = $(dt).next('dd');
      if (dd.length) {
        const k = clean($(dt).text());
        const v = clean(dd.text());
        if (k && v && k.length < 100 && !specs[k]) {
          specs[k] = v;
        }
      }
    });
  });

  return specs;
}

function parseRyansDetails($: cheerio.CheerioAPI): string {
  // Check .details-tab first (Ryans full details section)
  const detailsTab = $('.details-tab').clone();
  if (detailsTab.length > 0) {
    detailsTab.find('script, style, button, noscript, .readmore-link').remove();
    const blocks: string[] = [];
    detailsTab.find('h1, h2, h3, h4, h5, h6, p, li').each((_, el) => {
      const text = clean($(el).text());
      if (text && text.length > 5 && !blocks.includes(text)) {
        blocks.push(text);
      }
    });
    if (blocks.length > 0) {
      return blocks.join('\n\n');
    }
    const rawText = clean(detailsTab.text());
    if (rawText.length > 20) {
      return rawText;
    }
  }

  // Fallback to other possible detail selectors on Ryans
  const altDetails = $('.product-details-content, .pro-description, .product-description, #details').clone();
  if (altDetails.length > 0) {
    altDetails.find('script, style, button, noscript').remove();
    const raw = clean(altDetails.text());
    if (raw.length > 20) return raw;
  }

  // Fallback to short-desc-attr
  const shortDesc = clean($('.short-desc-attr').text());
  if (shortDesc.length > 20) {
    return shortDesc;
  }

  // Fallback to meta description
  const metaDesc = clean($('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content'));
  if (metaDesc.length > 20) {
    return metaDesc;
  }

  return '';
}

function parseRyans($: cheerio.CheerioAPI, url: string): any {
  const special = toNumber(getMeta($, 'product:price:amount'));
  const regular = findPriceAfter($, 'Regular Price');
  const brand = getMeta($, 'product:brand') || 'No Brand';
  const rawTitle = clean($('h1').first().text() || $('title').first().text()) || 'Unknown Product';
  const title = rawTitle.toLowerCase().includes(brand.toLowerCase()) ? rawTitle : `${brand} ${rawTitle}`;
  const specs = parseRyansSpecs($);
  const highlights = Object.entries(specs).map(([k, v]) => `${k}: ${v}`);
  const description = parseRyansDetails($);
  const boxContent = specs["What's in the box"] || specs['Box Content'] || 'Product, User Manual';
  const warranty = specs['Warranty'] || 'No Warranty';
  const weight = specs['Weight (Kg)'] || specs['Weight'] || '0.5';

  return {
    source: 'ryans',
    url,
    supplier_sku: getMeta($, 'product:retailer_item_id') || '',
    name: title,
    brand,
    category_hint: getMeta($, 'product:category'),
    price_special: special,
    price_regular: regular ?? special,
    in_stock: inStock(getMeta($, 'product:availability')),
    specs,
    highlights,
    description,
    warranty,
    weight,
    images: collectImages($, 'ryans'),
    box_content: boxContent
  };
}

function parseStartechSpecs($: cheerio.CheerioAPI): Record<string, string> {
  const specs: Record<string, string> = {};
  const specContainer = $('#specification, .specification-tab, .data-table').length
    ? $('#specification, .specification-tab, .data-table')
    : $('body');

  specContainer.find('tr').each((_, el) => {
    const cells = $(el).children('td, th');
    if (cells.length === 2) {
      const k = clean($(cells[0]).text());
      const v = clean($(cells[1]).text());
      if (k && v && k.length < 100 && !specs[k]) {
        // Exclude general page price/status metadata if found in header table
        if (!['Price', 'Regular Price', 'Status', 'Product Code'].includes(k)) {
          specs[k] = v;
        }
      }
    }
  });

  // Fallback to general parsePairs if empty
  if (Object.keys(specs).length === 0) {
    const pairs = parsePairs($);
    for (const [k, v] of Object.entries(pairs)) {
      if (!['Price', 'Regular Price', 'Status', 'Product Code'].includes(k)) {
        specs[k] = v;
      }
    }
  }

  return specs;
}

function parseStartechDetails($: cheerio.CheerioAPI): string {
  const descEl = $('.full-description, #description .full-description, [itemprop="description"], section.description .description, #description').clone();
  if (descEl.length > 0) {
    descEl.find('script, style, button, noscript').remove();
    const blocks: string[] = [];
    descEl.find('h1, h2, h3, h4, h5, h6, p, li').each((_, el) => {
      const text = clean($(el).text());
      if (text.toLowerCase() === 'description') return;
      if (text && text.length > 5 && !blocks.includes(text)) {
        blocks.push(text);
      }
    });
    if (blocks.length > 0) {
      return blocks.join('\n\n');
    }
    const rawText = clean(descEl.text());
    if (rawText.length > 20) {
      return rawText;
    }
  }

  const metaDesc = clean($('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content'));
  if (metaDesc.length > 20) {
    return metaDesc;
  }

  return '';
}

function parseStartech($: cheerio.CheerioAPI, url: string): any {
  const listed = toNumber(getMeta($, 'product:price:amount'));
  const regular = findPriceAfter($, 'Regular Price');
  const brand = getMeta($, 'product:brand') || 'No Brand';
  const h1 = clean($('h1').first().text());
  const rawTitle = h1 || 'Unknown Product';
  const title = rawTitle.toLowerCase().includes(brand.toLowerCase()) ? rawTitle : `${brand} ${rawTitle}`;
  const specs = parseStartechSpecs($);
  const highlights = Object.entries(specs).map(([k, v]) => `${k}: ${v}`);
  const description = parseStartechDetails($);
  const boxContent = specs["What's in the box"] || specs['Box Content'] || 'Product, User Manual';
  const warranty = specs['Warranty'] || 'No Warranty';
  const weight = specs['Weight'] || specs['Weight (kg)'] || specs['Weight (Kg)'] || '0.5';
  const dimensions = specs['Dimension'] || specs['Dimensions'] || '10x10x10';

  return {
    source: 'startech',
    url,
    supplier_sku: getMeta($, 'product:retailer_item_id') || '',
    name: title,
    brand,
    category_hint: null,
    price_special: listed,
    price_regular: regular ?? listed,
    in_stock: inStock(getMeta($, 'product:availability')),
    specs,
    highlights,
    description,
    warranty,
    weight,
    dimensions,
    images: collectImages($, 'startech'),
    box_content: boxContent
  };
}

function sellPrice(cost: number | null, cfg: AppConfig): number | null {
  if (cost === null || cost === undefined) return null;
  const raw = cost * (1 + cfg.markup_percent / 100.0) + cfg.fixed_add;
  const step = cfg.round_to;
  return step ? Math.ceil(raw / step) * step : Math.round(raw);
}

function applyPricing(p: any, cfg: AppConfig): any {
  if (p.source === 'daraz' || p.daraz_synced) {
    if (p.sell_override !== undefined && p.sell_override !== null) {
      p.sell_price = p.sell_override;
    }
    return p;
  }
  const mode = cfg.cost_price_mode[p.source] || 'regular';
  const cost = mode === 'regular' ? p.price_regular : (p.price_special ?? p.price_regular);
  p.cost_price = cost;
  p.cost_mode = mode;
  p.sell_price = sellPrice(cost, cfg);
  return p;
}

function getFlags(p: any): string[] {
  const out: string[] = [];
  if (!p.name) out.push('missing name');
  if (p.source !== 'daraz' && !p.daraz_synced && (p.cost_price === null || p.cost_price === undefined)) {
    out.push('missing cost price');
  }
  if (!p.images || p.images.length === 0) out.push('no images');
  if (p.source !== 'daraz' && !p.daraz_synced && (!p.specs || Object.keys(p.specs).length === 0)) {
    out.push('no specs parsed (selectors need tuning)');
  }
  if (p.in_stock === false) out.push('out of stock');
  if (p.in_stock === null || p.in_stock === undefined) out.push('stock unknown');
  return out;
}

const BENGALI_TECH_DICT: Record<string, string> = {
  logitech: 'লজিটেক',
  pebble: 'পেবল',
  keys: 'কীজ',
  key: 'কী',
  keyboard: 'কীবোর্ড',
  keyboards: 'কীবোর্ড',
  mouse: 'মাউস',
  mice: 'মাউস',
  pad: 'প্যাড',
  mousepad: 'মাউস প্যাড',
  gaming: 'গেমিং',
  wireless: 'ওয়্যারলেস',
  bluetooth: 'ব্লুটুথ',
  multi: 'মাল্টি',
  device: 'ডিভাইস',
  tonal: 'টোনাল',
  graphite: 'গ্রাফাইট',
  black: 'কালো',
  white: 'সাদা',
  blue: 'নীল',
  red: 'লাল',
  pink: 'গোলাপি',
  grey: 'ধূসর',
  gray: 'ধূসর',
  silver: 'সিলভার',
  gold: 'গোল্ড',
  'tp-link': 'টিপি-লিংক',
  tplink: 'টিপি-লিংক',
  archer: 'আর্চার',
  router: 'রাউটার',
  routers: 'রাউটার',
  gigabit: 'গিগাবিট',
  dual: 'ডুয়াল',
  band: 'ব্যান্ড',
  'dual-band': 'ডুয়াল-ব্যান্ড',
  'wi-fi': 'ওয়াই-ফাই',
  wifi: 'ওয়াই-ফাই',
  smart: 'স্মার্ট',
  watch: 'ঘড়ি',
  smartwatch: 'স্মার্ট ঘড়ি',
  calling: 'কলিং',
  earphone: 'ইয়ারফোন',
  earphones: 'ইয়ারফোন',
  headphone: 'হেডফোন',
  headset: 'হেডসেট',
  earbuds: 'ইয়ারবাডস',
  fan: 'ফ্যান',
  cooling: 'কুলিং',
  casing: 'কেসিং',
  case: 'কেসিং',
  monitor: 'মনিটর',
  display: 'ডিসপ্লে',
  screen: 'স্ক্রিন',
  speaker: 'স্পিকার',
  speakers: 'স্পিকার',
  cable: 'ক্যাবল',
  charger: 'চার্জার',
  adapter: 'অ্যাডাপ্টার',
  dock: 'ডক',
  asus: 'আসুস',
  havit: 'হ্যাভিট',
  fantech: 'ফ্যানটেক',
  onikuma: 'ওনিকুমা',
  tenda: 'টেন্ডা',
  cudy: 'কুডি',
  oraimo: 'ওরাইমো',
  blisbond: 'ব্লিসবন্ড',
  't-wolf': 'টি-ওল্ফ',
  ajazz: 'আজ্যাজ',
  'value-top': 'ভ্যালু টপ',
  combo: 'কম্বো',
  pro: 'প্রো',
  max: 'ম্যাক্স',
  ultra: 'আল্ট্রা',
  mini: 'মিনি',
  plus: 'প্লাস',
  portable: 'পোর্টেবল',
  rgb: 'RGB',
  usb: 'ইউএসবি',
  hdmi: 'এইচডিএমআই',
  typec: 'টাইপ-সি',
  'type-c': 'টাইপ-সি',
  mechanical: 'মেকানিক্যাল',
  optical: 'অপটিক্যাল',
  silent: 'সাইলেন্ট',
  ergonomic: 'এরগনোমিক'
};

function generateBengaliTitle(title: string): string {
  if (!title) return '';
  const words = title.split(/\s+/);
  const bnWords = words.map(w => {
    const cleanWord = w.toLowerCase().replace(/[^a-z0-9\-]/g, '');
    if (BENGALI_TECH_DICT[cleanWord]) {
      return w.replace(new RegExp(cleanWord, 'i'), BENGALI_TECH_DICT[cleanWord]);
    }
    return w;
  });
  return bnWords.join(' ');
}

function calculateContentScore(p: any): { score: number; rating: 'Poor' | 'Good' | 'Excellent'; checks: Record<string, boolean> } {
  const checks: Record<string, boolean> = {
    title_valid: Boolean(p.name && p.name.length >= 20),
    title_bengali: Boolean((p.bengali_name || p.name_bn) && (p.bengali_name || p.name_bn).length >= 10),
    category_set: Boolean(p.primary_category || p.category_hint),
    images_min3: Boolean(Array.isArray(p.images) && p.images.length >= 3),
    images_format: Boolean(Array.isArray(p.images) && p.images.length > 0 && p.images.every((img: string) => {
      const clean = String(img).split('?')[0].toLowerCase();
      return clean.endsWith('.jpg') || clean.endsWith('.jpeg') || clean.endsWith('.png') || img.includes('daraz.com.bd');
    })),
    promo_image: Boolean(p.promo_image || (p.images && p.images.length > 0)),
    brand_valid: Boolean(p.brand && p.brand !== 'Unknown Product'),
    color_family: Boolean(p.color_family),
    connectivity: Boolean(p.connectivity_type),
    price_valid: Boolean(Number(p.sell_price || p.price_special || p.price_regular) > 0),
    stock_valid: Boolean(p.stock_quantity !== undefined && p.stock_quantity >= 0),
    sku_valid: Boolean(p.seller_sku || p.supplier_sku),
    description_rich: Boolean(p.description && p.description.length >= 50),
    highlights_min3: Boolean(Array.isArray(p.highlights) && p.highlights.length >= 3),
    weight_valid: Boolean(p.package_weight || p.weight),
    dimensions_valid: Boolean(p.package_length && p.package_width && p.package_height),
    hazmat_valid: Boolean(p.hazmat),
    warranty_valid: Boolean(p.warranty_type && p.warranty_period)
  };

  let score = 0;
  if (checks.title_valid) score += 10;
  if (checks.title_bengali) score += 5;
  if (checks.category_set) score += 5;
  if (checks.images_min3) score += 10;
  if (checks.images_format) score += 5;
  if (checks.promo_image) score += 5;
  if (checks.brand_valid) score += 10;
  if (checks.color_family) score += 5;
  if (checks.connectivity) score += 5;
  if (checks.price_valid) score += 5;
  if (checks.stock_valid) score += 5;
  if (checks.sku_valid) score += 5;
  if (checks.description_rich) score += 10;
  if (checks.highlights_min3) score += 5;
  if (checks.weight_valid) score += 3;
  if (checks.dimensions_valid) score += 3;
  if (checks.hazmat_valid) score += 2;
  if (checks.warranty_valid) score += 2;

  score = Math.min(100, Math.max(0, score));
  let rating: 'Poor' | 'Good' | 'Excellent' = 'Poor';
  if (score >= 85) rating = 'Excellent';
  else if (score >= 60) rating = 'Good';

  return { score, rating, checks };
}

function finalizeProduct(p: any, cfg: AppConfig): any {
  applyPricing(p, cfg);
  if (p.sell_override !== undefined && p.sell_override !== null) {
    p.sell_price = p.sell_override;
  }
  p.flags = getFlags(p);
  p.status = p.status || 'draft';
  p.description = p.description || '';
  if ((!p.highlights || p.highlights.length === 0) && p.specs && Object.keys(p.specs).length > 0) {
    p.highlights = Object.entries(p.specs).map(([k, v]) => `${k}: ${v}`);
  } else {
    p.highlights = p.highlights || [];
  }

  // Daraz optimization fields
  p.bengali_name = p.bengali_name || p.name_bn || generateBengaliTitle(p.name || '');
  p.name_bn = p.bengali_name;

  const rawDims = String(p.dimensions || '15x12x6');
  const dimParts = rawDims.split(/x|\*|\s+/i).map(n => parseFloat(n)).filter(n => !isNaN(n));
  p.package_length = p.package_length ?? (dimParts[0] ? (dimParts[0] > 50 ? Math.round(dimParts[0] / 10) : dimParts[0]) : 15);
  p.package_width = p.package_width ?? (dimParts[1] ? (dimParts[1] > 50 ? Math.round(dimParts[1] / 10) : dimParts[1]) : 12);
  p.package_height = p.package_height ?? (dimParts[2] ? (dimParts[2] > 50 ? Math.round(dimParts[2] / 10) : dimParts[2]) : 6);
  p.dimensions = `${p.package_length}x${p.package_width}x${p.package_height}`;

  p.weight = p.weight || '0.5';
  p.package_weight = p.package_weight ?? (parseFloat(p.weight) || 0.5);

  const textContext = `${p.name || ''} ${JSON.stringify(p.specs || {})}`.toLowerCase();
  p.hazmat = p.hazmat || (/(battery|li-ion|rechargeable|smartwatch|watch|earphone|headset|earbuds|power bank|cell)/i.test(textContext) ? 'Contains battery / flammables / liquid' : 'None');

  const rawWarranty = p.warranty || 'No Warranty';
  p.warranty_type = p.warranty_type || (rawWarranty !== 'No Warranty' ? 'Local seller warranty' : 'No Warranty');
  p.warranty_period = p.warranty_period || rawWarranty;
  p.warranty = p.warranty_period;

  p.color_family = p.color_family || (
    p.specs?.['Color'] || p.specs?.['Colour'] ||
    (/white/i.test(textContext) ? 'White' :
     /graphite|grey|gray/i.test(textContext) ? 'Graphite' :
     /blue/i.test(textContext) ? 'Blue' :
     /red/i.test(textContext) ? 'Red' :
     /pink/i.test(textContext) ? 'Pink' :
     /gold/i.test(textContext) ? 'Gold' :
     /silver/i.test(textContext) ? 'Silver' : 'Black')
  );

  p.connectivity_type = p.connectivity_type || (
    p.specs?.['Connectivity'] || p.specs?.['Interface(s)'] || p.specs?.['Interface'] ||
    (/bluetooth/i.test(textContext) ? 'Bluetooth' :
     /wireless/i.test(textContext) ? 'Wireless (2.4GHz)' :
     /dual band/i.test(textContext) ? 'Dual Band Wi-Fi' :
     /wired|usb/i.test(textContext) ? 'Wired' : 'Standard')
  );

  p.model = p.model || p.specs?.['Model'] || '';
  p.box_content = p.box_content || p.specs?.["What's in the box"] || p.specs?.['Box Content'] || 'Product, User Manual';
  p.seller_sku = p.seller_sku || p.supplier_sku || `SKU-${Date.now().toString().slice(-6)}`;
  p.stock_quantity = p.stock_quantity !== undefined ? p.stock_quantity : (p.in_stock === false ? 0 : 10);
  p.price_regular = p.price_regular || p.sell_price || 500;
  p.price_special = p.price_special || p.sell_price || p.price_regular;
  p.availability = p.availability !== undefined ? p.availability : (p.in_stock !== false);
  p.promo_image = p.promo_image || (Array.isArray(p.images) && p.images[0]) || '';
  p.video_url = p.video_url || '';

  const scoreObj = calculateContentScore(p);
  p.content_score = scoreObj.score;
  p.content_rating = scoreObj.rating;
  p.content_checks = scoreObj.checks;

  return p;
}

async function downloadImageBuffer(imgUrl: string, cfg?: AppConfig): Promise<Buffer | null> {
  if (!imgUrl || typeof imgUrl !== 'string') return null;

  // 1. If local static upload, read directly
  if (imgUrl.startsWith('/static/uploads/') || imgUrl.startsWith('static/uploads/')) {
    const filename = path.basename(imgUrl);
    const localPath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(localPath) && fs.statSync(localPath).size > 0) {
      try {
        return fs.readFileSync(localPath);
      } catch {}
    }
  }

  if (imgUrl.startsWith('/static/')) {
    const localPath = path.join(process.cwd(), imgUrl);
    if (fs.existsSync(localPath) && fs.statSync(localPath).size > 0) {
      try {
        return fs.readFileSync(localPath);
      } catch {}
    }
  }

  let cleanUrl = imgUrl.trim();
  if (cleanUrl.startsWith('//')) cleanUrl = 'https:' + cleanUrl;
  if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) return null;

  const zenrowsApiKey = cfg?.zenrows_api_key || process.env.ZENROWS_API_KEY;
  const isRyans = cleanUrl.includes('ryans.com');
  const isServerless = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME || !!process.env.NETLIFY;

  // If on Vercel / serverless and fetching from ryans.com with ZenRows, go through ZenRows first
  // because Ryans Cloudflare bot protection blocks AWS Lambda / Vercel datacenter IPs
  if (isRyans && zenrowsApiKey && isServerless) {
    try {
      const zUrl = `https://api.zenrows.com/v1/?apikey=${zenrowsApiKey}&url=${encodeURIComponent(cleanUrl)}&antibot=true`;
      const res = await axios.get(zUrl, {
        responseType: 'arraybuffer',
        timeout: 25000
      });
      if (res.status === 200 && res.data && res.data.byteLength > 100) {
        return Buffer.from(res.data);
      }
    } catch (e: any) {
      console.warn(`ZenRows primary image download failed for ${cleanUrl}:`, e?.message || e);
    }
  }

  // Direct fetch with browser-like headers
  try {
    const res = await axios.get(cleanUrl, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': cleanUrl
      },
      timeout: 15000
    });
    if (res.status === 200 && res.data && res.data.byteLength > 100) {
      return Buffer.from(res.data);
    }
  } catch (err: any) {
    // If direct failed and ZenRows is available (e.g. non-serverless or backup)
    if (zenrowsApiKey && !isServerless) {
      try {
        const zUrl = `https://api.zenrows.com/v1/?apikey=${zenrowsApiKey}&url=${encodeURIComponent(cleanUrl)}&antibot=true`;
        const res = await axios.get(zUrl, {
          responseType: 'arraybuffer',
          timeout: 25000
        });
        if (res.status === 200 && res.data && res.data.byteLength > 100) {
          return Buffer.from(res.data);
        }
      } catch (zErr: any) {
        console.warn(`ZenRows backup image download failed for ${cleanUrl}:`, zErr?.message || zErr);
      }
    }
  }

  return null;
}

async function convertSingleImage(imgUrl: string, cfg?: AppConfig): Promise<string> {
  if (!imgUrl || typeof imgUrl !== 'string') return imgUrl;
  const cleanUrl = imgUrl.split('?')[0].toLowerCase();
  const isAlreadyDarazCdn = imgUrl.includes('static-01.daraz.com.bd') || imgUrl.includes('alicdn.com') || imgUrl.includes('slatic.net');
  const isJpgOrPng = cleanUrl.endsWith('.jpg') || cleanUrl.endsWith('.jpeg') || cleanUrl.endsWith('.png');

  // If it's already a local /static/uploads file with jpg/png extension and exists on disk, reuse
  if (imgUrl.startsWith('/static/uploads/') && isJpgOrPng) {
    const filename = path.basename(imgUrl);
    const filepath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(filepath) && fs.statSync(filepath).size > 0) {
      return imgUrl;
    }
  }

  // If it's already on Daraz CDN and is jpg/png, reuse
  if (isAlreadyDarazCdn && isJpgOrPng) {
    return imgUrl;
  }

  try {
    const hash = crypto.createHash('md5').update(imgUrl).digest('hex');
    const filename = `${hash}.jpg`;
    const filepath = path.join(UPLOADS_DIR, filename);

    // If already converted and cached on disk, reuse immediately
    if (fs.existsSync(filepath) && fs.statSync(filepath).size > 0) {
      return `/static/uploads/${filename}`;
    }

    const buffer = await downloadImageBuffer(imgUrl, cfg);
    if (buffer) {
      await sharp(buffer)
        .jpeg({ quality: 90 })
        .toFile(filepath);
      return `/static/uploads/${filename}`;
    }
  } catch (err: any) {
    console.warn(`Failed to convert image ${imgUrl} to Daraz JPG:`, err?.message || err);
  }

  return imgUrl;
}

async function ensureDarazFormatImages(images: string[], cfg?: AppConfig): Promise<string[]> {
  if (!images || !Array.isArray(images)) return [];
  // Process images concurrently with Promise.all to optimize import speed on Vercel
  const results = await Promise.all(images.map(imgUrl => convertSingleImage(imgUrl, cfg)));
  return results.filter(Boolean);
}

const convertWebpImagesToJpg = ensureDarazFormatImages;

async function scrapeSupplierProduct(url: string, cfg: AppConfig): Promise<any> {
  const site = siteOf(url);
  const headers = {
    'User-Agent': getRandomUserAgent(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.google.com/'
  };

  const zenrowsApiKey = cfg?.zenrows_api_key || process.env.ZENROWS_API_KEY;

  let html: string = '';

  // If site is Ryans: On Vercel, Ryans blocks AWS/Vercel datacenter IPs with Cloudflare 403.
  // ZenRows bypasses this anti-bot verification.
  if (site === 'ryans') {
    if (zenrowsApiKey) {
      try {
        const fetchUrl = `https://api.zenrows.com/v1/?apikey=${zenrowsApiKey}&url=${encodeURIComponent(url)}&antibot=true`;
        const response = await axios.get(fetchUrl, { headers, timeout: 35000 });
        html = response.data;
        if (typeof html === 'string' && (html.includes('cf-turnstile') || html.includes('Just a moment...') || html.includes('Attention Required!'))) {
          const fetchUrlJs = `https://api.zenrows.com/v1/?apikey=${zenrowsApiKey}&url=${encodeURIComponent(url)}&antibot=true&js_render=true&premium_proxy=true`;
          const resJs = await axios.get(fetchUrlJs, { headers, timeout: 40000 });
          html = resJs.data;
        }
      } catch (zErr: any) {
        console.warn('ZenRows fetch error:', zErr?.message || zErr);
      }
    }

    // Direct attempt if ZenRows wasn't configured or failed
    if (!html) {
      try {
        const response = await axios.get(url, { headers, timeout: 25000 });
        html = response.data;
      } catch (err: any) {
        const status = Number(err?.response?.status);
        if (status === 403 && !zenrowsApiKey) {
          throw new Error('Ryans.com Cloudflare human-verification challenge (HTTP 403) detected. Please provide your ZenRows API Key in SupplierDesk Settings or set ZENROWS_API_KEY in Vercel to bypass Ryans bot protection.');
        }
        throw err;
      }
    }
  } else if (site === 'startech') {
    const response = await axios.get(url, { headers, timeout: 25000 });
    html = response.data;
  } else {
    throw new Error(`Unsupported site: ${site}`);
  }

  const $ = cheerio.load(html);

  let product: any;
  if (site === 'ryans') {
    product = parseRyans($, url);
  } else if (site === 'startech') {
    product = parseStartech($, url);
  }

  // Preserve original supplier images and convert to Daraz-supported JPG/PNG format
  if (product.images && product.images.length > 0) {
    product.original_images = [...product.images];
    product.images = await ensureDarazFormatImages(product.images, cfg);
  } else {
    product.original_images = [];
  }

  return finalizeProduct(product, cfg);
}

function validateProduct(p: any): { is_valid: boolean; issues: Array<{ type: 'error' | 'warn'; msg: string }> } {
  if (p.source === 'daraz' || p.daraz_synced) {
    return {
      is_valid: true,
      issues: [{ type: 'warn', msg: `Live Daraz Listing (ID: ${p.daraz_item_id || 'Active'})` }]
    };
  }

  const issues: Array<{ type: 'error' | 'warn'; msg: string }> = [];

  const name = p.name || '';
  if (!name || name.length < 20) {
    issues.push({ type: 'error', msg: 'Title is too short (min 20 chars)' });
  }
  if (name && name === name.toUpperCase() && /[A-Z]/.test(name)) {
    issues.push({ type: 'warn', msg: 'Title is ALL CAPS (avoid this for Daraz)' });
  }

  const images = Array.isArray(p.images) ? p.images : [];
  if (images.length === 0) {
    issues.push({ type: 'error', msg: 'No images found' });
  } else if (images.length < 3) {
    issues.push({ type: 'warn', msg: `Only ${images.length} images (3+ recommended)` });
  }

  const unsupportedCount = images.filter((img: string) => {
    const clean = String(img).split('?')[0].toLowerCase();
    const isJpgOrPng = clean.endsWith('.jpg') || clean.endsWith('.jpeg') || clean.endsWith('.png') || img.includes('daraz.com.bd') || img.includes('alicdn.com');
    return !isJpgOrPng;
  }).length;
  if (unsupportedCount > 0) {
    issues.push({ type: 'warn', msg: `${unsupportedCount} image(s) require JPG/PNG conversion (Daraz supports only JPG and PNG)` });
  }

  const brand = p.brand;
  if (!brand || brand === 'Unknown Product' || brand === 'No Brand') {
    issues.push({ type: 'warn', msg: 'Brand is missing or unknown' });
  }

  const specs = p.specs || {};
  if (Object.keys(specs).length === 0) {
    issues.push({ type: 'error', msg: 'No technical specifications parsed' });
  }

  const box = p.box_content || '';
  if (!box || (box.includes('Product') && box.length < 15)) {
    issues.push({ type: 'warn', msg: 'Box content description is too vague' });
  }

  return {
    is_valid: !issues.some(i => i.type === 'error'),
    issues
  };
}

function escapeXml(str: any): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface DarazCategoryPreset {
  id: number;
  name: string;
  slug: string;
  weight: number;
  l: number;
  w: number;
  h: number;
  hazmat: string;
  warranty_type: string;
  warranty_period: string;
  box: string;
}

export const DARAZ_CATEGORIES: DarazCategoryPreset[] = [
  { id: 128, name: "Networking > Routers & Access Points", slug: "router", weight: 0.8, l: 26, w: 20, h: 7, hazmat: "None", warranty_type: "Brand Warranty", warranty_period: "1 Year", box: "1x Wireless Router, 1x Power Adapter, 1x RJ45 Ethernet Cable, 1x Quick Setup Guide" },
  { id: 7537, name: "Wearable Technology > Smartwatches", slug: "smartwatch", weight: 0.25, l: 15, w: 10, h: 4, hazmat: "Battery", warranty_type: "Brand Warranty", warranty_period: "1 Year", box: "1x Smartwatch, 1x Magnetic Charging Cable, 1x User Manual, 1x Warranty Card" },
  { id: 7536, name: "Wearable Technology > Smart Fitness Bands", slug: "smartband", weight: 0.15, l: 14, w: 9, h: 3, hazmat: "Battery", warranty_type: "Brand Warranty", warranty_period: "6 Months", box: "1x Smart Fitness Band, 1x Charging Cradle/Cable, 1x User Guide" },
  { id: 157, name: "Audio > Headphones & Earphones > Earbuds / TWS", slug: "earphones", weight: 0.18, l: 12, w: 10, h: 4, hazmat: "Battery", warranty_type: "Brand Warranty", warranty_period: "6 Months", box: "1x Pair TWS Earbuds, 1x Charging Case, 1x Type-C Charging Cable, 2x Silicone Ear Tips, 1x Manual" },
  { id: 158, name: "Audio > Portable Speakers > Bluetooth Speakers", slug: "speaker", weight: 0.75, l: 20, w: 10, h: 10, hazmat: "Battery", warranty_type: "Brand Warranty", warranty_period: "1 Year", box: "1x Portable Bluetooth Speaker, 1x Type-C Cable, 1x 3.5mm AUX Cable, 1x User Manual" },
  { id: 7849, name: "Computer Accessories > Mice > Optical & Wireless Mice", slug: "mouse", weight: 0.2, l: 14, w: 10, h: 5, hazmat: "None", warranty_type: "Brand Warranty", warranty_period: "1 Year", box: "1x Optical Mouse, 1x USB Nano Receiver, 1x AA Battery, 1x User Manual" },
  { id: 7847, name: "Computer Accessories > Keyboards > Mechanical & Gaming", slug: "keyboard", weight: 1.1, l: 46, w: 16, h: 5, hazmat: "None", warranty_type: "Brand Warranty", warranty_period: "1 Year", box: "1x Keyboard, 1x Keycap Puller, 1x Detachable USB Cable, 1x User Manual" },
  { id: 7852, name: "Computer Accessories > Mouse Pads", slug: "mousepad", weight: 0.35, l: 32, w: 26, h: 3, hazmat: "None", warranty_type: "No Warranty", warranty_period: "No Warranty", box: "1x Precision Gaming Mouse Pad" },
  { id: 7845, name: "Computer Accessories > Webcams", slug: "webcam", weight: 0.3, l: 15, w: 11, h: 6, hazmat: "None", warranty_type: "Brand Warranty", warranty_period: "1 Year", box: "1x Full HD Webcam with Microphone, 1x Privacy Cover, 1x User Manual" },
  { id: 114, name: "Computer Components > Storage > Internal SSDs", slug: "ssd", weight: 0.12, l: 14, w: 10, h: 2, hazmat: "None", warranty_type: "Brand Warranty", warranty_period: "3 Years", box: "1x Internal Solid State Drive (SSD), 1x Quick Start Guide" },
  { id: 113, name: "Computer Components > Desktop RAM / Memory", slug: "ram", weight: 0.1, l: 16, w: 6, h: 2, hazmat: "None", warranty_type: "Brand Warranty", warranty_period: "Life Time", box: "1x High Performance RAM Module, 1x User Guide" },
  { id: 109, name: "Computers & Laptops > Monitors", slug: "monitor", weight: 4.8, l: 62, w: 42, h: 14, hazmat: "None", warranty_type: "Brand Warranty", warranty_period: "3 Years", box: "1x Monitor Panel, 1x Base Stand, 1x HDMI Cable, 1x Power Adapter, 1x User Guide" },
  { id: 7841, name: "Computers & Laptops > Laptops", slug: "laptop", weight: 2.8, l: 45, w: 32, h: 7, hazmat: "Battery", warranty_type: "Brand Warranty", warranty_period: "2 Years", box: "1x Laptop, 1x Power Adapter & Cord, 1x User Manual, 1x Warranty Booklet" },
  { id: 111, name: "Computer Components > Cooling Fans & Heatsinks", slug: "cooling", weight: 0.45, l: 15, w: 14, h: 8, hazmat: "None", warranty_type: "Brand Warranty", warranty_period: "1 Year", box: "1x CPU Cooler / Casing Fan, 1x Mounting Brackets, 1x Thermal Paste, 1x Screws" },
  { id: 110, name: "Computer Components > PC Casing", slug: "casing", weight: 6.5, l: 50, w: 26, h: 50, hazmat: "None", warranty_type: "No Warranty", warranty_period: "No Warranty", box: "1x ATX PC Gaming Casing, 1x Accessories & Screws Bag, 1x User Manual" },
  { id: 112, name: "Computer Components > Power Supplies (PSU)", slug: "psu", weight: 2.2, l: 24, w: 20, h: 11, hazmat: "None", warranty_type: "Brand Warranty", warranty_period: "3 Years", box: "1x Power Supply Unit, 1x AC Power Cable, 1x Screws Pack, 1x User Manual" },
  { id: 10002870, name: "Mobiles & Tablets > Mobile Accessories > Car Chargers", slug: "carcharger", weight: 0.15, l: 12, w: 8, h: 4, hazmat: "None", warranty_type: "Brand Warranty", warranty_period: "6 Months", box: "1x Dual USB Fast Car Charger, 1x User Manual" },
  { id: 10002875, name: "Mobiles & Tablets > Mobile Accessories > Wall Chargers", slug: "charger", weight: 0.15, l: 12, w: 8, h: 4, hazmat: "None", warranty_type: "Brand Warranty", warranty_period: "6 Months", box: "1x Wall Charger Adapter, 1x User Manual" },
  { id: 9562, name: "Mobiles & Tablets > Mobile Accessories > Power Banks", slug: "powerbank", weight: 0.45, l: 16, w: 10, h: 4, hazmat: "Battery", warranty_type: "Brand Warranty", warranty_period: "6 Months", box: "1x Fast Charging Power Bank, 1x USB Cable, 1x User Manual" },
  { id: 9537, name: "Mobiles & Tablets > Mobile Accessories > Cables & Converters", slug: "cable", weight: 0.1, l: 15, w: 10, h: 3, hazmat: "None", warranty_type: "Seller Warranty", warranty_period: "3 Months", box: "1x High-Speed Data / Charging Cable" }
];

function detectCategory(product: any): number {
  if (product.primary_category && Number(product.primary_category)) {
    return Number(product.primary_category);
  }
  const text = `${product.name || ''} ${product.category_hint || ''} ${product.url || ''}`.toLowerCase();
  if (text.includes('router') || text.includes('wi-fi') || text.includes('wifi') || text.includes('access point')) return 128;
  if (text.includes('smart watch') || text.includes('smartwatch') || text.includes('ঘড়ি') || text.includes('ঘড়ি')) return 7537;
  if (text.includes('fitness band') || text.includes('smart band')) return 7536;
  if (text.includes('mouse pad') || text.includes('mousepad')) return 7852;
  if (text.includes('mouse') || text.includes('মাউস')) return 7849;
  if (text.includes('keyboard') || text.includes('কীবোর্ড')) return 7847;
  if (text.includes('earphone') || text.includes('headphone') || text.includes('earbuds') || text.includes('headset') || text.includes('ইয়ারফোন') || text.includes('tws')) return 157;
  if (text.includes('cooling fan') || text.includes('case fan') || text.includes('cooler') || text.includes('heatsink')) return 111;
  if (text.includes('casing') || text.includes('case')) return 110;
  if (text.includes('ram') || text.includes('memory')) return 113;
  if (text.includes('ssd') || text.includes('hard drive') || text.includes('storage')) return 114;
  if (text.includes('power supply') || text.includes('psu')) return 112;
  if (text.includes('monitor')) return 109;
  if (text.includes('speaker')) return 158;
  if (text.includes('webcam') || text.includes('camera')) return 7845;
  if (text.includes('car charger') || text.includes('car-charger')) return 10002870;
  if (text.includes('power bank') || text.includes('powerbank')) return 9562;
  if (text.includes('charger') || text.includes('adapter')) return 10002875;
  if (text.includes('cable') || text.includes('hdmi') || text.includes('type-c') || text.includes('type c')) return 9537;
  if (text.includes('laptop') || text.includes('notebook')) return 7841;
  return 128;
}

export function optimizeProductForDaraz(p: any): any {
  if (!p) return p;

  // 1. Detect Category & Presets
  const catId = detectCategory(p);
  p.primary_category = catId;
  const catPreset = DARAZ_CATEGORIES.find(c => c.id === catId);
  if (catPreset) {
    p.category_hint = catPreset.name;
  }

  // 2. Brand & Model
  if (!p.brand || p.brand === 'Unknown Product') {
    p.brand = p.specs?.['Brand'] || (p.name ? p.name.split(' ')[0] : 'No Brand');
  }
  if (!p.model) {
    p.model = p.specs?.['Model'] || p.specs?.['Part No'] || '';
    if (!p.model && p.name) {
      const match = p.name.match(/#[A-Za-z0-9-]+|([A-Z0-9]{3,}-[A-Z0-9]+)|([A-Z]+[0-9]{2,})/);
      if (match) p.model = match[0].replace(/^#/, '');
    }
  }

  // 3. Daraz SEO Title
  const brandPart = (p.brand && p.brand !== 'No Brand') ? p.brand : '';
  const modelPart = p.model || '';
  const typePart = catPreset?.name?.split('>').pop()?.trim() || p.category_hint || 'Electronics';

  let featureNote = '';
  if (p.specs?.['Connectivity Mode'] || p.specs?.['Connectivity']) {
    featureNote = p.specs?.['Connectivity Mode'] || p.specs?.['Connectivity'];
  } else if (p.specs?.['Screen/Display Size.']) {
    featureNote = `${p.specs['Screen/Display Size.']} Display`;
  } else if (p.specs?.['Interface(s)']) {
    featureNote = p.specs['Interface(s)'];
  }

  const currentTitle = p.name || '';
  if (!currentTitle || currentTitle.length < 25 || !currentTitle.toLowerCase().includes(p.brand?.toLowerCase() || '')) {
    const parts = [brandPart, modelPart, typePart, featureNote].filter(Boolean);
    p.name = parts.join(' ');
  }
  if (p.name && p.name.length > 150) {
    p.name = p.name.substring(0, 147) + '...';
  }

  // 4. Bengali Title
  if (!p.name_bn || !p.bengali_name) {
    p.name_bn = generateBengaliTitle(p.name || '');
    p.bengali_name = p.name_bn;
  }

  // 5. Highlights (Daraz short_description_en: 4-6 clean bullet points)
  const cleanHighlights: string[] = [];
  if (p.specs && typeof p.specs === 'object' && Object.keys(p.specs).length > 0) {
    const priorityKeys = [
      'Model', 'Screen/Display Size.', 'Display Type.', 'Battery.', 'Connectivity Mode',
      'Calling Feature', 'Water Resistant', 'Antenna', 'Speed', 'Interface(s)',
      'Sensor', 'DPI', 'Switch Type', 'Warranty', 'Capacity'
    ];
    for (const k of priorityKeys) {
      if (p.specs[k] && p.specs[k] !== 'Unmentioned') {
        cleanHighlights.push(`${k}: ${p.specs[k]}`);
      }
    }
    for (const [k, v] of Object.entries(p.specs)) {
      if (cleanHighlights.length >= 6) break;
      if (!priorityKeys.includes(k) && typeof v === 'string' && v.length < 60 && v !== 'Unmentioned') {
        cleanHighlights.push(`${k}: ${v}`);
      }
    }
  }
  if (cleanHighlights.length < 3 && Array.isArray(p.highlights) && p.highlights.length > 0) {
    cleanHighlights.push(...p.highlights.slice(0, 6));
  }
  if (cleanHighlights.length < 3) {
    cleanHighlights.push(`High Performance ${typePart}`);
    cleanHighlights.push(`Authentic & Official ${brandPart || 'Genuine Product'}`);
    cleanHighlights.push('Fast Dispatch & Secure Delivery across Bangladesh');
  }
  p.highlights = cleanHighlights.slice(0, 8);

  // 6. Rich Description (HTML with feature breakdown and specs table)
  let richHtml = '';
  if (p.description && p.description.includes('<')) {
    richHtml = p.description;
  } else {
    const rawText = p.description || p.name || 'Quality product with outstanding reliability.';
    richHtml = `<p><strong>${escapeXml(p.name)}</strong></p><p>${escapeXml(rawText).replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br/>')}</p>`;
  }
  if (p.specs && Object.keys(p.specs).length > 0 && !richHtml.includes('<table')) {
    let tableHtml = '<br/><h4>Technical Specifications</h4><table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px;border-color:#e2e8f0;">';
    for (const [k, v] of Object.entries(p.specs)) {
      if (typeof v === 'string' && v.length < 150) {
        tableHtml += `<tr><td style="background:#f8fafc;font-weight:600;width:35%;">${escapeXml(k)}</td><td>${escapeXml(v)}</td></tr>`;
      }
    }
    tableHtml += '</table>';
    richHtml += tableHtml;
  }
  p.description = richHtml;

  // 7. Package Dimensions & Weight
  if (!p.package_length || !p.package_width || !p.package_height) {
    p.package_length = catPreset?.l || 15;
    p.package_width = catPreset?.w || 12;
    p.package_height = catPreset?.h || 6;
  }
  p.dimensions = `${p.package_length}x${p.package_width}x${p.package_height}`;

  if (!p.package_weight || parseFloat(String(p.package_weight)) <= 0) {
    p.package_weight = catPreset?.weight || 0.45;
  }
  p.weight = String(p.package_weight);

  // 8. Box Content
  if (!p.box_content || p.box_content === 'Product, User Manual' || p.box_content.length < 10) {
    p.box_content = catPreset?.box || `1x ${p.name || 'Product'}, 1x Connection Cable, 1x User Manual, 1x Warranty Card`;
  }

  // 9. Hazmat / Dangerous Goods
  const textCheck = `${p.name || ''} ${JSON.stringify(p.specs || {})}`.toLowerCase();
  const hasBattery = /battery|mah|rechargeable|bluetooth|smartwatch|watch|earbuds|earphone|headset|power\s*bank/i.test(textCheck);
  p.hazmat = hasBattery ? 'Battery' : (catPreset?.hazmat || 'None');

  // 10. Warranty
  const rawW = String(p.warranty || p.specs?.['Warranty'] || '');
  if (/no warranty/i.test(rawW) || !rawW) {
    p.warranty_type = catPreset?.warranty_type || 'Brand Warranty';
    p.warranty_period = catPreset?.warranty_period || '1 Year';
  } else {
    p.warranty_type = /seller/i.test(rawW) ? 'Seller Warranty' : 'Brand Warranty';
    if (/lifetime|life\s*time/i.test(rawW)) p.warranty_period = 'Life Time';
    else if (/3\s*year/i.test(rawW)) p.warranty_period = '3 Years';
    else if (/2\s*year/i.test(rawW)) p.warranty_period = '2 Years';
    else if (/1\s*year/i.test(rawW)) p.warranty_period = '1 Year';
    else if (/6\s*month/i.test(rawW)) p.warranty_period = '6 Months';
    else if (/3\s*month/i.test(rawW)) p.warranty_period = '3 Months';
    else if (/1\s*month/i.test(rawW)) p.warranty_period = '1 Month';
    else p.warranty_period = '1 Year';
  }
  p.warranty = p.warranty_period;
  p.warranty_policy = p.warranty_policy || 'Covers manufacturing and functional defects. Warranty must be claimed with original packaging and invoice.';

  // 11. Color Family
  if (!p.color_family) {
    const rawColor = p.specs?.['Color'] || p.specs?.['Band Color'] || '';
    if (/white/i.test(rawColor || textCheck)) p.color_family = 'White';
    else if (/blue/i.test(rawColor || textCheck)) p.color_family = 'Blue';
    else if (/red/i.test(rawColor || textCheck)) p.color_family = 'Red';
    else if (/silver/i.test(rawColor || textCheck)) p.color_family = 'Silver';
    else if (/grey|gray/i.test(rawColor || textCheck)) p.color_family = 'Grey';
    else if (/gold/i.test(rawColor || textCheck)) p.color_family = 'Gold';
    else if (/pink/i.test(rawColor || textCheck)) p.color_family = 'Pink';
    else if (/green/i.test(rawColor || textCheck)) p.color_family = 'Green';
    else p.color_family = 'Black';
  }

  // 12. Connectivity Type
  if (!p.connectivity_type) {
    p.connectivity_type = /bluetooth/i.test(textCheck) ? 'Bluetooth' :
      (/wireless|2\.4g/i.test(textCheck) ? 'Wireless (2.4GHz)' :
      (/wifi|wi-fi/i.test(textCheck) ? 'Dual Band Wi-Fi' : 'Wired'));
  }

  // Smartwatch / Wearable (Cat 7537): sim_support, sim_slots, strap_material
  if (p.primary_category === 7537 || /watch|band|wearable/i.test(p.name || '')) {
    if (!p.sim_support) {
      const specSim = p.specs?.['Sim Card Slot'] || p.specs?.['SIM Card Type'] || p.specs?.['Cellular Network'];
      p.sim_support = (specSim && !/no/i.test(String(specSim))) ? 'Yes' : 'No';
    }
    if (!p.sim_slots) {
      p.sim_slots = p.sim_support === 'Yes' ? '1' : 'N/A';
    }
    if (!p.strap_material) {
      const strap = String(p.specs?.['Strap/Band Materials'] || p.specs?.['Strap Material'] || '').toLowerCase();
      if (strap.includes('leather')) p.strap_material = 'Leather';
      else if (strap.includes('metal') || strap.includes('steel')) p.strap_material = 'Metal';
      else if (strap.includes('fabric')) p.strap_material = 'Fabric';
      else if (strap.includes('tpu')) p.strap_material = 'TPU';
      else p.strap_material = 'Silicon';
    }
  }

  // Powerbank (Cat 9562): powerbank_capacity
  if (p.primary_category === 9562 || /power\s*bank/i.test(p.name || '')) {
    if (!p.powerbank_capacity) {
      const capMatch = ((p.name || '') + ' ' + (p.description || '')).match(/(\d{4,5})\s*mah/i);
      if (capMatch) {
        const mah = parseInt(capMatch[1], 10);
        if (mah <= 5000) p.powerbank_capacity = '1000-5000mAh';
        else if (mah <= 10000) p.powerbank_capacity = '10000 mAh';
        else if (mah <= 15000) p.powerbank_capacity = '10001-15000mAh';
        else if (mah <= 20000) p.powerbank_capacity = '20000 mAh';
        else p.powerbank_capacity = '20001+ mAh';
      } else {
        p.powerbank_capacity = '10000 mAh';
      }
    }
  }

  // 13. Pricing & SKU
  p.seller_sku = p.seller_sku || p.supplier_sku || `SKU-${Date.now().toString().slice(-6)}`;
  p.stock_quantity = (p.stock_quantity !== undefined && p.stock_quantity >= 0) ? p.stock_quantity : (p.in_stock === false ? 0 : 15);

  const basePrice = Number(p.sell_price || p.price_special || p.price_regular || (p.cost_price ? Math.round(p.cost_price * 1.15) : 1000));
  if (!p.price_regular || Number(p.price_regular) <= 0) {
    p.price_regular = Math.round(basePrice * 1.15);
  }
  p.price_special = basePrice;
  p.sell_price = basePrice;

  // 14. Daraz Estimated Fees & Net Profit
  const darazFee = Math.round(basePrice * 0.08);
  const paymentFee = Math.round(basePrice * 0.015);
  const vatOnFee = Math.round((darazFee + paymentFee) * 0.15);
  const totalDeductions = darazFee + paymentFee + vatOnFee;
  const netPayout = basePrice - totalDeductions;
  const cost = Number(p.cost_price) || 0;
  const netProfit = cost > 0 ? (netPayout - cost) : Math.round(netPayout * 0.15);
  p.daraz_fees = {
    commission: darazFee,
    payment_fee: paymentFee,
    vat: vatOnFee,
    total_deductions: totalDeductions,
    net_payout: netPayout,
    net_profit: Math.round(netProfit),
    margin_percent: Math.round((netProfit / basePrice) * 100)
  };

  // 15. Score Recalculation
  const scoreObj = calculateContentScore(p);
  p.content_score = scoreObj.score;
  p.content_rating = scoreObj.rating;
  p.content_checks = scoreObj.checks;

  return p;
}


const categoryAttributesCache = new Map<string, any[]>();

class DarazClient {
  private baseUrl = 'https://api.daraz.com.bd/rest';
  private appKey: string;
  private secret: string;
  private accessToken?: string;

  async getCategoryAttributes(primaryCategoryId: number | string): Promise<any[]> {
    const catIdStr = String(primaryCategoryId);
    if (categoryAttributesCache.has(catIdStr)) {
      return categoryAttributesCache.get(catIdStr)!;
    }
    try {
      const res = await this.request('GET', '/category/attributes/get', { primary_category_id: catIdStr });
      const attrs = res?.data || [];
      if (Array.isArray(attrs) && attrs.length > 0) {
        categoryAttributesCache.set(catIdStr, attrs);
      }
      return attrs;
    } catch {
      return [];
    }
  }

  constructor(
    appKey: string,
    secret: string,
    accessToken?: string
  ) {
    this.appKey = (appKey || '').trim();
    this.secret = (secret || '').trim();
    this.accessToken = accessToken ? accessToken.trim() : undefined;
  }

  private sign(apiPath: string, params: Record<string, any>): string {
    const filtered: Record<string, any> = {};
    for (const [k, v] of Object.entries(params)) {
      if (k !== 'sign' && v !== undefined && v !== null && typeof v !== 'object') {
        filtered[k] = String(v);
      }
    }
    const sortedKeys = Object.keys(filtered).sort();
    let signStr = apiPath;
    for (const k of sortedKeys) {
      signStr += `${k}${filtered[k]}`;
    }
    return crypto.createHmac('sha256', this.secret).update(signStr, 'utf8').digest('hex').toUpperCase();
  }

  async request(method: 'GET' | 'POST', apiPath: string, params: Record<string, any> = {}): Promise<any> {
    if (!this.appKey || !this.secret) {
      throw new Error('Missing app_key or secret');
    }
    const payload: Record<string, any> = {
      ...params,
      app_key: this.appKey,
      timestamp: Date.now().toString(),
      sign_method: 'sha256'
    };
    if (this.accessToken) {
      payload.access_token = this.accessToken;
    }
    payload.sign = this.sign(apiPath, payload);

    const url = `${this.baseUrl}${apiPath}`;
    try {
      if (method === 'GET') {
        const res = await axios.get(url, { params: payload, timeout: 30000 });
        return res.data;
      } else {
        const res = await axios.post(url, null, { params: payload, timeout: 30000 });
        return res.data;
      }
    } catch (err: any) {
      return { error: err.message, code: 'HTTP_ERROR' };
    }
  }

  async uploadImage(filePath: string): Promise<string> {
    if (!fs.existsSync(filePath)) return '';
    try {
      const buffer = fs.readFileSync(filePath);
      const form = new FormData();
      form.append('image', new Blob([buffer], { type: 'image/jpeg' }), path.basename(filePath));

      const params: Record<string, any> = {
        app_key: this.appKey,
        timestamp: Date.now().toString(),
        sign_method: 'sha256',
        access_token: this.accessToken
      };
      params.sign = this.sign('/image/upload', params);

      const res = await axios.post(`${this.baseUrl}/image/upload`, form, {
        params,
        timeout: 30000
      });
      return res.data?.data?.image?.url || '';
    } catch (err: any) {
      console.warn('Upload image to Daraz failed:', err?.message);
      return '';
    }
  }

  async ensureDarazImageUrl(imgUrl: string, origUrl?: string): Promise<string> {
    if (!imgUrl) return '';

    const isCleanJpgOrPng = (u: string) => {
      const c = u.split('?')[0].toLowerCase();
      return c.endsWith('.jpg') || c.endsWith('.jpeg') || c.endsWith('.png');
    };

    if (imgUrl.includes('static-01.daraz.com.bd') || imgUrl.includes('alicdn.com') || imgUrl.includes('slatic.net')) {
      if (isCleanJpgOrPng(imgUrl)) return imgUrl;
    }

    let localPath = '';
    if (imgUrl.startsWith('/static/uploads/')) {
      localPath = path.join(UPLOADS_DIR, path.basename(imgUrl));
    }

    // If localPath doesn't exist on disk, attempt download & convert
    if (!localPath || !fs.existsSync(localPath)) {
      const targetUrl = (imgUrl.startsWith('http') ? imgUrl : (origUrl && origUrl.startsWith('http') ? origUrl : ''));
      if (targetUrl) {
        try {
          const hash = crypto.createHash('md5').update(targetUrl).digest('hex');
          const filename = `${hash}.jpg`;
          const candidatePath = path.join(UPLOADS_DIR, filename);
          if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).size > 0) {
            localPath = candidatePath;
          } else {
            const buf = await downloadImageBuffer(targetUrl);
            if (buf) {
              await sharp(buf).jpeg({ quality: 90 }).toFile(candidatePath);
              localPath = candidatePath;
            }
          }
        } catch (e: any) {
          console.warn('Could not cache external image for Daraz:', e?.message);
        }
      }
    }

    if (localPath && fs.existsSync(localPath)) {
      try {
        const darazUrl = await this.uploadImage(localPath);
        if (darazUrl && darazUrl.startsWith('http')) return darazUrl;
      } catch (err: any) {
        console.warn('Daraz uploadImage failed:', err?.message);
      }
    }

    // Only return if it is strictly JPG or PNG - NEVER send .webp to Daraz
    if ((imgUrl.startsWith('http://') || imgUrl.startsWith('https://')) && isCleanJpgOrPng(imgUrl)) {
      return imgUrl;
    }
    if (origUrl && (origUrl.startsWith('http://') || origUrl.startsWith('https://')) && isCleanJpgOrPng(origUrl)) {
      return origUrl;
    }
    return '';
  }

  async createProduct(product: any, options: { primaryCategory?: number | string } = {}): Promise<any> {
    const primaryCat = Number(options.primaryCategory) || detectCategory(product);
    const sellerSku = product.supplier_sku || product.seller_sku || `SKU-${Date.now().toString().slice(-6)}`;
    const regularPrice = Number(product.price_regular || product.sell_price || (product.cost_price ? product.cost_price * 1.15 : 500)) || 500;
    const specialPrice = Number(product.price_special || product.sell_price || regularPrice);
    const qty = product.in_stock === false
      ? 0
      : (product.stock_quantity !== null && product.stock_quantity !== undefined && product.stock_quantity !== ''
        ? Number(product.stock_quantity)
        : 10);

    const isCleanJpgOrPng = (u: string) => {
      const c = u.split('?')[0].toLowerCase();
      return c.endsWith('.jpg') || c.endsWith('.jpeg') || c.endsWith('.png') || u.includes('static-01.daraz.com.bd') || u.includes('alicdn.com');
    };

    const rawImages = Array.isArray(product.images) && product.images.length > 0 ? product.images : [];
    const origImages = Array.isArray(product.original_images) && product.original_images.length > 0 ? product.original_images : [];
    const darazImages: string[] = [];

    for (let i = 0; i < Math.min(rawImages.length, 8); i++) {
      const rawImg = rawImages[i];
      const origImg = origImages[i];
      const dUrl = await this.ensureDarazImageUrl(rawImg, origImg);
      if (dUrl && (dUrl.startsWith('http://') || dUrl.startsWith('https://')) && !dUrl.toLowerCase().includes('.webp')) {
        darazImages.push(dUrl);
      }
    }

    // If still empty, check original supplier images directly (excluding webp)
    if (darazImages.length === 0) {
      for (const orig of origImages) {
        if (typeof orig === 'string' && (orig.startsWith('http://') || orig.startsWith('https://')) && isCleanJpgOrPng(orig)) {
          darazImages.push(orig);
        }
      }
    }

    const titleEn = product.name || 'Daraz Product Listing';
    const brand = (product.brand && product.brand !== 'Unknown Product' && product.brand !== 'No Brand') ? product.brand : 'No Brand';
    const model = product.model || product.specs?.['Model'] || '';
    const desc = product.description ? `<p>${escapeXml(product.description).replace(/\n/g, '<br/>')}</p>` : `<p>${escapeXml(titleEn)}</p>`;
    const highlights = Array.isArray(product.highlights) && product.highlights.length > 0
      ? `<ul>${product.highlights.map((h: string) => `<li>${escapeXml(h)}</li>`).join('')}</ul>`
      : `<ul><li>${escapeXml(titleEn)}</li></ul>`;

    const dimStr = String(product.dimensions || '15x12x6');
    const dimParts = dimStr.split(/x|\*|\s+/).filter(Boolean);
    const pkgLength = String(product.package_length || dimParts[0] || '15');
    const pkgWidth = String(product.package_width || dimParts[1] || '12');
    const pkgHeight = String(product.package_height || dimParts[2] || '6');
    const pkgWeight = String(product.package_weight || product.weight || '0.5');
    const boxContent = product.box_content || 'Product, User Manual';
    const colorFamily = product.color_family || 'Black';

    let hazmatVal = 'None';
    const rawHazmat = String(product.hazmat || '');
    if (/battery/i.test(rawHazmat)) hazmatVal = 'Battery';
    else if (/flamm/i.test(rawHazmat)) hazmatVal = 'Flammable';
    else if (/liquid/i.test(rawHazmat)) hazmatVal = 'Liquid';
    else if (/magnet/i.test(rawHazmat)) hazmatVal = 'Magnet';

    let rawWType = product.warranty_type || 'No Warranty';
    let warrantyType = 'No Warranty';
    if (rawWType.toLowerCase().includes('seller')) {
      warrantyType = 'Seller Warranty';
    } else if (rawWType.toLowerCase().includes('brand')) {
      warrantyType = 'Brand Warranty';
    } else if (rawWType.toLowerCase().includes('international')) {
      warrantyType = 'International Manufacturer Warranty';
    } else if (rawWType.toLowerCase().includes('no')) {
      warrantyType = 'No Warranty';
    } else {
      warrantyType = rawWType;
    }

    let warrantyPeriod = product.warranty_period || product.warranty || '';
    if (warrantyType === 'No Warranty' || warrantyType.toLowerCase().includes('no warranty')) {
      warrantyPeriod = '';
    } else if (!warrantyPeriod || warrantyPeriod === 'No Warranty') {
      warrantyPeriod = '6 Months';
    }
    const warrantyPolicy = product.warranty_policy || '';

    let extraAttrs = '';
    if (model) {
      extraAttrs += `<model>${escapeXml(model)}</model>`;
    }
    if (warrantyPolicy) {
      extraAttrs += `<warranty_policy>${escapeXml(warrantyPolicy)}</warranty_policy>`;
    }
    if (product.video_url) {
      extraAttrs += `<video>${escapeXml(product.video_url)}</video>`;
    }

    // Always include package_content in Attributes as well as in Sku for categories requiring it in Attributes
    if (boxContent) {
      extraAttrs += `<package_content>${escapeXml(boxContent)}</package_content>`;
    }

    // Routers (128): antennas & connectivity_speed
    if (primaryCat === 128 || /router|mesh|access\s*point/i.test(titleEn)) {
      if (!extraAttrs.includes('<antennas>')) extraAttrs += '<antennas>4</antennas>';
      if (!extraAttrs.includes('<connectivity_speed>')) extraAttrs += '<connectivity_speed>5GHz</connectivity_speed>';
    }

    // Smartwatches / Wearable (7537): Daraz requires sim_support ("সিম সাপোর্ট"), sim_slots, wear_acc_strap_material
    if (primaryCat === 7537 || /watch|band|wearable/i.test(titleEn)) {
      const specSim = product.sim_support || product.specs?.['Sim Card Slot'] || product.specs?.['SIM Card Type'] || product.specs?.['Cellular Network'];
      const isSim = (specSim && !/no/i.test(String(specSim))) || (/sim|cellular|lte|4g/i.test(titleEn) && !/no\s*sim/i.test(titleEn));
      const simVal = isSim ? 'Yes' : 'No';
      extraAttrs += `<sim_support>${simVal}</sim_support>`;
      extraAttrs += `<sim_slots>${simVal === 'Yes' ? '1' : 'N/A'}</sim_slots>`;

      const strap = String(product.strap_material || product.specs?.['Strap/Band Materials'] || product.specs?.['Strap Material'] || '').toLowerCase();
      let sMat = 'Silicon';
      if (strap.includes('leather')) sMat = 'Leather';
      else if (strap.includes('metal') || strap.includes('steel')) sMat = 'Metal';
      else if (strap.includes('fabric') || strap.includes('nylon')) sMat = 'Fabric';
      else if (strap.includes('tpu')) sMat = 'TPU';
      extraAttrs += `<wear_acc_strap_material>${sMat}</wear_acc_strap_material>`;
    }

    // Powerbanks (9562): powerbank_capacity
    if (primaryCat === 9562 || /power\s*bank/i.test(titleEn)) {
      const capMatch = (titleEn + ' ' + (product.description || '')).match(/(\d{4,5})\s*mah/i);
      let cap = product.powerbank_capacity || '10000 mAh';
      if (!product.powerbank_capacity && capMatch) {
        const mah = parseInt(capMatch[1], 10);
        if (mah <= 5000) cap = '1000-5000mAh';
        else if (mah <= 10000) cap = '10000 mAh';
        else if (mah <= 15000) cap = '10001-15000mAh';
        else if (mah <= 20000) cap = '20000 mAh';
        else cap = '20001+ mAh';
      }
      extraAttrs += `<powerbank_capacity>${cap}</powerbank_capacity>`;
    }

    // Dynamic verification of any additional mandatory category attributes from Daraz API
    try {
      const catAttrs = await this.getCategoryAttributes(primaryCat);
      if (Array.isArray(catAttrs) && catAttrs.length > 0) {
        const standardFields = [
          'name', 'name_en', 'description', 'short_description', 'short_description_en',
          'brand', 'warranty_type', 'warranty', 'Hazmat', 'package_content',
          'package_length', 'package_width', 'package_height', 'package_weight',
          'SellerSku', 'price', 'color_family', 'quantity'
        ];
        for (const attr of catAttrs) {
          if (attr.is_mandatory && attr.name) {
            const attrName = attr.name;
            if (standardFields.includes(attrName) || extraAttrs.includes(`<${attrName}>`)) {
              continue;
            }

            let val = product[attrName] || product.specs?.[attrName] || product.specs?.[attr.label];
            if (!val && Array.isArray(attr.options) && attr.options.length > 0) {
              const optNames = attr.options.map((o: any) => o.name);
              val = optNames.find((n: string) => /^(No|N\/A|Not Specified|None|0|1)$/i.test(n)) || optNames[0];
            }
            if (val) {
              extraAttrs += `<${attrName}>${escapeXml(String(val))}</${attrName}>`;
            }
          }
        }
      }
    } catch (e: any) {
      console.warn('Daraz category attributes dynamic check notice:', e?.message);
    }

    const productImagesXml = darazImages.length > 0
      ? `<Images>${darazImages.map(img => `<Image>${escapeXml(img)}</Image>`).join('')}</Images>`
      : '';

    const todayStr = new Date().toISOString().slice(0, 10);
    const futureDate = new Date(Date.now() + 3 * 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const specialPriceTag = (specialPrice > 0 && specialPrice < regularPrice)
      ? `<special_price>${specialPrice}</special_price><special_from_date>${todayStr}</special_from_date><special_to_date>${futureDate}</special_to_date>`
      : '';

    const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<Request>
  <Product>
    <PrimaryCategory>${primaryCat}</PrimaryCategory>
    <SPUId></SPUId>
    <AssociatedSku></AssociatedSku>
    ${productImagesXml}
    <Attributes>
      <name>${escapeXml(titleEn)}</name>
      <name_en>${escapeXml(titleEn)}</name_en>
      <description><![CDATA[${desc}]]></description>
      <short_description_en><![CDATA[${highlights}]]></short_description_en>
      <brand>${escapeXml(brand)}</brand>
      <warranty_type>${escapeXml(warrantyType)}</warranty_type>
      ${warrantyPeriod ? `<warranty>${escapeXml(warrantyPeriod)}</warranty>` : ''}
      <Hazmat>${hazmatVal}</Hazmat>
      ${extraAttrs}
    </Attributes>
    <Skus>
      <Sku>
        <SellerSku>${escapeXml(sellerSku)}</SellerSku>
        <color_family>${escapeXml(colorFamily)}</color_family>
        <quantity>${qty}</quantity>
        <price>${regularPrice}</price>
        ${specialPriceTag}
        <package_length>${pkgLength}</package_length>
        <package_height>${pkgHeight}</package_height>
        <package_weight>${pkgWeight}</package_weight>
        <package_width>${pkgWidth}</package_width>
        <package_content>${escapeXml(boxContent)}</package_content>
        ${productImagesXml}
      </Sku>
    </Skus>
  </Product>
</Request>`;

    return this.request('POST', '/product/create', { payload: xml });
  }

  async getOrders(createdAfter?: string): Promise<any> {
    const past = createdAfter || new Date(Date.now() - 90 * 86400000).toISOString();
    return this.request('GET', '/orders/get', { created_after: past });
  }

  async getProducts(filter = 'all', limit = 50, offset = 0): Promise<any> {
    return this.request('GET', '/products/get', { filter, limit, offset });
  }

  async updateStock(skuId: string, quantity: number): Promise<any> {
    const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<Request>
  <Product>
    <Skus>
      <Sku>
        <SkuId>${skuId}</SkuId>
        <Quantity>${quantity}</Quantity>
      </Sku>
    </Skus>
  </Product>
</Request>`;
    return this.request('POST', '/product/price_quantity/update', { payload: xml });
  }

  async getItem(itemId: string | number): Promise<any> {
    return this.request('GET', '/product/item/get', { item_id: String(itemId) });
  }

  async updatePriceQuantity(options: {
    sellerSku?: string;
    skuId?: string;
    itemId?: string | number;
    price?: number;
    specialPrice?: number;
    quantity?: number;
  }): Promise<any> {
    const skuXmlParts: string[] = [];
    if (options.itemId) {
      skuXmlParts.push(`<ItemId>${escapeXml(String(options.itemId))}</ItemId>`);
    }
    if (options.skuId) {
      skuXmlParts.push(`<SkuId>${escapeXml(String(options.skuId))}</SkuId>`);
    }
    if (options.sellerSku) {
      skuXmlParts.push(`<SellerSku>${escapeXml(options.sellerSku)}</SellerSku>`);
    }
    if (options.price !== undefined && options.price !== null && !isNaN(Number(options.price))) {
      skuXmlParts.push(`<Price>${Number(options.price)}</Price>`);
    }
    if (options.specialPrice !== undefined && options.specialPrice !== null && !isNaN(Number(options.specialPrice)) && Number(options.specialPrice) > 0) {
      const todayStr = new Date().toISOString().slice(0, 10);
      const futureDate = new Date(Date.now() + 3 * 365 * 86400000).toISOString().slice(0, 10);
      skuXmlParts.push(`<SalePrice>${Number(options.specialPrice)}</SalePrice>`);
      skuXmlParts.push(`<SaleStartDate>${todayStr}</SaleStartDate>`);
      skuXmlParts.push(`<SaleEndDate>${futureDate}</SaleEndDate>`);
    }
    if (options.quantity !== undefined && options.quantity !== null && !isNaN(Number(options.quantity))) {
      skuXmlParts.push(`<Quantity>${Number(options.quantity)}</Quantity>`);
    }

    const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<Request>
  <Product>
    <Skus>
      <Sku>
        ${skuXmlParts.join('\n        ')}
      </Sku>
    </Skus>
  </Product>
</Request>`;
    return this.request('POST', '/product/price_quantity/update', { payload: xml });
  }

  async createToken(code: string): Promise<any> {
    return this.request('POST', '/auth/token/create', { code });
  }
}

async function searchDaraz(query: string, sort = 'priceAsc'): Promise<Array<{ name: string; price: number; image: string }>> {
  const url = 'https://www.daraz.com.bd/catalog/';
  try {
    const res = await axios.get(url, {
      params: { ajax: 'true', q: query, sort },
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'application/json'
      },
      timeout: 30000
    });
    const items = res.data?.mods?.listItems || [];
    const results: Array<{ name: string; price: number; image: string }> = [];
    for (const item of items) {
      const name = item.name;
      const priceVal = item.price;
      const price = toNumber(priceVal);
      const image = item.image || item.imageUrl || '';
      if (name && price !== null) {
        results.push({ name, price, image });
      }
    }
    return results;
  } catch (err) {
    console.error('Search Daraz error:', err);
    return [];
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/static/uploads', express.static(UPLOADS_DIR));
app.use('/static', express.static(path.join(BASE, 'static')));
app.use(express.static(path.join(BASE, 'static')));
app.use('/src', express.static(path.join(process.cwd(), 'src')));

app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(BASE, 'static', 'index.html'));
});

async function getAuthenticatedUser(req: Request) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const session = await getSession(token);
  if (!session) return null;
  const user = await getUserById(session.userId);
  if (!user) return null;
  return {
    ...session,
    email: user.email,
    name: user.name,
    role: user.role
  };
}

async function getDarazConfigForRequest(req: Request): Promise<AppConfig> {
  const cfg = await getCfg();
  const user = await getAuthenticatedUser(req);
  const selectedStoreId = String(req.headers['x-daraz-store-id'] || '').trim();
  if (!user) return { ...cfg, daraz_access_token: '' };

  if (!selectedStoreId) {
    return user.role === 'admin' ? cfg : { ...cfg, daraz_access_token: '' };
  }
  if (selectedStoreId === 'legacy-config') {
    return user.role === 'admin' ? cfg : { ...cfg, daraz_access_token: '' };
  }

  const stores = user.role === 'admin'
    ? await getAllDarazStores()
    : await getDarazStores(user.userId);
  const store = stores.find(item =>
    item.id === selectedStoreId &&
    (user.role === 'admin' || item.ownerUserId === user.userId)
  );
  return { ...cfg, daraz_access_token: store?.accessToken || '' };
}

async function saveDarazTokenForUser(userId: string, tokenResponse: any): Promise<{ id: string; sellerId: string; name: string }> {
  const tokenData = tokenResponse?.data || tokenResponse;
  const accessToken = tokenData?.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error(String(tokenData?.message || tokenData?.error || tokenResponse?.message || 'Daraz did not return an access token.'));
  }
  const accountInfo = tokenData?.country_user_info?.[0] || tokenResponse?.country_user_info?.[0] || {};
  const sellerId = String(accountInfo.seller_id || tokenData?.seller_id || tokenResponse?.account || '').trim();
  const name = String(accountInfo.seller_name || accountInfo.name || tokenData?.account || tokenResponse?.account || sellerId || 'Daraz Store').trim();
  const stores = await getDarazStores(userId);
  const existing = sellerId ? stores.find(store => store.sellerId === sellerId) : undefined;
  const timestamp = new Date().toISOString();
  const record = {
    id: existing?.id || `store_${crypto.randomBytes(8).toString('hex')}`,
    ownerUserId: userId,
    sellerId: sellerId || `seller_${crypto.randomBytes(6).toString('hex')}`,
    name,
    accessToken,
    refreshToken: tokenData?.refresh_token || undefined,
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp
  };
  await saveDarazStore(record);
  return { id: record.id, sellerId: record.sellerId, name: record.name };
}

function createDarazOAuthState(userId: string, secret: string): string {
  const payload = Buffer.from(JSON.stringify({
    userId,
    issuedAt: Date.now(),
    nonce: crypto.randomBytes(16).toString('hex')
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyDarazOAuthState(state: string, secret: string): string | null {
  const [payload, providedSignature] = state.split('.');
  if (!payload || !providedSignature) return null;
  const expectedSignature = crypto.createHmac('sha256', secret).update(payload).digest();
  let decodedSignature: Buffer;
  try {
    decodedSignature = Buffer.from(providedSignature, 'base64url');
  } catch {
    return null;
  }
  if (decodedSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(decodedSignature, expectedSignature)) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.userId !== 'string' || Date.now() - Number(data.issuedAt) > 10 * 60 * 1000) return null;
    if (Date.now() < Number(data.issuedAt) || typeof data.nonce !== 'string') return null;
    return data.userId;
  } catch {
    return null;
  }
}

// --- AUTHENTICATION ROUTES ---
app.post('/api/auth/signup', async (req: Request, res: Response) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const cleanEmail = String(email).trim().toLowerCase();
  if (!cleanEmail.includes('@') || cleanEmail.length < 5) {
    return res.status(400).json({ error: 'Please provide a valid email address' });
  }

  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long' });
  }

  const existing = await getUserByEmail(cleanEmail);
  if (existing) {
    return res.status(400).json({ error: 'An account with this email already exists. Please log in.' });
  }

  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(password, salt);
  const userId = `usr_${crypto.randomBytes(8).toString('hex')}`;
  const userName = String(name || '').trim() || cleanEmail.split('@')[0];

  const user = await createUser({
    id: userId,
    email: cleanEmail,
    passwordHash,
    name: userName,
    role: 'seller',
    createdAt: new Date().toISOString()
  });

  const token = `sdt_${crypto.randomBytes(32).toString('hex')}`;
  await createSession(token, {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt
  });

  res.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    token,
    message: 'Account created successfully'
  });
});

app.post('/api/auth/login', async (req: Request, res: Response) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const cleanEmail = String(email).trim().toLowerCase();
  const user = await getUserByEmail(cleanEmail);
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = `sdt_${crypto.randomBytes(32).toString('hex')}`;
  await createSession(token, {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt
  });

  res.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    token,
    message: 'Logged in successfully'
  });
});

app.get('/api/auth/me', async (req: Request, res: Response) => {
  await ensureDefaultUser();
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  const usingRedis = isUsingRedis();

  if (!token) {
    return res.json({ user: null, isUsingRedis: usingRedis });
  }

  const session = await getSession(token);
  if (!session) {
    return res.json({ user: null, isUsingRedis: usingRedis });
  }

  res.json({ user: session, isUsingRedis: usingRedis });
});

app.post('/api/auth/logout', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (token) {
    await deleteSession(token);
  }
  res.json({ status: 'success', message: 'Logged out successfully' });
});

app.post('/api/auth/reset-password', async (req: Request, res: Response) => {
  const { email, name, newPassword } = req.body || {};
  if (!email || !newPassword) {
    return res.status(400).json({ error: 'Email and new password are required' });
  }

  const cleanEmail = String(email).trim().toLowerCase();
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters long' });
  }

  const user = await getUserByEmail(cleanEmail);
  if (!user) {
    return res.status(404).json({ error: 'No account found with this email address' });
  }

  // Name verification if provided
  if (name && typeof name === 'string' && name.trim()) {
    const inputName = name.trim().toLowerCase();
    const actualName = (user.name || '').trim().toLowerCase();
    const match = actualName === inputName ||
      actualName.includes(inputName) ||
      inputName.includes(actualName) ||
      user.email.split('@')[0].toLowerCase() === inputName;
    if (!match) {
      return res.status(400).json({
        error: 'Name verification failed: The name provided does not match the registered account holder.'
      });
    }
  }

  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(newPassword, salt);
  user.passwordHash = passwordHash;
  await updateUser(user);

  // Generate session so user is logged in immediately
  const token = `sdt_${crypto.randomBytes(32).toString('hex')}`;
  await createSession(token, {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt
  });

  res.json({
    success: true,
    message: 'Password reset successfully! You are now logged in.',
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    token
  });
});

app.post('/api/auth/forgot-email', async (req: Request, res: Response) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Please enter your registered full name or store name' });
  }

  const query = name.trim();
  if (query.length < 2) {
    return res.status(400).json({ error: 'Please enter at least 2 characters to search' });
  }

  const matches = await findUsersByName(query);
  if (matches.length === 0) {
    return res.json({
      found: false,
      message: `No registered account found matching "${query}". Please check your spelling or create a new account.`,
      matches: []
    });
  }

  res.json({
    found: true,
    count: matches.length,
    matches: matches.map(u => ({
      name: u.name,
      email: u.email,
      role: u.role,
      createdAt: u.createdAt
    }))
  });
});

app.get('/api/admin/users', async (req: Request, res: Response) => {
  const session = await getAuthenticatedUser(req);
  if (session?.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied: Admin only.' });
  }
  const users = await getAllUsers();
  res.json({
    users: users.map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      createdAt: u.createdAt
    }))
  });
});

app.post('/api/admin/users/role', async (req: Request, res: Response) => {
  const session = await getAuthenticatedUser(req);
  if (session?.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied: Admin only.' });
  }
  const { email, role } = req.body || {};
  if (!email || !['admin', 'seller'].includes(role)) {
    return res.status(400).json({ error: 'Valid email and role (admin or seller) are required.' });
  }
  const user = await getUserByEmail(String(email).trim().toLowerCase());
  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }
  user.role = role;
  await updateUser(user);
  res.json({ success: true, message: `Updated ${user.email} role to ${role}.`, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

app.post('/api/auth/change-password', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const session = await getSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }

  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters long' });
  }

  const user = await getUserByEmail(session.email);
  if (!user) {
    return res.status(404).json({ error: 'User account not found' });
  }

  if (currentPassword) {
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
  }

  const salt = await bcrypt.genSalt(10);
  user.passwordHash = await bcrypt.hash(newPassword, salt);
  await updateUser(user);

  res.json({ success: true, message: 'Password updated successfully!' });
});

// Helper to mask email address (e.g. rafidnoor7@gmail.com -> ra***7@gmail.com)
function maskEmail(email: string): string {
  const parts = email.split('@');
  if (parts.length !== 2) return email;
  const name = parts[0];
  const domain = parts[1];
  if (name.length <= 2) {
    return `${name[0]}***@${domain}`;
  }
  return `${name.slice(0, 2)}***${name.slice(-1)}@${domain}`;
}

// --- OTP (ONE-TIME PASSWORD) ENDPOINTS ---
app.post('/api/auth/otp/send', async (req: Request, res: Response) => {
  const { email, name, identifier, purpose } = req.body || {};
  const validPurposes = ['reset_password', 'forgot_email', 'login'];
  const reqPurpose = validPurposes.includes(purpose) ? purpose : 'reset_password';

  let targetUser: any = null;

  if (email && typeof email === 'string') {
    targetUser = await getUserByEmail(email.trim().toLowerCase());
  } else if (identifier && typeof identifier === 'string') {
    const cleanId = identifier.trim().toLowerCase();
    targetUser = await getUserByEmail(cleanId);
    if (!targetUser) {
      targetUser = await getUserById(cleanId);
    }
  }

  if (!targetUser && name && typeof name === 'string' && name.trim()) {
    const matches = await findUsersByName(name.trim());
    if (matches.length > 0) {
      targetUser = matches[0];
    }
  }

  if (!targetUser) {
    return res.status(404).json({
      error: 'No registered account found with the provided details. Please check spelling or create an account.'
    });
  }

  const { otp, expiresAt } = await createOtp(reqPurpose, targetUser.email);
  console.log(`[OTP] Generated 6-digit code: ${otp} for account ${targetUser.email} (purpose: ${reqPurpose}, expires: ${new Date(expiresAt).toISOString()})`);

  // Attempt real email dispatch via SMTP
  const emailResult = await sendOtpEmail({
    to: targetUser.email,
    name: targetUser.name,
    otp,
    purpose: reqPurpose
  });

  if (emailResult.sent) {
    return res.json({
      success: true,
      sentToEmail: true,
      message: `Verification code sent to your email (${maskEmail(targetUser.email)})!`,
      email: targetUser.email,
      maskedEmail: maskEmail(targetUser.email),
      name: targetUser.name,
      expiresInSeconds: 600
    });
  }

  // Fallback if SMTP not configured or failed
  const smtpConfigured = await isSmtpConfigured();
  return res.json({
    success: true,
    sentToEmail: false,
    smtpConfigured,
    smtpError: emailResult.error,
    message: smtpConfigured
      ? `Email delivery failed (${emailResult.error}). Showing code for development:`
      : `Email server (SMTP) is not configured yet. Showing code for development:`,
    notice: 'Real OTP emails require administrator SMTP server configuration.',
    email: targetUser.email,
    maskedEmail: maskEmail(targetUser.email),
    name: targetUser.name,
    otp, // Returned only for simulation / dev fallback
    expiresInSeconds: 600
  });
});

app.post('/api/auth/otp/verify-reset-password', async (req: Request, res: Response) => {
  const { email, otp, newPassword } = req.body || {};
  if (!email || !otp || !newPassword) {
    return res.status(400).json({ error: 'Email, verification code (OTP), and new password are required' });
  }

  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters long' });
  }

  const cleanEmail = String(email).trim().toLowerCase();
  const verification = await verifyOtp('reset_password', cleanEmail, String(otp));
  if (!verification.valid) {
    return res.status(400).json({ error: verification.error || 'Invalid or expired verification code' });
  }

  const user = await getUserByEmail(cleanEmail);
  if (!user) {
    return res.status(404).json({ error: 'User account not found' });
  }

  const salt = await bcrypt.genSalt(10);
  user.passwordHash = await bcrypt.hash(newPassword, salt);
  await updateUser(user);

  // Automatically sign the user in with new session
  const token = `sdt_${crypto.randomBytes(32).toString('hex')}`;
  await createSession(token, {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt
  });

  res.json({
    success: true,
    message: 'Password successfully reset! You have been automatically signed in.',
    token,
    user: { id: user.id, email: user.email, name: user.name, role: user.role }
  });
});

app.post('/api/auth/otp/verify-forgot-email', async (req: Request, res: Response) => {
  const { identifier, otp } = req.body || {};
  if (!identifier || !otp) {
    return res.status(400).json({ error: 'Account identifier and verification code are required' });
  }

  const cleanId = String(identifier).trim().toLowerCase();
  let user = await getUserByEmail(cleanId);
  if (!user) {
    user = await getUserById(cleanId);
  }

  if (!user) {
    return res.status(404).json({ error: 'User account not found' });
  }

  const verification = await verifyOtp('forgot_email', user.email, String(otp));
  if (!verification.valid) {
    return res.status(400).json({ error: verification.error || 'Invalid or expired verification code' });
  }

  // Create session for optional instant 1-click login
  const token = `sdt_${crypto.randomBytes(32).toString('hex')}`;
  await createSession(token, {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt
  });

  res.json({
    success: true,
    message: 'Identity verified successfully!',
    email: user.email,
    name: user.name,
    role: user.role,
    token,
    user: { id: user.id, email: user.email, name: user.name, role: user.role }
  });
});

app.post('/api/auth/otp/login', async (req: Request, res: Response) => {
  const { email, otp } = req.body || {};
  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and verification code (OTP) are required' });
  }

  const cleanEmail = String(email).trim().toLowerCase();
  const user = await getUserByEmail(cleanEmail);
  if (!user) {
    return res.status(404).json({ error: 'No account found with this email address' });
  }

  const verification = await verifyOtp('login', cleanEmail, String(otp));
  if (!verification.valid) {
    return res.status(400).json({ error: verification.error || 'Invalid or expired verification code' });
  }

  const token = `sdt_${crypto.randomBytes(32).toString('hex')}`;
  await createSession(token, {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt
  });

  res.json({
    success: true,
    message: `Welcome back, ${user.name}!`,
    token,
    user: { id: user.id, email: user.email, name: user.name, role: user.role }
  });
});



app.post('/api/redis/test', async (req: Request, res: Response) => {
  const user = await getAuthenticatedUser(req);
  if (user?.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Only administrators can test shared database credentials.' });
  }
  const { url, token } = req.body || {};
  const result = await testRedisConnection(url, token);
  res.json(result);
});

app.get('/api/redis/status', async (_req: Request, res: Response) => {
  const active = isUsingRedis();
  let latencyMs: number | undefined;
  if (active) {
    const test = await testRedisConnection();
    latencyMs = test.latencyMs;
  }
  res.json({
    active,
    storageType: active ? 'Upstash Redis' : 'Local Storage',
    latencyMs
  });
});

app.get('/api/state', async (req: Request, res: Response) => {
  const db = await loadDb();
  const published = Object.values(db).filter((p: any) => p.status === 'published');
  const user = await getAuthenticatedUser(req);
  const isAdmin = user?.role === 'admin';
  const cfg = await getCfg();

  // Daraz tokens are never returned to the browser; app credentials are admin-only.
  const safeConfig: Record<string, any> = { ...cfg };
  delete safeConfig.daraz_access_token;
  if (!isAdmin) {
    delete safeConfig.daraz_app_key;
    delete safeConfig.daraz_secret;
    delete safeConfig.upstash_redis_rest_url;
    delete safeConfig.upstash_redis_rest_token;
    delete safeConfig.smtp_host;
    delete safeConfig.smtp_port;
    delete safeConfig.smtp_secure;
    delete safeConfig.smtp_user;
    delete safeConfig.smtp_pass;
    delete safeConfig.smtp_from;
  }

  res.json({
    config: safeConfig,
    products: published,
    isUsingRedis: isUsingRedis(),
    isSmtpConfigured: isAdmin ? await isSmtpConfigured() : false,
    isDarazConfigured: Boolean(cfg.daraz_app_key && cfg.daraz_secret),
    userRole: user?.role || null,
    isAdmin
  });
});

app.get('/api/drafts', async (_req: Request, res: Response) => {
  const db = await loadDb();
  const drafts = Object.values(db).filter((p: any) => p.status !== 'published');
  res.json({ products: drafts });
});

app.get('/api/product', async (req: Request, res: Response) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).json({ error: 'missing url' });
  const db = await loadDb();
  const p = db[url];
  if (!p) return res.status(404).json({ error: 'product not found' });
  res.json({ product: p });
});

app.get('/api/validate', async (req: Request, res: Response) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).json({ error: 'missing url' });
  const db = await loadDb();
  const p = db[url];
  if (!p) return res.status(404).json({ error: 'product not found in database' });
  const scoreObj = calculateContentScore(p);
  const val = validateProduct(p);
  res.json({
    ...val,
    score: scoreObj.score,
    rating: scoreObj.rating,
    checks: scoreObj.checks
  });
});

app.get('/api/daraz/categories', (_req: Request, res: Response) => {
  res.json({ categories: DARAZ_CATEGORIES });
});

app.get('/api/daraz/tree', async (req: Request, res: Response) => {
  const cfg = await getDarazConfigForRequest(req);
  if (!cfg.daraz_app_key || !cfg.daraz_secret || !cfg.daraz_access_token) {
    return res.status(400).json({ error: 'Daraz credentials not set' });
  }
  const client = new DarazClient(cfg.daraz_app_key, cfg.daraz_secret, cfg.daraz_access_token);
  const data = await client.request('GET', '/category/tree/get');
  res.json(data);
});

app.post('/api/daraz/optimize', async (req: Request, res: Response) => {
  const url = req.body?.url;
  const db = await loadDb();
  let p = url ? db[url] : req.body?.product;
  if (!p) return res.status(400).json({ error: 'Product not found' });

  p = optimizeProductForDaraz(p);
  if (url && db[url]) {
    db[url] = p;
    await saveDb(db);
  }
  res.json({ success: true, product: p, message: 'Product fully optimized for Daraz!' });
});

app.post('/api/daraz/optimize_all', async (_req: Request, res: Response) => {
  const db = await loadDb();
  let count = 0;
  for (const k in db) {
    if (db[k].status !== 'published') {
      db[k] = optimizeProductForDaraz(db[k]);
      count++;
    }
  }
  await saveDb(db);
  res.json({ success: true, count, message: `Successfully optimized ${count} drafts for Daraz!` });
});

app.post('/api/process_image', async (req: Request, res: Response) => {
  const url = req.body?.url;
  const targetFormat = (req.body?.format || 'jpg').toLowerCase() === 'png' ? 'png' : 'jpg';
  if (!url) return res.status(400).json({ error: 'missing url' });

  try {
    const cfg = await getCfg();
    const buffer = await downloadImageBuffer(url, cfg);

    if (buffer) {
      const ext = targetFormat === 'png' ? 'png' : 'jpg';
      const hash = crypto.createHash('md5').update(`${url}-${targetFormat}`).digest('hex');
      const filename = `${hash}.${ext}`;
      const filepath = path.join(UPLOADS_DIR, filename);

      const pipeline = sharp(buffer);
      if (ext === 'png') {
        await pipeline.png({ quality: 90 }).toFile(filepath);
      } else {
        await pipeline.jpeg({ quality: 90 }).toFile(filepath);
      }

      return res.json({ url: `/static/uploads/${filename}`, converted: true, format: ext });
    }
  } catch (err: any) {
    console.warn('Image processing warning:', err?.message || err);
  }

  return res.json({ url, converted: false });
});

app.post('/api/convert_image', async (req: Request, res: Response) => {
  const url = req.body?.url;
  const targetFormat = (req.body?.format || 'jpg').toLowerCase() === 'png' ? 'png' : 'jpg';
  if (!url) return res.status(400).json({ error: 'missing url' });

  try {
    const cfg = await getCfg();
    const buffer = await downloadImageBuffer(url, cfg);
    if (!buffer) {
      return res.status(400).json({ error: 'Failed to retrieve image data' });
    }

    const ext = targetFormat === 'png' ? 'png' : 'jpg';
    const hash = crypto.createHash('md5').update(`${url}-${targetFormat}-${Date.now()}`).digest('hex');
    const filename = `converted_${hash}.${ext}`;
    const filepath = path.join(UPLOADS_DIR, filename);

    const image = sharp(buffer);
    const metadata = await image.metadata();

    if (ext === 'png') {
      await image.png({ quality: 90 }).toFile(filepath);
    } else {
      await image.jpeg({ quality: 90 }).toFile(filepath);
    }

    const stats = fs.statSync(filepath);

    return res.json({
      url: `/static/uploads/${filename}`,
      filename,
      format: ext,
      width: metadata.width,
      height: metadata.height,
      originalFormat: metadata.format,
      size: stats.size,
      success: true
    });
  } catch (err: any) {
    return res.status(500).json({ error: `Image conversion failed: ${err.message}` });
  }
});

// Helper to fetch live Daraz product gallery images
async function fetchDarazProductImages(darazUrl?: string, itemId?: string | number): Promise<string[]> {
  try {
    let url = darazUrl;
    if (!url && itemId) {
      url = `https://www.daraz.com.bd/products/-i${itemId}.html`;
    }
    if (url) {
      const res = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        },
        timeout: 10000
      });
      const matches = [...String(res.data).matchAll(/https:\/\/static-01\.daraz\.com\.bd\/p\/[a-zA-Z0-9_-]+\.(?:jpg|png|webp|jpeg)/g)].map(m => m[0]);
      const unique = [...new Set(matches)];
      if (unique.length > 0) return unique;
    }
  } catch {
    // fallback to catalog query
  }

  if (itemId) {
    try {
      const res = await axios.get('https://www.daraz.com.bd/catalog/', {
        params: { ajax: 'true', q: String(itemId) },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        },
        timeout: 8000
      });
      const items = res.data?.mods?.listItems || [];
      const match = items.find((it: any) => String(it.itemId) === String(itemId)) || items[0];
      if (match?.image) {
        return [match.image];
      }
    } catch {}
  }
  return [];
}

app.get('/api/proxy_image', async (req: Request, res: Response) => {
  const imageUrl = (req.query.url || req.query.src) as string;
  if (!imageUrl) {
    return res.status(400).send('Missing url parameter');
  }

  try {
    let cleanUrl = String(imageUrl).trim();

    // 1. Handle local upload paths like /static/uploads/filename.jpg
    if (cleanUrl.startsWith('/static/uploads/') || cleanUrl.startsWith('static/uploads/')) {
      const filename = path.basename(cleanUrl);
      const localPath = path.join(UPLOADS_DIR, filename);
      if (fs.existsSync(localPath)) {
        res.setHeader('Content-Type', filename.endsWith('.png') ? 'image/png' : 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.sendFile(localPath);
      }

      // If missing locally, try to find product that owns it and heal from Daraz / Supplier
      const db = await loadDb();
      for (const p of Object.values(db)) {
        if (p.images && p.images.some((img: string) => img.includes(filename))) {
          if (p.daraz_url || p.daraz_item_id) {
            const darazImgs = await fetchDarazProductImages(p.daraz_url, p.daraz_item_id);
            if (darazImgs.length > 0) {
              cleanUrl = darazImgs[0];
              break;
            }
          }
          if (p.original_images && p.original_images.length > 0) {
            cleanUrl = p.original_images[0];
            break;
          }
        }
      }
    }

    if (cleanUrl.startsWith('//')) {
      cleanUrl = 'https:' + cleanUrl;
    } else if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
      cleanUrl = 'https://' + cleanUrl;
    }

    // Check local cache
    const hash = crypto.createHash('md5').update(cleanUrl).digest('hex');
    const localCachedPath = path.join(UPLOADS_DIR, `proxy_${hash}.jpg`);

    if (fs.existsSync(localCachedPath)) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.sendFile(localCachedPath);
    }

    const isDaraz = cleanUrl.includes('daraz.com.bd') || cleanUrl.includes('alicdn.com') || cleanUrl.includes('slatic.net') || cleanUrl.includes('lazcdn.com');

    let response: any = null;
    try {
      response = await axios.get(cleanUrl, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Referer': isDaraz ? 'https://www.daraz.com.bd/' : cleanUrl,
          'Origin': isDaraz ? 'https://www.daraz.com.bd' : undefined,
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
        },
        timeout: 15000
      });
    } catch {
      // If direct request failed and it's from Ryans, attempt with ZenRows if configured
      try {
        const cfg = await getCfg();
        const zenrowsApiKey = cfg?.zenrows_api_key || process.env.ZENROWS_API_KEY;
        if (zenrowsApiKey && cleanUrl.includes('ryans.com')) {
          const zUrl = `https://api.zenrows.com/v1/?apikey=${zenrowsApiKey}&url=${encodeURIComponent(cleanUrl)}&antibot=true`;
          response = await axios.get(zUrl, { responseType: 'arraybuffer', timeout: 25000 });
        }
      } catch {}

      if (!response) {
        // Retry with minimal headers
        response = await axios.get(cleanUrl, {
          responseType: 'arraybuffer',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
          },
          timeout: 15000
        });
      }
    }

    let outBuffer = Buffer.from(response.data);
    let contentType = String(response.headers?.['content-type'] || 'image/jpeg');

    // If image is WebP, convert to standard JPEG for Daraz / frontend compatibility
    if (contentType.includes('webp') || cleanUrl.toLowerCase().includes('.webp')) {
      try {
        outBuffer = await sharp(outBuffer).jpeg({ quality: 90 }).toBuffer();
        contentType = 'image/jpeg';
      } catch (err: any) {
        console.warn('WebP proxy conversion warning:', err?.message || err);
      }
    }

    // Cache locally for fast subsequent loads in SupplierDesk
    try {
      fs.writeFileSync(localCachedPath, outBuffer);
    } catch {
      // non-fatal cache write
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(outBuffer);
  } catch {
    // Return a clean SVG placeholder image if external link is completely dead
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(`
      <svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200" fill="#0f172a">
        <rect width="200" height="200" rx="8" fill="#1e293b"/>
        <path d="M60 125 L90 85 L115 115 L135 95 L155 125 Z" fill="#475569"/>
        <circle cx="80" cy="75" r="9" fill="#64748b"/>
        <text x="100" y="155" font-family="sans-serif" font-size="12" fill="#94a3b8" text-anchor="middle">Daraz / Supplier Image</text>
      </svg>
    `.trim());
  }
});

app.post('/api/update_product', async (req: Request, res: Response) => {
  const body = req.body || {};
  const url = body.url;
  if (!url) return res.status(400).json({ error: 'missing url' });

  const db = await loadDb();
  const p = db[url];
  if (!p) return res.status(404).json({ error: 'product not found' });

  const fields = [
    'name', 'bengali_name', 'name_bn', 'brand', 'model',
    'primary_category', 'category_hint', 'seller_sku', 'supplier_sku',
    'cost_price', 'price_regular', 'price_special', 'sell_price', 'sell_override',
    'stock_quantity', 'in_stock', 'availability',
    'color_family', 'connectivity_type',
    'box_content', 'description', 'highlights', 'images', 'original_images',
    'weight', 'package_weight', 'dimensions', 'package_length', 'package_width', 'package_height',
    'warranty', 'warranty_type', 'warranty_period', 'warranty_policy',
    'hazmat', 'dangerous_goods', 'video_url', 'promo_image',
    'status', 'specs', 'daraz_fees',
    'daraz_url', 'daraz_item_id', 'daraz_sku', 'daraz_sku_id', 'daraz_synced', 'daraz_status',
    'supplier_url', 'views', 'sold',
    'sim_support', 'sim_slots', 'strap_material', 'powerbank_capacity'
  ];

  for (const field of fields) {
    if (field in body && body[field] !== undefined) {
      p[field] = body[field];
    }
  }

  if (p.daraz_url && typeof p.daraz_url === 'string') {
    const itemMatch = p.daraz_url.match(/-?i(\d+)/i);
    if (itemMatch && !p.daraz_item_id) {
      p.daraz_item_id = Number(itemMatch[1]) || itemMatch[1];
    }
    if (p.daraz_item_id) {
      p.daraz_synced = true;
    }
  }

  // Sync dimensions string and parts
  if (p.package_length && p.package_width && p.package_height) {
    p.dimensions = `${p.package_length}x${p.package_width}x${p.package_height}`;
  } else if (p.dimensions) {
    const parts = String(p.dimensions).split(/x|\*|\s+/i).map(n => parseFloat(n)).filter(n => !isNaN(n));
    if (parts[0]) p.package_length = parts[0];
    if (parts[1]) p.package_width = parts[1];
    if (parts[2]) p.package_height = parts[2];
  }
  if (p.weight) {
    p.package_weight = parseFloat(p.weight) || p.package_weight || 0.5;
  }
  if (p.bengali_name) p.name_bn = p.bengali_name;
  if (p.name_bn) p.bengali_name = p.name_bn;
  if (p.warranty_period) p.warranty = p.warranty_period;

  if (body.views !== undefined) {
    p.views = Math.max(0, Number(body.views) || 0);
    p.views_synced = false;
    delete p.views_synced_at;
  }
  if (body.sold !== undefined) {
    p.sold = Math.max(0, Number(body.sold) || 0);
  }

  // Recalculate score
  const scoreObj = calculateContentScore(p);
  p.content_score = scoreObj.score;
  p.content_rating = scoreObj.rating;
  p.content_checks = scoreObj.checks;

  // Live Daraz Price & Quantity Sync if credentials configured and product is listed on Daraz
  let darazSyncResult: any = null;
  const cfg = await getDarazConfigForRequest(req);
  const hasPriceUpdate = body.price_regular !== undefined || body.price_special !== undefined || body.sell_price !== undefined || body.stock_quantity !== undefined;

  if (hasPriceUpdate && (p.status === 'published' || p.daraz_item_id || p.daraz_sku_id) && cfg.daraz_app_key && cfg.daraz_secret && cfg.daraz_access_token) {
    const skuToUpdate = p.seller_sku || p.supplier_sku;
    if (skuToUpdate || p.daraz_sku_id || p.daraz_item_id) {
      try {
        const client = new DarazClient(cfg.daraz_app_key, cfg.daraz_secret, cfg.daraz_access_token);
        const regularPrice = Number(p.price_regular || p.sell_price || 0);
        const specialPrice = Number(p.price_special || 0);
        const stock = Number(p.stock_quantity !== undefined ? p.stock_quantity : 15);

        const syncRes = await client.updatePriceQuantity({
          sellerSku: skuToUpdate,
          skuId: p.daraz_sku_id ? String(p.daraz_sku_id) : undefined,
          price: regularPrice > 0 ? regularPrice : undefined,
          specialPrice: (specialPrice > 0 && specialPrice < regularPrice) ? specialPrice : undefined,
          quantity: stock
        });

        if (syncRes?.code === '0' || syncRes?.success || !syncRes?.error) {
          p.daraz_synced = true;
          p.daraz_price_synced = true;
          p.daraz_price_synced_at = nowString();
          darazSyncResult = { success: true, message: 'Price & quantity live updated on Daraz!' };
        } else {
          const errMsg = syncRes?.message || syncRes?.error || JSON.stringify(syncRes);
          darazSyncResult = { success: false, error: errMsg };
        }
      } catch (err: any) {
        darazSyncResult = { success: false, error: err.message };
      }
    }
  }

  await saveDb(db);
  res.json({ product: p, daraz_sync: darazSyncResult });
});

// Dedicated endpoint to explicitly update price on Daraz Seller Center
app.post('/api/daraz/price/update', async (req: Request, res: Response) => {
  const { url, price_regular, price_special, stock_quantity } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing product url' });

  const db = await loadDb();
  const p = db[url];
  if (!p) return res.status(404).json({ error: 'Product not found in database' });

  const cfg = await getDarazConfigForRequest(req);
  if (!cfg.daraz_app_key || !cfg.daraz_secret || !cfg.daraz_access_token) {
    return res.status(400).json({
      error: 'Daraz API credentials not configured. Please enter App Key, Secret, and Access Token in Settings.'
    });
  }

  const skuToUpdate = p.seller_sku || p.supplier_sku;
  if (!skuToUpdate && !p.daraz_sku_id && !p.daraz_item_id) {
    return res.status(400).json({
      error: 'No Seller SKU or Daraz Item ID found for this product. Please publish or assign a Seller SKU first.'
    });
  }

  const regularPrice = price_regular !== undefined ? Number(price_regular) : Number(p.price_regular || p.sell_price || 0);
  const specialPrice = price_special !== undefined ? Number(price_special) : Number(p.price_special || 0);
  const stock = stock_quantity !== undefined ? Number(stock_quantity) : Number(p.stock_quantity !== undefined ? p.stock_quantity : 15);

  p.price_regular = regularPrice;
  p.price_special = specialPrice > 0 ? specialPrice : null;
  p.sell_price = specialPrice > 0 ? specialPrice : regularPrice;
  if (stock_quantity !== undefined) p.stock_quantity = stock;

  try {
    const client = new DarazClient(cfg.daraz_app_key, cfg.daraz_secret, cfg.daraz_access_token);
    const syncRes = await client.updatePriceQuantity({
      sellerSku: skuToUpdate,
      skuId: p.daraz_sku_id ? String(p.daraz_sku_id) : undefined,
      price: regularPrice > 0 ? regularPrice : undefined,
      specialPrice: (specialPrice > 0 && specialPrice < regularPrice) ? specialPrice : undefined,
      quantity: stock
    });

    if (syncRes?.code === '0' || syncRes?.success || !syncRes?.error) {
      p.daraz_synced = true;
      p.daraz_price_synced = true;
      p.daraz_price_synced_at = nowString();
      await saveDb(db);
      return res.json({
        success: true,
        message: `Successfully updated Daraz price to ৳${p.sell_price} (Regular: ৳${regularPrice})!`,
        product: p,
        raw: syncRes
      });
    } else {
      const errMsg = syncRes?.message || syncRes?.error || JSON.stringify(syncRes);
      await saveDb(db);
      return res.status(400).json({
        error: `Daraz API Error: ${errMsg}`,
        product: p,
        raw: syncRes
      });
    }
  } catch (err: any) {
    await saveDb(db);
    return res.status(500).json({ error: `Failed to update Daraz price: ${err.message}` });
  }
});

app.post('/api/publish', async (req: Request, res: Response) => {
  const url = (req.body?.url || req.body?.product_url || req.query?.url || '') as string;
  const categoryOverride = req.body?.category_id || req.body?.primary_category;
  if (!url || !url.trim()) {
    return res.status(400).json({ error: 'Missing product URL. Please ensure a product is selected.' });
  }

  const cleanUrl = url.trim();
  const db = await loadDb();
  const p = db[cleanUrl] || db[decodeURIComponent(cleanUrl)];
  if (!p) return res.status(404).json({ error: 'Product not found in database' });

  const cfg = await getDarazConfigForRequest(req);
  if (!cfg.daraz_app_key || !cfg.daraz_secret || !cfg.daraz_access_token) {
    return res.status(400).json({
      error: 'Daraz API credentials are not configured yet. Please open Settings and enter your Daraz App Key, Secret, and Access Token.'
    });
  }

  // If product is already published on Daraz with an item_id
  if (p.daraz_item_id && p.status === 'published' && !req.body?.force_recreate) {
    p.daraz_url = p.daraz_url || `https://www.daraz.com.bd/products/-i${p.daraz_item_id}-s${p.daraz_sku_id || ''}.html`;
    p.daraz_synced = true;
    p.daraz_status = 'active';
    await saveDb(db);
    return res.json({
      success: true,
      item_id: p.daraz_item_id,
      sku: p.daraz_sku,
      already_published: true,
      message: `Product is already listed live on Daraz! (Item ID: ${p.daraz_item_id})`
    });
  }

  try {
    const client = new DarazClient(cfg.daraz_app_key, cfg.daraz_secret, cfg.daraz_access_token);
    const publishRes = await client.createProduct(p, { primaryCategory: categoryOverride });

    if (publishRes?.code === '0' || publishRes?.data?.item_id) {
      const itemId = publishRes.data?.item_id;
      const skuList = publishRes.data?.sku_list || [];
      const skuItem = skuList[0] || {};
      p.daraz_item_id = itemId;
      p.daraz_sku = skuItem.shop_sku || p.daraz_sku;
      p.daraz_sku_id = skuItem.sku_id || p.daraz_sku_id;
      p.seller_sku = skuItem.seller_sku || p.seller_sku;
      p.daraz_synced = true;
      p.status = 'published';
      p.daraz_status = 'active';
      p.daraz_url = `https://www.daraz.com.bd/products/-i${itemId}-s${skuItem.sku_id || ''}.html`;
      p.checked = nowString();
      await saveDb(db);
      return res.json({
        success: true,
        item_id: itemId,
        sku: skuItem.shop_sku,
        message: `Successfully listed product on Daraz! (Item ID: ${itemId})`
      });
    }

    const detailMsg = publishRes?.detail?.[0]?.message;
    const rawError = String(detailMsg || publishRes?.message || publishRes?.error || '');

    // Handle duplicate outer ID / SKU already existing in seller's Daraz catalog
    if (rawError.includes('duplicate outer ID') || rawError.includes('old Sku ID') || rawError.includes('THD_IC_ERR_F_IC_DOMAIN_PRODUCT_014')) {
      const match = rawError.match(/old Sku ID:(\d+)/i) || rawError.match(/(\d{7,})/);
      const existingSkuId = match ? match[1] : null;

      let existingItemId = p.daraz_item_id;
      let shopSku = p.daraz_sku;

      try {
        const darazProdsRes = await client.getProducts('all', 50, 0);
        const darazList = darazProdsRes?.data?.products || [];
        for (const dp of darazList) {
          const matchingSku = (dp.skus || []).find((s: any) =>
            (existingSkuId && String(s.SkuId) === String(existingSkuId)) ||
            (p.seller_sku && s.SellerSku && s.SellerSku.toLowerCase() === p.seller_sku.toLowerCase()) ||
            (p.supplier_sku && s.SellerSku && s.SellerSku.toLowerCase() === p.supplier_sku.toLowerCase())
          );
          if (matchingSku) {
            existingItemId = dp.item_id;
            shopSku = matchingSku.ShopSku || matchingSku.shop_sku || shopSku;
            break;
          }
        }
      } catch (err: any) {
        console.warn('Could not auto-lookup Daraz existing product:', err?.message);
      }

      if (existingItemId) {
        p.daraz_item_id = existingItemId;
        if (existingSkuId) p.daraz_sku_id = Number(existingSkuId) || existingSkuId;
        p.daraz_sku = shopSku || p.daraz_sku || `${existingItemId}_BD-${existingSkuId || ''}`;
        p.daraz_synced = true;
        p.status = 'published';
        p.daraz_status = 'active';
        p.daraz_url = `https://www.daraz.com.bd/products/-i${existingItemId}-s${p.daraz_sku_id || ''}.html`;
        p.checked = nowString();
        await saveDb(db);

        return res.json({
          success: true,
          item_id: existingItemId,
          sku: p.daraz_sku,
          already_existed: true,
          message: `Product is already listed live on Daraz! Synchronized catalog listing (Item ID: ${existingItemId}).`
        });
      }
    }

    const errorMsg = detailMsg || publishRes?.message || publishRes?.error || 'Failed to list product on Daraz API';
    return res.status(400).json({
      error: errorMsg,
      detail: publishRes?.detail,
      raw: publishRes
    });
  } catch (err: any) {
    console.error('Daraz publish error:', err);
    return res.status(500).json({ error: `Daraz publish error: ${err.message}` });
  }
});

async function runFetchUrls(urls: string[]) {
  const cfg = await getCfg();
  const db = await loadDb();
  const results: Array<{ url: string; ok: boolean; error?: string }> = [];

  for (let i = 0; i < urls.length; i++) {
    const u = urls[i];
    try {
      const p = await scrapeSupplierProduct(u, cfg);
      const old = db[u];
      p.added = old?.added || nowString();
      p.checked = nowString();
      p.sell_override = old?.sell_override ?? null;
      p.change = null;

      if (old) {
        const notes: any[] = [];
        if (old.cost_price !== undefined && p.cost_price !== undefined && old.cost_price !== p.cost_price) {
          notes.push({ type: 'price', from: old.cost_price, to: p.cost_price });
        }
        if (old.in_stock !== undefined && old.in_stock !== p.in_stock) {
          notes.push({ type: 'stock', from: old.in_stock, to: p.in_stock });
        }
        p.change = notes.length > 0 ? notes : null;
      }

      db[u] = finalizeProduct(p, cfg);
      results.push({ url: u, ok: true });
    } catch (err: any) {
      const status = Number(err?.response?.status);
      const responseHeaders = err?.response?.headers || {};
      const cloudflareChallenge =
        status === 403 &&
        (String(responseHeaders['cf-mitigated'] || '').toLowerCase() === 'challenge' ||
          String(responseHeaders.server || '').toLowerCase().includes('cloudflare'));
      if (cloudflareChallenge) {
        results.push({
          url: u,
          ok: false,
          error: 'Ryans returned a Cloudflare human-verification challenge (HTTP 403). SupplierDesk cannot import this page automatically. The existing saved product was left unchanged.'
        });
      } else {
        results.push({ url: u, ok: false, error: String(err?.message || err).slice(0, 200) });
      }
    }

    if (i < urls.length - 1 && cfg.delay_seconds > 0) {
      await new Promise(r => setTimeout(r, Math.min(cfg.delay_seconds, 1) * 1000));
    }
  }

  await saveDb(db);
  return { results, db };
}

app.post('/api/add', async (req: Request, res: Response) => {
  const rawUrls = req.body?.urls || [];
  const urls = rawUrls.map((u: string) => u.trim()).filter((u: string) => Boolean(u));
  const { results, db } = await runFetchUrls(urls);
  res.json({ results, products: Object.values(db) });
});

app.post('/api/refresh', async (req: Request, res: Response) => {
  const db = await loadDb();
  const urls = req.body?.urls || Object.keys(db);
  const { results, db: updatedDb } = await runFetchUrls(urls);
  res.json({ results, products: Object.values(updatedDb) });
});

app.post('/api/config', async (req: Request, res: Response) => {
  const body = req.body || {};
  const user = await getAuthenticatedUser(req);
  const isAdmin = user?.role === 'admin';

  const hasDarazCredentialChanges =
    body.daraz_app_key !== undefined ||
    body.daraz_secret !== undefined ||
    body.daraz_access_token !== undefined;
  if (hasDarazCredentialChanges && !isAdmin) {
    return res.status(403).json({
      error: 'Permission denied: Daraz application credentials can only be changed by an administrator.'
    });
  }
  if (body.daraz_access_token !== undefined) {
    return res.status(400).json({ error: 'Access tokens are stored per connected store and cannot be set through configuration.' });
  }
  const hasRedisCredentialChanges =
    body.upstash_redis_rest_url !== undefined ||
    body.upstash_redis_rest_token !== undefined;
  if (hasRedisCredentialChanges && !isAdmin) {
    return res.status(403).json({
      error: 'Permission denied: shared database credentials can only be changed by an administrator.'
    });
  }

  // Strict check: non-admin (seller or unauthenticated) cannot modify SMTP configuration
  const hasSmtpChanges =
    body.smtp_host !== undefined ||
    body.smtp_port !== undefined ||
    body.smtp_secure !== undefined ||
    body.smtp_user !== undefined ||
    body.smtp_pass !== undefined ||
    body.smtp_from !== undefined;

  if (hasSmtpChanges && !isAdmin) {
    return res.status(403).json({
      error: 'Permission denied: SMTP email configuration is admin-only. Sellers cannot view or modify mail server settings.'
    });
  }

  const cfg = await getCfg();

  for (const k of ['markup_percent', 'fixed_add', 'round_to', 'delay_seconds'] as const) {
    if (k in body) {
      (cfg as any)[k] = k === 'markup_percent' ? parseFloat(body[k]) : parseInt(body[k], 10);
    }
  }

  if (body.daraz_app_key !== undefined) cfg.daraz_app_key = body.daraz_app_key;
  if (body.daraz_secret !== undefined) cfg.daraz_secret = body.daraz_secret;
  if (body.upstash_redis_rest_url !== undefined) cfg.upstash_redis_rest_url = body.upstash_redis_rest_url;
  if (body.upstash_redis_rest_token !== undefined) cfg.upstash_redis_rest_token = body.upstash_redis_rest_token;
  if (body.zenrows_api_key !== undefined) cfg.zenrows_api_key = String(body.zenrows_api_key).trim();

  // Only administrators can modify SMTP settings
  if (isAdmin) {
    if (body.smtp_host !== undefined) cfg.smtp_host = body.smtp_host;
    if (body.smtp_port !== undefined) cfg.smtp_port = parseInt(body.smtp_port, 10) || 587;
    if (body.smtp_secure !== undefined) cfg.smtp_secure = Boolean(body.smtp_secure);
    if (body.smtp_user !== undefined) cfg.smtp_user = body.smtp_user;
    if (body.smtp_pass !== undefined) cfg.smtp_pass = body.smtp_pass;
    if (body.smtp_from !== undefined) cfg.smtp_from = body.smtp_from;
  }

  const modes = body.cost_price_mode || {};
  for (const [site, mode] of Object.entries(modes)) {
    if (mode === 'special' || mode === 'regular') {
      cfg.cost_price_mode[site] = mode;
    }
  }

  await saveCfg(cfg);
  const db = await loadDb();
  for (const p of Object.values(db)) {
    finalizeProduct(p, cfg);
  }
  await saveDb(db);

  // Never return access tokens; application credentials and SMTP settings are admin-only.
  const safeConfig: Record<string, any> = { ...cfg };
  delete safeConfig.daraz_access_token;
  if (!isAdmin) {
    delete safeConfig.daraz_app_key;
    delete safeConfig.daraz_secret;
    delete safeConfig.upstash_redis_rest_url;
    delete safeConfig.upstash_redis_rest_token;
    delete safeConfig.smtp_host;
    delete safeConfig.smtp_port;
    delete safeConfig.smtp_secure;
    delete safeConfig.smtp_user;
    delete safeConfig.smtp_pass;
    delete safeConfig.smtp_from;
  }

  res.json({ config: safeConfig, products: Object.values(db) });
});

app.post('/api/config/test-smtp', async (req: Request, res: Response) => {
  const user = await getAuthenticatedUser(req);
  if (user?.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Permission denied: Only administrators can test SMTP configurations.'
    });
  }

  const { host, port, secure, user: testUser, pass, from, targetEmail } = req.body || {};
  const customConfig = (host && testUser && pass) ? {
    host: String(host).trim(),
    port: Number(port) || 587,
    secure: Boolean(secure),
    user: String(testUser).trim(),
    pass: String(pass).trim(),
    from: String(from || '').trim()
  } : undefined;

  const result = await testSmtp(customConfig, targetEmail);
  res.json(result);
});

app.post('/api/override', async (req: Request, res: Response) => {
  const body = req.body || {};
  const db = await loadDb();
  const p = db[body.url];
  if (!p) return res.status(404).json({ error: 'not found' });

  const val = body.sell_price;
  const numVal = (val !== null && val !== undefined && val !== '' && !isNaN(Number(val))) ? Number(val) : null;
  p.sell_override = (numVal && numVal > 0) ? Math.round(numVal) : null;
  if (numVal && numVal > 0) {
    p.sell_price = Math.round(numVal);
    p.price_special = Math.round(numVal);
    if (!p.price_regular || p.price_regular < p.sell_price) {
      p.price_regular = Math.round(p.sell_price * 1.15);
    }
  }

  const cfg = await getDarazConfigForRequest(req);
  finalizeProduct(p, cfg);

  // Live Daraz Price Sync when credentials are configured
  let darazResult: any = null;
  if (cfg.daraz_app_key && cfg.daraz_secret && cfg.daraz_access_token) {
    const skuToUpdate = p.seller_sku || p.supplier_sku;
    if (skuToUpdate || p.daraz_sku_id || p.daraz_item_id) {
      try {
        const client = new DarazClient(cfg.daraz_app_key, cfg.daraz_secret, cfg.daraz_access_token);
        const regularPrice = Number(p.price_regular || p.sell_price || numVal || 0);
        const specialPrice = Number(p.price_special || numVal || 0);
        const stock = Number(p.stock_quantity !== undefined ? p.stock_quantity : 15);

        const syncRes = await client.updatePriceQuantity({
          sellerSku: skuToUpdate,
          skuId: p.daraz_sku_id ? String(p.daraz_sku_id) : undefined,
          itemId: p.daraz_item_id ? String(p.daraz_item_id) : undefined,
          price: regularPrice > 0 ? regularPrice : undefined,
          specialPrice: (specialPrice > 0 && specialPrice < regularPrice) ? specialPrice : undefined,
          quantity: stock
        });

        if (syncRes?.code === '0' || syncRes?.success || !syncRes?.error) {
          p.daraz_synced = true;
          p.daraz_price_synced = true;
          p.daraz_price_synced_at = nowString();
          darazResult = { success: true, message: `Live updated on Daraz to ৳${p.sell_price}!` };
        } else {
          const errMsg = syncRes?.message || syncRes?.error || JSON.stringify(syncRes);
          darazResult = { success: false, error: errMsg };
        }
      } catch (err: any) {
        darazResult = { success: false, error: err.message };
      }
    } else {
      darazResult = { success: false, error: 'Product is missing Seller SKU / Item ID for Daraz' };
    }
  } else {
    darazResult = { success: false, notConfigured: true, error: 'Daraz API credentials not configured in Settings' };
  }

  await saveDb(db);
  res.json({ product: p, daraz_sync: darazResult });
});

async function fetchDarazLiveStoreMetrics(itemId: string | number): Promise<{
  itemId: string;
  name?: string;
  price?: number;
  sold?: number;
  sellerName?: string;
  inStock?: boolean;
  reviewCount?: number;
  rating?: number | null;
} | null> {
  try {
    const res = await axios.get('https://www.daraz.com.bd/catalog/', {
      params: { ajax: 'true', q: String(itemId) },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      },
      timeout: 10000
    });
    const items = res.data?.mods?.listItems || [];
    const match = items.find((it: any) => String(it.itemId) === String(itemId)) || items[0];
    if (!match) return null;
    const soldMatch = String(match.itemSoldCntShow || '').match(/\d+/);
    const sold = soldMatch ? parseInt(soldMatch[0], 10) : undefined;
    return {
      itemId: String(match.itemId),
      name: match.name,
      price: match.price ? parseFloat(match.price) : undefined,
      sold,
      sellerName: match.sellerName,
      inStock: match.inStock !== false,
      reviewCount: match.review ? parseInt(match.review, 10) : 0,
      rating: match.ratingScore ? parseFloat(match.ratingScore) : null
    };
  } catch (err) {
    return null;
  }
}

app.post('/api/daraz/views/sync', async (req: Request, res: Response) => {
  const db = await loadDb();
  const cfg = await getDarazConfigForRequest(req);
  const urlFilter = req.body?.url ? String(req.body.url).trim() : null;
  const decodedUrlFilter = urlFilter ? decodeURIComponent(urlFilter) : null;

  let client: DarazClient | null = null;
  if (cfg.daraz_app_key && cfg.daraz_secret && cfg.daraz_access_token) {
    client = new DarazClient(cfg.daraz_app_key, cfg.daraz_secret, cfg.daraz_access_token);
  }

  let updatedCount = 0;
  let viewsSyncedCount = 0;
  let viewsUnavailableCount = 0;
  let missingInventoryCount = 0;
  const apiErrors: Array<{ itemId: string; code: string; message: string }> = [];
  const missingInventoryItems: Array<{ itemId: string; name?: string }> = [];
  const updatedProducts: any[] = [];
  let liveItemIds: Set<string> | null = null;

  if (client) {
    const discoveredItemIds = new Set<string>();
    let offset = 0;
    const limit = 50;
    let inventoryComplete = false;

    try {
      while (offset < 500) {
        const inventoryRes = await client.getProducts('all', limit, offset);
        const inventoryError = getDarazResponseError(inventoryRes);
        if (inventoryError) {
          apiErrors.push({ itemId: 'inventory', ...inventoryError });
          break;
        }

        const products = inventoryRes?.data?.products || inventoryRes?.products || [];
        for (const item of products) {
          const itemId = item?.item_id ?? item?.itemId;
          if (itemId !== undefined && itemId !== null) discoveredItemIds.add(String(itemId));
        }

        const total = Number(inventoryRes?.data?.total_products ?? inventoryRes?.total_products);
        if (products.length < limit || (Number.isFinite(total) && discoveredItemIds.size >= total)) {
          inventoryComplete = true;
          break;
        }
        offset += limit;
      }

      if (inventoryComplete) liveItemIds = discoveredItemIds;
    } catch (e: any) {
      apiErrors.push({
        itemId: 'inventory',
        code: 'REQUEST_FAILED',
        message: String(e?.message || 'Daraz inventory request failed')
      });
    }
  }

  for (const [key, p] of Object.entries(db)) {
    if (urlFilter) {
      const matchKey = key === urlFilter || key === decodedUrlFilter || decodeURIComponent(key) === decodedUrlFilter;
      const matchUrl = p.url === urlFilter || p.url === decodedUrlFilter || decodeURIComponent(p.url || '') === decodedUrlFilter;
      const matchId = String(p.daraz_item_id || '') === urlFilter;
      if (!matchKey && !matchUrl && !matchId) continue;
    }
    const isDarazListed = Boolean(p.daraz_synced || p.daraz_item_id || p.source === 'daraz' || p.status === 'published');
    if (!isDarazListed && !urlFilter) continue;

    let syncedViews: number | undefined;
    let syncedSold: number | undefined;

    if (client && p.daraz_item_id && liveItemIds && !liveItemIds.has(String(p.daraz_item_id))) {
      missingInventoryCount++;
      missingInventoryItems.push({
        itemId: String(p.daraz_item_id),
        name: p.name
      });
      updatedCount++;
      updatedProducts.push({
        url: p.url,
        name: p.name,
        views: p.views,
        viewsSynced: false,
        sold: p.sold,
        missingFromInventory: true
      });
      continue;
    }

    // Public listing data can update sales and product details.
    if (p.daraz_item_id) {
      const live = await fetchDarazLiveStoreMetrics(p.daraz_item_id);
      if (live) {
        if (live.sold !== undefined) syncedSold = live.sold;
        if (live.price && (!p.sell_price || p.source === 'daraz')) {
          p.sell_price = live.price;
        }
        if (live.reviewCount !== undefined) {
          p.reviews_count = live.reviewCount;
        }
        if (live.rating !== null && live.rating !== undefined) {
          p.rating = live.rating;
        }
        if (live.sellerName) {
          p.daraz_seller_name = live.sellerName;
        }
      }
    }

    // The item response may include view metrics for accounts with access to them.
    if (client && p.daraz_item_id) {
      try {
        const itemRes = await client.getItem(p.daraz_item_id);
        const apiError = getDarazResponseError(itemRes);
        if (apiError) {
          console.warn(`Daraz getItem failed for item ${p.daraz_item_id}:`, apiError.code, apiError.message);
          apiErrors.push({ itemId: String(p.daraz_item_id), ...apiError });
        } else {
          const metricSources = getDarazItemMetricSources(itemRes);
          syncedViews = firstNonNegativeMetric(...metricSources.flatMap((itemData) => [
            itemData.views,
            itemData.view_count,
            itemData.page_views,
            itemData.traffic
          ]));
          const itemSold = firstNonNegativeMetric(...metricSources.flatMap((itemData) => [
            itemData.sold,
            itemData.sold_count
          ]));
          if (itemSold !== undefined) syncedSold = itemSold;
        }
      } catch (e: any) {
        console.warn('Daraz getItem failed for views:', e?.message);
        apiErrors.push({
          itemId: String(p.daraz_item_id),
          code: 'REQUEST_FAILED',
          message: String(e?.message || 'Daraz API request failed')
        });
      }
    }

    if (syncedViews !== undefined) {
      p.views = syncedViews;
      p.views_synced = true;
      p.views_synced_at = nowString();
      viewsSyncedCount++;
    } else {
      viewsUnavailableCount++;
    }
    if (syncedSold !== undefined) p.sold = syncedSold;
    updatedCount++;
    updatedProducts.push({
      url: p.url,
      name: p.name,
      views: p.views,
      viewsSynced: syncedViews !== undefined,
      sold: p.sold
    });
  }

  await saveDb(db);
  const errorSummary = apiErrors.length > 0
    ? `Daraz API errors: ${apiErrors.slice(0, 3).map(({ itemId, code, message }) => `item ${itemId} (${code}): ${message}`).join('; ')}${apiErrors.length > 3 ? `; and ${apiErrors.length - 3} more` : ''}.`
    : '';
  const inventorySummary = missingInventoryCount > 0
    ? `${missingInventoryCount} saved product(s) are missing from the live Daraz inventory (${missingInventoryItems.map(item => item.itemId).join(', ')}); their saved values were kept.`
    : '';
  const message = viewsSyncedCount > 0
    ? `Synced view counts for ${viewsSyncedCount} product(s). ${viewsUnavailableCount > 0 ? `No view metric was returned for ${viewsUnavailableCount} product(s); their stored values and last successful sync status were kept.` : ''} ${inventorySummary} ${errorSummary}`.trim()
    : viewsUnavailableCount > 0
      ? `${client
        ? `No view metric was returned for ${viewsUnavailableCount} product(s); their stored values and last successful sync status were kept.`
        : `Daraz API credentials are not configured; stored view values and last successful sync status were kept.`} ${inventorySummary} ${errorSummary}`.trim()
      : missingInventoryCount > 0
        ? `${inventorySummary} ${errorSummary}`.trim()
      : 'No Daraz products were selected for view sync.';
  res.json({
    success: true,
    updatedCount,
    viewsSyncedCount,
    viewsUnavailableCount,
    missingInventoryCount,
    missingInventoryItems,
    apiErrors,
    message,
    products: updatedProducts
  });
});

// Sync real Daraz CDN images for one or all products
app.post('/api/daraz/sync_images', async (req: Request, res: Response) => {
  const urlFilter = req.body?.url ? String(req.body.url).trim() : null;
  const decodedUrlFilter = urlFilter ? decodeURIComponent(urlFilter) : null;
  const syncAll = req.body?.all === true || !urlFilter;

  const db = await loadDb();
  let updatedCount = 0;
  const updatedList: any[] = [];

  for (const [key, p] of Object.entries(db)) {
    if (!syncAll && urlFilter) {
      const matchKey = key === urlFilter || key === decodedUrlFilter || decodeURIComponent(key) === decodedUrlFilter;
      const matchUrl = p.url === urlFilter || p.url === decodedUrlFilter || decodeURIComponent(p.url || '') === decodedUrlFilter;
      const matchId = String(p.daraz_item_id || '') === urlFilter;
      if (!matchKey && !matchUrl && !matchId) continue;
    }

    let foundImages: string[] = [];

    // 1. Fetch from live Daraz listing
    if (p.daraz_url || p.daraz_item_id) {
      foundImages = await fetchDarazProductImages(p.daraz_url, p.daraz_item_id);
    }

    // 2. If no Daraz images and supplier original images exist, convert supplier images to JPEG
    if (foundImages.length === 0 && p.original_images && p.original_images.length > 0) {
      for (const origUrl of p.original_images) {
        try {
          const resp = await axios.get(origUrl, {
            responseType: 'arraybuffer',
            headers: {
              'User-Agent': getRandomUserAgent(),
              'Referer': origUrl
            },
            timeout: 10000
          });
          const hash = crypto.createHash('md5').update(origUrl).digest('hex');
          const filename = `${hash}.jpg`;
          const filepath = path.join(UPLOADS_DIR, filename);
          await sharp(Buffer.from(resp.data)).jpeg({ quality: 90 }).toFile(filepath);
          foundImages.push(`/static/uploads/${filename}`);
        } catch {
          foundImages.push(origUrl);
        }
      }
    }

    if (foundImages.length > 0) {
      p.images = foundImages;
      p.promo_image = foundImages[0];
      updatedCount++;
      updatedList.push({ name: p.name, imagesCount: foundImages.length, firstImage: foundImages[0] });
    }
  }

  await saveDb(db);

  let targetProduct = null;
  if (urlFilter) {
    targetProduct = db[urlFilter] || Object.values(db).find((p: any) => p.url === urlFilter || String(p.daraz_item_id) === urlFilter);
  }

  return res.json({
    success: true,
    updatedCount,
    product: targetProduct,
    images: targetProduct?.images || [],
    message: `✓ Synchronized ${updatedCount} product image gallery from Daraz!`
  });
});

// Update or set views and sales explicitly for a product
app.post('/api/daraz/views/update', async (req: Request, res: Response) => {
  const { url, views, sold } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing product url' });

  const db = await loadDb();
  const p = db[url] || db[decodeURIComponent(url)];
  if (!p) return res.status(404).json({ error: 'Product not found' });

  if (views !== undefined) {
    p.views = Math.max(0, Number(views) || 0);
    p.views_synced = false;
    delete p.views_synced_at;
  }
  if (sold !== undefined) {
    p.sold = Math.max(0, Number(sold) || 0);
  }

  await saveDb(db);
  res.json({
    success: true,
    message: `Views (${p.views.toLocaleString()}) and sales (${p.sold}) saved locally; view counts were not synced with Daraz.`,
    product: p
  });
});

app.post('/api/delete', async (req: Request, res: Response) => {
  const url = req.body?.url;
  const itemId = req.body?.item_id || req.body?.daraz_item_id;
  const deleteFromDaraz = Boolean(req.body?.delete_from_daraz);
  const db = await loadDb();
  let deleted = false;
  let darazResult: any = null;

  if (url || itemId) {
    const target = url ? String(url).trim() : '';
    const targetDecoded = target ? decodeURIComponent(target) : '';
    const idStr = itemId ? String(itemId).trim() : '';
    for (const k of Object.keys(db)) {
      const p = db[k];
      const kDecoded = decodeURIComponent(k);
      const matchesUrl = Boolean(
        target && (
          k === target ||
          k.trim() === target ||
          kDecoded === target ||
          kDecoded === targetDecoded ||
          (p && p.url && (p.url === target || decodeURIComponent(p.url) === targetDecoded || p.url.trim() === target))
        )
      );
      const matchesId = Boolean(
        idStr && p && (
          String(p.daraz_item_id) === idStr ||
          String(p.item_id) === idStr ||
          String(p.daraz_sku_id) === idStr
        )
      );
      if (matchesUrl || matchesId) {
        if (deleteFromDaraz && p.daraz_item_id) {
          try {
            const cfg = await getDarazConfigForRequest(req);
            if (cfg.daraz_app_key && cfg.daraz_secret && cfg.daraz_access_token) {
              const client = new DarazClient(cfg.daraz_app_key, cfg.daraz_secret, cfg.daraz_access_token);
              // In Daraz OpenAPI, zeroing the quantity deactivates / takes down the live product SKU from the storefront
              darazResult = await client.updatePriceQuantity({
                itemId: p.daraz_item_id,
                skuId: p.daraz_sku_id,
                sellerSku: p.seller_sku || p.supplier_sku,
                quantity: 0
              });
            }
          } catch (e: any) {
            console.warn('Delete from Daraz error:', e?.message);
            darazResult = { error: e?.message };
          }
        }
        delete db[k];
        deleted = true;
      }
    }
    if (deleted) {
      await saveDb(db);
    }
  }
  res.json({ success: true, deleted, daraz_result: darazResult, count: Object.keys(db).length, products: Object.values(db) });
});

app.post('/api/drafts/clear', async (_req: Request, res: Response) => {
  const db = await loadDb();
  let count = 0;
  for (const u of Object.keys(db)) {
    if (db[u]?.status !== 'published') {
      delete db[u];
      count++;
    }
  }
  await saveDb(db);
  res.json({ success: true, count, message: `Cleared ${count} draft(s)`, products: Object.values(db) });
});

app.post('/api/sync_stock', async (req: Request, res: Response) => {
  const urls: string[] = req.body?.urls || [];
  if (urls.length === 0) return res.status(400).json({ error: 'no urls provided' });

  const cfg = await getDarazConfigForRequest(req);
  const db = await loadDb();
  let syncCount = 0;
  const updates: string[] = [];

  for (const u of urls) {
    const p = db[u];
    if (!p) continue;
    try {
      const latest = await scrapeSupplierProduct(u, cfg);
      const newStock = latest.in_stock;

      if (p.in_stock !== newStock) {
        p.in_stock = newStock;
        p.checked = nowString();
        syncCount++;
        updates.push(`${p.name}: ${newStock ? 'In Stock' : 'Out of Stock'}`);

        if (cfg.daraz_app_key && cfg.daraz_secret && cfg.daraz_access_token) {
          const client = new DarazClient(cfg.daraz_app_key, cfg.daraz_secret, cfg.daraz_access_token);
          await client.updateStock(p.supplier_sku, newStock ? 10 : 0);
        }
      }
    } catch (err: any) {
      updates.push(`Error syncing ${u}: ${err.message}`);
    }
  }

  await saveDb(db);
  res.json({ message: `Synced ${syncCount} products`, details: updates, status: 'success' });
});

app.get('/api/research/search', async (req: Request, res: Response) => {
  const q = String(req.query.q || '').trim();
  const sort = String(req.query.sort || 'priceAsc');
  if (!q) return res.status(400).json({ error: 'missing query' });

  const queries = q.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  const allResults: Array<{ name: string; price: number }> = [];

  for (const query of queries) {
    const results = await searchDaraz(query, sort);
    allResults.push(...results);
  }

  const seen = new Set<string>();
  const uniqueResults: Array<{ name: string; price: number }> = [];
  for (const r of allResults) {
    if (!seen.has(r.name)) {
      seen.add(r.name);
      uniqueResults.push(r);
    }
  }

  res.json({ results: uniqueResults });
});

app.get('/api/research/link', (req: Request, res: Response) => {
  const query = String(req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'missing query' });
  const url = `https://www.daraz.com.bd/catalog/?q=${encodeURIComponent(query)}`;
  res.json({ url });
});

app.post('/api/research/calc', (req: Request, res: Response) => {
  const body = req.body || {};
  const cost = body.cost_price;
  const lowest = body.lowest_price;

  if (cost === undefined || cost === null || lowest === undefined || lowest === null) {
    return res.status(400).json({ error: 'missing cost or lowest price' });
  }

  const costNum = parseFloat(cost);
  const lowestNum = parseFloat(lowest);

  const margin = lowestNum - costNum;
  const marginPct = lowestNum !== 0 ? (margin / lowestNum) * 100 : 0;
  const undercutPrice = lowestNum > 1 ? lowestNum - 1 : 0;
  const undercutMargin = undercutPrice - costNum;

  res.json({
    margin,
    margin_pct: Math.round(marginPct * 100) / 100,
    undercut_price: undercutPrice,
    undercut_margin: undercutMargin,
    is_profitable: undercutMargin > 0
  });
});

app.get('/api/orders', async (_req: Request, res: Response) => {
  const orders = await getOrders();
  res.json({ orders });
});

app.post('/api/orders/sync', async (req: Request, res: Response) => {
  const cfg = await getDarazConfigForRequest(req);
  const appKey = cfg.daraz_app_key;
  const secret = cfg.daraz_secret;
  const token = cfg.daraz_access_token;

  if (!appKey || !secret || !token) {
    return res.status(400).json({
      error: 'Daraz API credentials not configured yet. Please enter your App Key, Secret, and Access Token in Settings to sync live orders.'
    });
  }

  try {
    const client = new DarazClient(appKey, secret, token);
    const ordersData = await client.getOrders();
    if (ordersData?.error || (ordersData?.code && ordersData?.code !== '0')) {
      const errorMsg = ordersData?.message || ordersData?.error || 'Failed to fetch orders from Daraz';
      return res.status(400).json({ error: errorMsg, raw: ordersData });
    }
    const rawOrders = ordersData?.data?.orders || ordersData?.orders || [];
    const existingOrders = await getOrders();
    const existingMap = new Map(existingOrders.map((o: any) => [String(o.order_id || o.id), o]));

    for (const ro of rawOrders) {
      const orderId = String(ro.order_id || ro.order_number || ro.id);
      const itemsCount = Number(ro.items_count || 1);
      const price = Number(ro.price || 0);
      const orderObj = {
        order_id: orderId,
        id: orderId,
        customer_name: `${ro.customer_first_name || ''} ${ro.customer_last_name || ''}`.trim() || 'Daraz Customer',
        status: ro.statuses?.[0] || ro.status || 'pending',
        created_at: ro.created_at || nowString(),
        updated_at: ro.updated_at || nowString(),
        items_count: itemsCount,
        price,
        payment_method: ro.payment_method || 'Online / COD',
        shipping_fee: Number(ro.shipping_fee || 0),
        raw: ro
      };
      existingMap.set(orderId, orderObj);
    }

    const merged = Array.from(existingMap.values());
    await saveOrders(merged);
    res.json({ message: `Successfully synced ${rawOrders.length} live orders from Daraz!`, count: rawOrders.length, total: merged.length, status: 'success' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/daraz/products/sync', async (req: Request, res: Response) => {
  const cfg = await getDarazConfigForRequest(req);
  const appKey = cfg.daraz_app_key;
  const secret = cfg.daraz_secret;
  const token = cfg.daraz_access_token;

  if (!appKey || !secret) {
    return res.status(400).json({
      error: 'Daraz App Key and Secret are not configured yet. Please enter them in Settings.'
    });
  }

  if (!token) {
    return res.status(400).json({
      error: 'Daraz Access Token is not configured. Please authorize your Daraz store in Settings first to generate an Access Token.'
    });
  }

  try {
    const client = new DarazClient(appKey, secret, token);
    const db = await loadDb();

    let allDarazProducts: any[] = [];
    let offset = 0;
    const limit = 50;
    let totalOnDaraz = 0;

    // Fetch pages of products from Daraz /products/get
    while (offset < 500) {
      const response = await client.getProducts('all', limit, offset);
      if (response?.error || (response?.code && response?.code !== '0')) {
        const errorMsg = response?.message || response?.error || 'Failed to fetch products from Daraz';
        if (allDarazProducts.length === 0) {
          return res.status(400).json({ error: errorMsg, raw: response });
        }
        break;
      }

      const productsData = response?.data?.products || response?.products || [];
      totalOnDaraz = response?.data?.total_products || response?.total_products || productsData.length;
      allDarazProducts = allDarazProducts.concat(productsData);

      if (productsData.length < limit || allDarazProducts.length >= totalOnDaraz) {
        break;
      }
      offset += limit;
    }

    let syncedCount = 0;
    let updatedCount = 0;

    for (const item of allDarazProducts) {
      const itemId = item.item_id || item.itemId;
      if (!itemId) continue;

      const attrs = item.attributes || {};
      const skus = Array.isArray(item.skus) ? item.skus : [];
      const primarySku = skus[0] || {};

      const sellerSku = primarySku.SellerSku || primarySku.seller_sku || '';
      const shopSku = primarySku.ShopSku || primarySku.shop_sku || '';
      const skuId = primarySku.SkuId || primarySku.sku_id || '';
      const price = Number(primarySku.price || primarySku.special_price) || 0;
      const specialPrice = primarySku.special_price ? Number(primarySku.special_price) : null;
      const quantity = primarySku.quantity !== undefined ? Number(primarySku.quantity) : 0;
      const images: string[] = Array.isArray(primarySku.Images) && primarySku.Images.length > 0
        ? primarySku.Images
        : (Array.isArray(item.images) ? item.images : []);
      const prodUrl = primarySku.Url || `https://www.daraz.com.bd/products/-i${itemId}.html`;
      const name = attrs.name || item.name || 'Daraz Product';
      const brand = attrs.brand || item.brand || 'Generic';

      // Check if this product is already in the database
      let matchKey: string | null = null;
      for (const [key, p] of Object.entries(db)) {
        if (
          (p.daraz_item_id && String(p.daraz_item_id) === String(itemId)) ||
          (sellerSku && p.supplier_sku && p.supplier_sku.toLowerCase() === sellerSku.toLowerCase()) ||
          (sellerSku && p.seller_sku && p.seller_sku.toLowerCase() === sellerSku.toLowerCase()) ||
          key === prodUrl
        ) {
          matchKey = key;
          break;
        }
      }

      const itemViews = firstNonNegativeMetric(item.views, item.view_count, item.page_views, item.traffic, primarySku.views);
      const itemSold = firstNonNegativeMetric(item.sold, item.sold_count, item.orders, primarySku.sold);

      if (matchKey && db[matchKey]) {
        // Update existing listed product
        const existing = db[matchKey];
        existing.daraz_item_id = itemId;
        existing.daraz_sku = shopSku || existing.daraz_sku;
        existing.daraz_sku_id = skuId || existing.daraz_sku_id;
        existing.seller_sku = sellerSku || existing.seller_sku;
        existing.daraz_synced = true;
        existing.status = 'published';
        existing.sell_price = price || existing.sell_price;
        existing.price_regular = price;
        if (specialPrice) existing.price_special = specialPrice;
        existing.stock_quantity = quantity;
        existing.in_stock = quantity > 0;
        existing.daraz_status = primarySku.Status || 'active';
        existing.checked = nowString();
        if (itemViews !== undefined) {
          existing.views = itemViews;
          existing.views_synced = true;
          existing.views_synced_at = nowString();
        }
        if (itemSold !== undefined) existing.sold = itemSold;
        finalizeProduct(existing, cfg);
        updatedCount++;
      } else {
        // Add new Daraz-listed product to SellerDesk
        const newProduct = {
          url: prodUrl,
          source: 'daraz',
          name,
          brand,
          daraz_item_id: itemId,
          daraz_sku: shopSku,
          daraz_sku_id: skuId,
          supplier_sku: sellerSku,
          seller_sku: sellerSku,
          cost_price: null,
          price_regular: price,
          price_special: specialPrice,
          sell_price: price,
          sell_override: null,
          in_stock: quantity > 0,
          stock_quantity: quantity,
          views: itemViews ?? 0,
          sold: itemSold ?? 0,
          views_synced: itemViews !== undefined,
          views_synced_at: itemViews !== undefined ? nowString() : undefined,
          images,
          status: 'published',
          daraz_synced: true,
          daraz_status: primarySku.Status || 'active',
          daraz_url: prodUrl,
          specs: {},
          highlights: [],
          description: attrs.description || '',
          added: nowString(),
          checked: nowString(),
          flags: []
        };
        finalizeProduct(newProduct, cfg);
        db[prodUrl] = newProduct;
        syncedCount++;
      }
    }

    await saveDb(db);

    const published = Object.values(db).filter((p: any) => p.status === 'published');
    res.json({
      success: true,
      count: syncedCount + updatedCount,
      newSynced: syncedCount,
      updated: updatedCount,
      totalOnDaraz: allDarazProducts.length,
      message: `Successfully synced ${syncedCount + updatedCount} Daraz-listed products to SellerDesk (${syncedCount} new, ${updatedCount} updated)!`,
      products: published
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Internal error while syncing Daraz products' });
  }
});

app.get('/api/daraz/stores', async (req: Request, res: Response) => {
  const user = await getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in to manage Daraz stores.' });

  const stores = user.role === 'admin'
    ? await getAllDarazStores()
    : await getDarazStores(user.userId);
  const users = user.role === 'admin' ? await getAllUsers() : [];
  const userById = new Map(users.map(record => [record.id, record]));
  const visibleStores = stores.map(store => ({
    id: store.id,
    name: store.name,
    sellerId: store.sellerId,
    connectedAt: store.createdAt,
    updatedAt: store.updatedAt,
    ownerUserId: user.role === 'admin' ? store.ownerUserId : undefined,
    ownerName: user.role === 'admin' ? userById.get(store.ownerUserId)?.name : undefined,
    ownerEmail: user.role === 'admin' ? userById.get(store.ownerUserId)?.email : undefined
  }));

  const cfg = await getCfg();
  if (user.role === 'admin' && cfg.daraz_access_token) {
    visibleStores.unshift({
      id: 'legacy-config',
      name: 'Existing Daraz connection',
      sellerId: 'Legacy account',
      connectedAt: '',
      updatedAt: '',
      ownerUserId: user.userId,
      ownerName: user.name,
      ownerEmail: user.email
    });
  }
  res.json({ stores: visibleStores, isAdmin: user.role === 'admin' });
});

app.delete('/api/daraz/stores/:storeId', async (req: Request, res: Response) => {
  const user = await getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in to manage Daraz stores.' });
  if (req.params.storeId === 'legacy-config') {
    return res.status(400).json({ error: 'The existing administrator connection cannot be removed from this list.' });
  }

  const stores = user.role === 'admin'
    ? await getAllDarazStores()
    : await getDarazStores(user.userId);
  const store = stores.find(item => item.id === req.params.storeId);
  if (!store) return res.status(404).json({ error: 'Daraz store not found.' });
  if (user.role !== 'admin' && store.ownerUserId !== user.userId) {
    return res.status(403).json({ error: 'You cannot remove another user’s Daraz store.' });
  }
  await deleteDarazStore(store.ownerUserId, store.id);
  res.json({ success: true });
});

app.get('/api/daraz/oauth/authorize', async (req: Request, res: Response) => {
  const user = await getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in before authorizing a Daraz store.' });
  const cfg = await getCfg();
  if (!cfg.daraz_app_key || !cfg.daraz_secret) {
    return res.status(400).json({ error: 'Daraz application credentials have not been configured by an administrator.' });
  }

  const state = createDarazOAuthState(user.userId, cfg.daraz_secret);
  const forwardedProtocol = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0].trim();
  const redirectUri = `${forwardedProtocol}://${req.get('host')}/api/daraz/callback`;
  const authUrl = new URL('https://api.daraz.com.bd/oauth/authorize');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('force_auth', 'true');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('client_id', cfg.daraz_app_key);
  authUrl.searchParams.set('state', state);
  res.json({ url: authUrl.toString() });
});

app.get(['/api/daraz/callback', '/callback'], async (req: Request, res: Response) => {
  const code = String(req.query.code || '');
  const state = String(req.query.state || '');
  const oauthError = String(req.query.error_description || req.query.error || '');
  const cfg = await getCfg();
  let message = 'Daraz authorization could not be completed. Return to SupplierDesk and try again.';
  let success = false;

  const userId = cfg.daraz_secret ? verifyDarazOAuthState(state, cfg.daraz_secret) : null;
  if (userId && !oauthError && code) {
    try {
      if (!cfg.daraz_app_key || !cfg.daraz_secret) {
        throw new Error('Daraz application credentials are not configured.');
      }
      if (!await getUserById(userId)) throw new Error('The SupplierDesk account for this authorization no longer exists.');
      const tokenResponse = await new DarazClient(cfg.daraz_app_key, cfg.daraz_secret).createToken(code);
      const store = await saveDarazTokenForUser(userId, tokenResponse);
      success = true;
      message = `Connected ${store.name} successfully.`;
    } catch (err: any) {
      message = `Daraz authorization failed: ${String(err?.message || err)}`;
    }
  } else if (oauthError) {
    message = `Daraz authorization failed: ${oauthError}`;
  } else if (!userId) {
    message = 'This authorization link expired or was already used. Start again from SupplierDesk.';
  }

  const safeMessage = message.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character] || character));
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Daraz authorization</title></head>
<body style="font:16px system-ui;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0">
<main style="max-width:420px;padding:24px;background:#1e293b;border-radius:16px;text-align:center">
<h1>Daraz ${success ? 'connected' : 'authorization'}</h1><p>${safeMessage}</p>
<a href="/#settings" style="color:#93c5fd">Return to SupplierDesk</a></main>
<script>${success ? "if(window.opener){window.opener.postMessage({type:'supplierdesk-daraz-connected'},location.origin);window.close();}" : ''}</script>
</body></html>`);
});

app.post('/api/daraz/token', async (req: Request, res: Response) => {
  const user = await getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in before exchanging a Daraz authorization code.' });
  const code = String(req.body?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Authorization code is required.' });

  const cfg = await getCfg();
  if (!cfg.daraz_app_key || !cfg.daraz_secret) {
    return res.status(400).json({ error: 'Daraz application credentials have not been configured by an administrator.' });
  }
  try {
    const tokenResponse = await new DarazClient(cfg.daraz_app_key, cfg.daraz_secret).createToken(code);
    const store = await saveDarazTokenForUser(user.userId, tokenResponse);
    return res.json({ success: true, store, message: `Daraz store "${store.name}" connected successfully.` });
  } catch (err: any) {
    return res.status(400).json({ error: String(err?.message || 'Failed to exchange authorization code with Daraz.') });
  }
});

app.get('/export.csv', async (_req: Request, res: Response) => {
  const db = await loadDb();
  const rows = [
    ['source', 'supplier_sku', 'name', 'brand', 'cost_price', 'sell_price', 'in_stock', 'images', 'flags', 'url']
  ];

  for (const p of Object.values(db)) {
    rows.push([
      p.source || '',
      p.supplier_sku || '',
      `"${String(p.name || '').replace(/"/g, '""')}"`,
      `"${String(p.brand || '').replace(/"/g, '""')}"`,
      String(p.cost_price ?? ''),
      String(p.sell_price ?? ''),
      String(p.in_stock ?? ''),
      `"${(p.images || []).join(' | ').replace(/"/g, '""')}"`,
      `"${(p.flags || []).join('; ').replace(/"/g, '""')}"`,
      p.url || ''
    ]);
  }

  const csvContent = '\uFEFF' + rows.map(r => r.join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=products.csv');
  res.send(csvContent);
});

app.get('/export.json', async (_req: Request, res: Response) => {
  const db = await loadDb();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=products.json');
  res.send(JSON.stringify(Object.values(db), null, 2));
});

const PORT = Number(process.env.PORT) || 3000;
ensureDefaultUser();

if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Supplier Desk server running on http://0.0.0.0:${PORT}`);
  });
}

export default app;
