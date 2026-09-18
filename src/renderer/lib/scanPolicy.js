/**
 * 扫描结果怎么处置（纯函数）。
 *
 * 「没扫完」和「扫出了东西」是两回事，处置正好相反：
 *  - 只有 blocked（真发现威胁）才销毁缓存 —— 也只有「留着这些字节本身就有害」配得上销毁。
 *  - 超时、被叫停、扫描器没跑起来、扫描器自己出错，文件都已经逐片 SHA-256 校验过，
 *    是完整且没被动过的；删掉它不提升任何安全性，只会让人把几十 GB 重下一遍。
 *  - 扫描器没跑起来（unavailable）在可信房间里记成 unscanned：那一场本来就是不等扫描就播的，
 *    扫不成没带来任何新信息。安全模式恰恰相反，它的全部承诺就是「扫过才放行」，
 *    所以记成没扫完（不放行，但文件留着，可以重新扫描）。
 */

/** 这几种状态不会再自动扫描：扫过了，或者已经确认扫不了。 */
export const SCAN_SETTLED = ['clean', 'blocked', 'unscanned'];
/** 这两种是「没扫完」，要用户点「重新扫描」才再来一遍。 */
export const SCAN_RESUMABLE = ['scan-timeout', 'scan-stopped'];

/**
 * @param {object} result 主进程 store:scanReceivedMedia 的结果 {ok, status, message}
 * @param {'safe'|'trusted'} mode 房间安全模式
 * @returns {{status:string, destroy:boolean, level:'good'|'warn'|'bad'}}
 */
export function decideScanOutcome(result, mode) {
  const r = result && typeof result === 'object' ? result : {};
  if (r.ok === true && r.status === 'clean') return { status: 'clean', destroy: false, level: 'good' };
  if (r.status === 'blocked') return { status: 'blocked', destroy: true, level: 'bad' };
  if (r.status === 'unavailable') {
    return mode === 'trusted'
      ? { status: 'unscanned', destroy: false, level: 'warn' }
      : { status: 'scan-timeout', destroy: false, level: 'bad' };
  }
  if (r.status === 'cancelled') return { status: 'scan-stopped', destroy: false, level: 'warn' };
  return { status: 'scan-timeout', destroy: false, level: 'warn' };
}

/** 这个状态现在该不该扫。force 是「重新扫描」按钮，只放行没扫完的两种，绕不过 blocked。 */
export function needsScan(status, { force = false } = {}) {
  if (status === 'scanning' || SCAN_SETTLED.includes(status)) return false;
  if (SCAN_RESUMABLE.includes(status)) return force === true;
  return true;
}

/**
 * 下一个该扫的片。一次只扫一部（大文件的扫描很吃盘），当前项永远排第一，其余按列表顺序。
 *
 * @param {Array<{key:string, current:boolean, order:number, status:string, complete:boolean, isSeeder:boolean}>} candidates
 * @returns {object|null}
 */
export function pickScanTarget(candidates) {
  const eligible = (candidates || []).filter((c) => c && c.complete === true && !c.isSeeder && needsScan(c.status));
  if (!eligible.length) return null;
  const current = eligible.find((c) => c.current === true);
  if (current) return current;
  return eligible.reduce((best, c) => (c.order < best.order ? c : best));
}

/**
 * 正在扫的片要不要给当前项让路：当前项收完了、需要扫，而占着扫描器的是别的片。
 */
export function shouldPreempt(running, target) {
  return !!running && !!target && target.current === true && running.key !== target.key;
}
