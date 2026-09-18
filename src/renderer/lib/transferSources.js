/**
 * 传输来源的补充判断（桌面端编排层用，纯函数，只读 swarm 的状态）。
 *
 * swarm.canFinish 问的是「我缺的每一片是不是都有人有」，用来挑能收齐的那一部。
 * 完整片源离开后，大家手里往往只剩一段片头：canFinish 为假，但当前这部还能从别人那里
 * 接着补 —— 可信房间边下边播，多补一段就能多看一段。这里回答的是「还有没有人能给我至少一片」。
 */

/**
 * 有没有已认证的成员手里有本机还缺的片（至少一片）。
 * 本机还没挂这一部（没有会话）时，谁手里有任何一片都算。
 */
export function hasAnyMissing(swarm, slot) {
  if (!swarm) return false;
  const ctx = swarm.files?.get(slot) || null;
  if (ctx?.complete || ctx?.isSeeder) return false;
  const have = ctx?.have || null;
  for (const p of swarm.peers?.values() || []) {
    const remote = p.authenticated ? p.remote?.get(slot) : null;
    if (!remote) continue;
    const theirs = remote.have;
    if (remote.full) {
      if (!have) return true;
      for (let i = 0; i < have.length; i++) if (have[i] !== 1) return true;
      continue;
    }
    for (let i = 0; i < theirs.length; i++) {
      if (theirs[i] === 1 && have?.[i] !== 1) return true;
    }
  }
  return false;
}
