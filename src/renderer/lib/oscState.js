/**
 * mpv 控制条（resources/mpv-scripts/noxreel-osc.lua）要画的东西里，能单独拿出来算的那几样。
 * 只有电脑端用：安卓用 ExoPlayer 自己的控件。
 */

/** 推给控制条的「已收到」最多几段。进度条一两千像素宽，再多也画不出区别。 */
export const MAX_OSC_RANGES = 32;

const round4 = (x) => Math.round(x * 10_000) / 10_000;

/**
 * 本机收到了哪几段，按占文件长度的比例给出 [起, 止]，按位置排好。
 *
 * 段数超过上限时把最窄的缝合并掉（两段之间只差几片，画出来本来就连成一片），
 * 合完还超（很多缝一样宽）就把尾巴上的几段并成一段。收完的、没有位图的返回空数组。
 * 四舍五入到万分之一：推给主进程的状态按 JSON 去重，零碎的小数会让它每片都变。
 *
 * @param {Uint8Array|number[]} have 分片位图（1 = 收到了）
 * @param {{size:number, chunkSize:number, chunkCount:number}} meta 清单里的尺寸信息
 */
export function haveRanges(have, meta, maxRanges = MAX_OSC_RANGES) {
  const size = meta?.size || 0;
  const chunkSize = meta?.chunkSize || 0;
  const count = meta?.chunkCount || 0;
  if (!have || !size || !chunkSize || !count || !(maxRanges >= 1)) return [];
  let runs = [];
  for (let i = 0; i < count; ) {
    if (!have[i]) {
      i++;
      continue;
    }
    const start = i;
    while (i < count && have[i]) i++;
    runs.push([start, i]);
  }
  if (runs.length > maxRanges) {
    const gaps = runs
      .slice(1)
      .map((r, k) => r[0] - runs[k][1])
      .sort((a, b) => a - b);
    const limit = gaps[runs.length - maxRanges - 1];
    const merged = [runs[0].slice()];
    for (const r of runs.slice(1)) {
      const last = merged[merged.length - 1];
      if (r[0] - last[1] <= limit) last[1] = r[1];
      else merged.push(r.slice());
    }
    if (merged.length > maxRanges) {
      const head = merged.slice(0, maxRanges - 1);
      head.push([merged[maxRanges - 1][0], merged[merged.length - 1][1]]);
      runs = head;
    } else runs = merged;
  }
  const frac = (chunk) => round4(Math.min(chunk * chunkSize, size) / size);
  return runs.map(([a, b]) => [frac(a), frac(b)]);
}
