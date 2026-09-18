'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

/** 每一处 requestManifest(...) 调用里 expect 的内容。 */
function expectsOf(src) {
  const out = [];
  let at = src.indexOf('requestManifest(');
  while (at >= 0) {
    const call = src.slice(at, src.indexOf('})', at) + 2);
    const m = call.match(/expect:\s*\{([^}]*)\}/);
    out.push(m ? m[1] : null);
    at = src.indexOf('requestManifest(', at + 1);
  }
  return out;
}

/**
 * 按需取回的清单由 swarm 按白名单重建，名字只在调用方交了列表条目的片名时才以列表为准。
 * 调用方漏交的话，供片的人改一下清单里的名字（换成 .exe、或者和文件头对不上的扩展名），
 * 主进程校验就会拒收，这一部被记成「不安全」再也不接收 —— 一个改版客户端就能让全房收不了这部片。
 */
test('两端取清单时都把列表条目的片名交给 swarm', () => {
  for (const [label, src] of [
    ['桌面端', read('src', 'renderer', 'app.js')],
    ['安卓端', read('android', 'app', 'src', 'main', 'assets', 'js', 'app-android.js')],
  ]) {
    const expects = expectsOf(src);
    assert.ok(expects.length > 0, `${label}：没找到 requestManifest 调用，下面的断言会形同虚设`);
    for (const body of expects) {
      assert.ok(body, `${label}：requestManifest 调用没有 expect`);
      assert.match(body, /\bname: item\.name\b/, `${label}：expect 缺少片名 —— ${body.trim()}`);
      assert.match(body, /\bsize: item\.size\b/);
      assert.match(body, /\bchunkCount: item\.chunkCount\b/);
    }
  }
});

test('swarm 重建清单时名字以调用方给的列表片名为准', async () => {
  const src = read('src', 'renderer', 'lib', 'swarm.js');
  const fn = src.slice(src.indexOf('  _trustedManifestOf('), src.indexOf('\n  }\n', src.indexOf('  _trustedManifestOf(')));
  assert.ok(fn.length > 0, '找不到 _trustedManifestOf');
  assert.match(fn, /name: typeof expect\.name === 'string' && expect\.name \? expect\.name : manifest\.name/);
});
