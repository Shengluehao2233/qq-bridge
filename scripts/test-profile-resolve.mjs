// resolveProfile() 的回归：脚本按「实际使用的 profile」解析路径，而不是写死 profiles/web。
//
// 为什么需要这个文件
// ------------------
// 之前 scripts/ 里到处是 path.join(DSH_HOME, 'profiles/web/…')：一旦某个 home 的
// profile 不叫 web（自定义 profile 名、只有 default、或者根本没建 profile），
// 校验脚本就读不到真文件，报出一堆「配置缺失」式的假红 —— 排查方向直接被带偏。
//
// 这里把三条容易静默退化的规则固定下来：
//   ① 显式 DSH_PROFILE 只在目录确实存在时生效（agent 自己的 shell 常带着
//      DSH_PROFILE=desktop，直接信任会把路径指到别的 home 里不存在的目录）；
//   ② 没有显式指定时优先 web，其次 default；
//   ③ 一个都不存在时返回 exists=false，调用方应跳过断言而不是去读不存在的路径。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProfile } from './dsh-modules.mjs';

function makeHome(profiles) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-profile-resolve-'));
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true });
  for (const name of profiles) fs.mkdirSync(path.join(home, 'profiles', name), { recursive: true });
  return home;
}

function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[name] = previous;
    else delete process.env[name];
  }
}

test('显式 DSH_PROFILE 指向已存在的 profile 时优先生效', () => {
  const home = makeHome(['web', 'custom']);
  withEnv('DSH_PROFILE', 'custom', () => {
    assert.deepEqual(resolveProfile(home), { name: 'custom', exists: true });
  });
});

test('显式 DSH_PROFILE 指向不存在的目录时回退到 web', () => {
  // 真实场景：agent 的 shell 里带着 DSH_PROFILE=desktop，但 DSH_HOME 指的是 QQ 侧 home，
  // 那里的 profile 叫 web。直接信任 desktop 会让脚本去读 profiles/desktop/… 然后报配置缺失。
  const home = makeHome(['web']);
  withEnv('DSH_PROFILE', 'desktop', () => {
    assert.deepEqual(resolveProfile(home), { name: 'web', exists: true });
  });
});

test('没有 web 时回退到 default', () => {
  const home = makeHome(['default']);
  withEnv('DSH_PROFILE', undefined, () => {
    assert.deepEqual(resolveProfile(home), { name: 'default', exists: true });
  });
});

test('只有非标准名的单个 profile 时直接用它', () => {
  const home = makeHome(['qqprod']);
  withEnv('DSH_PROFILE', undefined, () => {
    assert.deepEqual(resolveProfile(home), { name: 'qqprod', exists: true });
  });
});

test('一个 profile 都没有时返回 exists=false 而不是抛错', () => {
  const home = makeHome([]);
  withEnv('DSH_PROFILE', undefined, () => {
    const result = resolveProfile(home);
    assert.equal(result.exists, false);
    assert.equal(typeof result.name, 'string');
  });
});

test('profiles 目录整体不存在时也返回 exists=false', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-profile-resolve-empty-'));
  withEnv('DSH_PROFILE', undefined, () => {
    assert.equal(resolveProfile(home).exists, false);
  });
});
