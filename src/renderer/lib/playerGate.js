/**
 * 播放器代号闸门（桌面端专用，纯逻辑）。
 *
 * 主进程每拉起一次播放器就是新的一代（gen），tick / exit 都带着代号。主进程要等处理到
 * player:quit 才摘掉旧播放器的监听器，在那之前已经发出的 tick 仍会排在渲染进程的
 * 换片逻辑之后才被处理 —— 不按代号过滤的话，旧片的 tick 会被算到新片头上：
 * 迟到的 eof 以新 seq 再报一次放完（下一部被整部跳过），旧片的片长、字节位置写进
 * 新片的调度和卡顿判断。
 *
 * 规则：
 *  - launch 回包带回代号后，只收这一代的事件；
 *  - 换片、拦截、改做种等主动退播放器的时刻调 retire()：之前的每一代一律作废，
 *    在途的启动回包也凭票据认出自己已经作废；
 *  - 代号还没确认时先到的事件（回包和推送不保证先后）先按代号记下最后一条，
 *    确认后补上 —— mpv 暂停时片长、暂停状态只推这一次，丢了就补不回来。
 */

// 代号未确认时最多替几代记事件。正常只有「刚退的旧一代」和「正在起的新一代」两代。
const EARLY_LIMIT = 4;

export class PlayerGate {
  constructor() {
    this.gen = null; // 已确认的当前这一代
    this.epoch = 0; // 每次 retire() 加一，在途启动的票据据此作废
    this.early = new Map(); // gen -> { tick, exit }：代号确认之前先到的事件
  }

  /** 主动退播放器：之前的每一代都作废，在途的启动也作废。 */
  retire() {
    this.gen = null;
    this.epoch++;
    this.early.clear();
  }

  /** 开始拉起播放器，返回票据；回包时凭它确认。 */
  begin() {
    this.early.clear();
    return this.epoch;
  }

  /**
   * launch 回包。票据还有效就认下这一代，返回回包之前先到的那条 tick / exit（没有就是 null）；
   * 票据已作废（期间换了片或播放器被叫退）返回 null，调用方应当只退掉这一代。
   */
  confirm(gen, ticket) {
    if (ticket !== this.epoch || !Number.isInteger(gen)) return null;
    this.gen = gen;
    const early = this.early.get(gen) || {};
    this.early.clear();
    return { tick: early.tick || null, exit: early.exit || null };
  }

  /** 这条 tick 现在该不该处理。代号未确认时先记下，不处理。 */
  acceptTick(snap) {
    const gen = snap?.gen;
    if (this.gen !== null) return gen === this.gen;
    this._remember(gen, 'tick', snap);
    return false;
  }

  /** 这条 exit 现在该不该处理。认下的这一代退出后，闸门回到「没有播放器」。 */
  acceptExit(info) {
    const gen = info?.gen;
    if (this.gen !== null) {
      if (gen !== this.gen) return false;
      this.gen = null;
      return true;
    }
    this._remember(gen, 'exit', info);
    return false;
  }

  _remember(gen, kind, payload) {
    if (!Number.isInteger(gen)) return;
    const entry = this.early.get(gen) || {};
    entry[kind] = payload;
    this.early.delete(gen);
    this.early.set(gen, entry);
    while (this.early.size > EARLY_LIMIT) this.early.delete(this.early.keys().next().value);
  }
}
