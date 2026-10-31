// 控制台身份令牌注册表（主管理一人一令牌）。
//
// 为什么单独拆出来：bridge.js 一 import 就会启动整个机器人，没法单测；而「令牌怎么存、
// 怎么读脏数据、怎么吊销」恰恰是最需要测的部分（写错了等于控制台对谁都开门）。
//
// 存储形态（state/admin-tokens.json）：
//   { "tokens": { "<sha256 hex>": { qq, name, role, createdAt, lastUsedAt } }, "updatedAt": 1700000000000 }
// 只存哈希：明文只在签发那一刻返回给界面，重启/重启后都拿不回——这正是我们要的。
//
// 读的一律 fail-closed：文件缺失、JSON 坏、条目脏 → 那一条（或整张表）直接不算数。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 明文令牌 → sha256 十六进制。 */
export function hashAdminToken(token) {
  return crypto.createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex');
}

/**
 * QQ 号规范化（存进注册表前统一成数字）。
 * 非法就 return null —— 这里不抛，因为注册表里出现脏数据是"跳过那一条"而不是"整表报废"。
 */
export function normalizeTokenQQ(value) {
  const s = String(value ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * 读注册表。
 * @param {string} file 注册表路径
 * @returns {Record<string, {qq:number,name:string,role:'owner',createdAt:number,lastUsedAt:number}>}
 */
export function readAdminTokenRegistry(file) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  const tokens = (raw && typeof raw === 'object' && raw.tokens && typeof raw.tokens === 'object' && !Array.isArray(raw.tokens))
    ? raw.tokens
    : {};
  const clean = {};
  for (const [hash, rec] of Object.entries(tokens)) {
    if (!/^[0-9a-f]{64}$/.test(hash)) continue;
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    const qq = normalizeTokenQQ(rec.qq);
    if (!qq) continue;
    clean[hash] = {
      qq,
      name: String(rec.name ?? '').slice(0, 40),
      // 目前只给主管理签发；字段留着是为了将来普通管理也能进只读面板时不改结构。
      role: rec.role === 'manager' ? 'manager' : 'owner',
      createdAt: Number(rec.createdAt) || 0,
      lastUsedAt: Number(rec.lastUsedAt) || 0
    };
  }
  return clean;
}

/** 原子写注册表（tmp → rename，跨盘/占用时退 copyFile）。 */
export function writeAdminTokenRegistry(file, tokens) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify({ tokens, updatedAt: Date.now() }, null, 2);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, payload, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.copyFileSync(tmp, file);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/**
 * 签发一个新令牌，返回 { token, record }。token 只在这里出现过一次。
 * @param {Record<string, object>} tokens 注册表（会被就地修改）
 * @param {{qq:number, name?:string, role?:'owner'|'manager'}} who
 */
export function issueAdminToken(tokens, who) {
  const token = crypto.randomBytes(24).toString('hex');
  const record = {
    qq: who.qq,
    name: String(who.name ?? '').slice(0, 40),
    role: who.role === 'manager' ? 'manager' : 'owner',
    createdAt: Date.now(),
    lastUsedAt: 0
  };
  tokens[hashAdminToken(token)] = record;
  return { token, record };
}

/** 吊销某个 QQ 的全部令牌，返回被删条数。 */
export function revokeAdminTokens(tokens, qq) {
  let removed = 0;
  for (const [hash, rec] of Object.entries(tokens)) {
    if (Number(rec.qq) === Number(qq)) {
      delete tokens[hash];
      removed += 1;
    }
  }
  return removed;
}

/** 注册表摘要（给控制台看，绝不带哈希的完整值以外的东西）。 */
export function describeAdminTokens(tokens) {
  return Object.entries(tokens).map(([hash, rec]) => ({
    qq: rec.qq,
    name: rec.name,
    role: rec.role,
    createdAt: rec.createdAt,
    lastUsedAt: rec.lastUsedAt,
    hash8: hash.slice(0, 8)
  }));
}
