-- NoxReel 的播放器控制条，替掉 mpv 自带的 osc.lua（主进程启动时带 --osc=no 和 --script=本文件）。
--
-- 为什么自己画：自带控制条能调的只有颜色和几个尺寸，房间里的事（在等谁缓冲、和房主差多少、
-- 收到了哪几段、弹幕开没开）它画不出来；全屏看片时 NoxReel 的主窗口整个看不见，这些只能画在这里。
--
-- 怎么画：一个 osd 覆盖层（ass-events），全部用 ASS 矢量绘图。样子照着苹果的 Liquid Glass：圆角玻璃面板、
-- 胶囊形的小件、会弹的动效。真正的毛玻璃（把身后的画面模糊掉）libass 画不出来，玻璃是几层叠出来的近似
-- （见 glass）。图标也是画出来的：libass 会把画出来的路径自动闭合，线条一律画成「去程 + 原路返回」的
-- 零面积路径再描边（见 stroke_event）。
-- 尺寸按屏幕缩放比例（display-hidpi-scale）定，不跟着窗口大小缩放：窗口开小了控件照样看得清。
--
-- 和 NoxReel 怎么说话：
--   主进程 → 这里：script-message-to noxreel_osc noxreel-state <json>          房间状态，见 apply_state
--                  script-message-to noxreel_osc noxreel-toast <文字> <毫秒> <语气> 顶部的提示条
--   这里 → 主进程：script-message noxreel-osc ready | danmaku | quality <高度> | fallback
--                  script-message noxreel-sync（同步到房主，和聊天脚本里的 Ctrl+Shift+S 是同一条）
-- 播放、暂停、跳转、音量、字幕、音轨直接改 mpv 的属性，同步引擎照旧从属性变化里看出来。
--
-- 画不出来就退回自带控制条（mpv 太老、缺接口、画的时候出了错），不能让用户连暂停键都没有。

local mp = require 'mp'
local msg = require 'mp.msg'
local utils = require 'mp.utils'
local options = require 'mp.options'

local opts = {
  font = 'Microsoft YaHei UI',
  -- 在屏幕缩放比例之上再乘的系数
  scale = 1,
  -- 鼠标不动多久收起控件（毫秒）
  hide_ms = 1600,
  -- 控件收起时底边那条进度细线画不画（设置里的「播放器底部进度线」）；房间里推来的状态里有 miniBar 时以那个为准
  mini_bar = true,
  -- 开发期的自动化测试用：把画好的内容放进 user-data，没有窗口时按这个尺寸排版（如 1280x720）
  debug = false,
  debug_size = '',
}
options.read_options(opts, 'noxreel_osc')

local MESSAGE = 'noxreel-osc'
local SYNC_MESSAGE = 'noxreel-sync'
-- compute_bounds、user-data、title-bar 这些都要够新的 mpv
local MIN_MAJOR, MIN_MINOR = 0, 37

local function version_ok()
  local v = mp.get_property('mpv-version', '') or ''
  local major, minor = v:match('(%d+)%.(%d+)')
  major, minor = tonumber(major), tonumber(minor)
  if not major or not minor then return false end
  if major ~= MIN_MAJOR then return major > MIN_MAJOR end
  return minor >= MIN_MINOR
end

local function apis_ok()
  return type(mp.create_osd_overlay) == 'function'
    and type(mp.set_mouse_area) == 'function'
    and type(mp.get_mouse_pos) == 'function'
    and type(mp.get_osd_size) == 'function'
    and type(mp.set_key_bindings) == 'function'
    and type(mp.enable_key_bindings) == 'function'
    and type(utils.parse_json) == 'function'
end

local SECTIONS = { 'nx-showhide', 'nx-bottom', 'nx-wc', 'nx-pill' }
-- 画没画得出来（ready / fallback）也写进这个属性：主进程的 IPC 要在 mpv 起来约 100ms 后才连上，
-- 脚本加载时发的那一声 script-message 它收不到（实测 28 次全丢）；属性它连上后订阅一下就看得到
local STATUS_PROP = 'user-data/noxreel_osc/status'
local overlay = nil
local measurer = nil
local fell_back = false
-- 所有定时器（转圈、渐变、显示检查）都登记在这里，退回自带控制条时一起停掉
local timers = {}
-- 我们加的键位（快捷键、菜单和一览开着时的强制键）的名字，退回时一起摘掉
local bound_keys = { 'nx-menu-esc', 'nx-menu-up', 'nx-menu-down', 'nx-menu-enter', 'nx-menu-kpenter', 'nx-help-esc' }

-- 退回自带控制条。主进程开 mpv 时已经把自带控制条的配色、布局写进了 script-opts，这里只要把它打开，
-- 再把我们改过的 OSD 设置还原回去。
local function fall_back(reason)
  if fell_back then return end
  fell_back = true
  msg.warn('NoxReel 控制条停用，退回 mpv 自带的：' .. tostring(reason))
  for _, t in pairs(timers) do pcall(function() t:kill() end) end
  for _, name in ipairs(SECTIONS) do pcall(mp.disable_key_bindings, name) end
  -- 菜单、快捷键一览开着时加的强制键（不摘的话全屏里按 ESC 退不出来），以及我们改过的快捷键：
  -- 全摘掉，mpv 自带的键位原样回来
  for _, name in ipairs(bound_keys) do pcall(mp.remove_key_binding, name) end
  if overlay then pcall(function() overlay:remove() end) end
  pcall(mp.set_property_native, 'user-data/osc/margins', { l = 0, r = 0, t = 0, b = 0 })
  pcall(mp.set_property_number, 'osd-level', 1)
  pcall(mp.set_property, 'osd-on-seek', 'msg-bar')
  pcall(mp.set_property_bool, 'osc', true)
  pcall(mp.set_property_native, STATUS_PROP, 'fallback')
  pcall(mp.commandv, 'script-message', MESSAGE, 'fallback')
end

if not version_ok() or not apis_ok() then
  fall_back('mpv 版本太老（需要 0.37 以上）')
  return
end

-- 事件回调一律包一层：出错就退回自带控制条，而不是留下一个画了一半、点不动的界面
local function guard(fn)
  return function(...)
    if fell_back then return end
    local ok, err = pcall(fn, ...)
    if not ok then fall_back(err) end
  end
end

--------------------------------------------------------------------------------
-- 颜色、文字
--------------------------------------------------------------------------------

local C = {
  -- 玻璃的底色：面板、按钮旁的小件用 GLASS_OP 的不透明度，菜单、卡片这种要读一堆字的用 DEEP_OP
  glass = '121722',
  deep = '0E121B',
  text = 'F2F5F9',
  body = 'E6EDF3',
  sub = 'A8B3C2',
  dim = '8E9AAB',
  faint = '7D8898',
  accent = '4C8DFF',
  accentText = '7FAEFF',
  manual = '8AB4FF',
  ok = '3FB950',
  warn = 'D29922',
  host = 'F2B84B',
  hostText = '1F1500',
  mark = 'E3B341',
  boost = 'FFB547',
  danger = 'C42B1C',
  white = 'FFFFFF',
  black = '000000',
}
local GLASS_OP = 0.5
local DEEP_OP = 0.8

-- 界面上的字。NoxReel 按界面语言整份推过来（state.labels），没推的用这里的
local DEFAULT_LABELS = {
  play = '播放',
  pause = '暂停',
  back = '后退 10 秒',
  fwd = '前进 10 秒',
  mute = '静音',
  unmute = '取消静音',
  danmakuOn = '关闭弹幕',
  danmakuOff = '打开弹幕',
  subs = '字幕',
  subsOff = '关闭字幕',
  noSubs = '这一部没有字幕',
  audio = '音轨',
  noAudio = '只有一条音轨',
  fullscreen = '全屏',
  exitFullscreen = '退出全屏',
  minimize = '最小化',
  maximize = '最大化',
  restore = '还原',
  close = '关闭',
  quality = '清晰度',
  qualityNote = '只影响你自己',
  opening = '正在打开…',
  buffering = '正在缓冲',
  guestSeek = '游客不能跳转进度',
  volume = '音量',
  muted = '已静音',
  boost = '增益',
  speed = '倍速',
  track = '轨道',
  host = '房主',
  -- 快捷键（见「快捷键」一节和 ? 键的一览）
  keySpace = '空格',
  keyHold = '长按 →',
  speedHold = '2 倍速快进中',
  speedHoldNote = '全房跟着一起快进',
  noSpeed = '一起看时不能改倍速，长按 → 可以临时 2 倍速快进',
  danmakuShown = '弹幕已打开',
  danmakuHidden = '弹幕已关闭',
  inSync = '已经和房主同步',
  helpTitle = '快捷键',
  helpNote = '跳转、快进会同步给全房；游客只能暂停自己',
  hPlay = '播放 / 暂停',
  hSeek = '后退 / 前进 5 秒',
  hHold = '2 倍速快进，松开恢复',
  hSeekLong = '后退 / 前进 30 秒',
  hVolume = '音量',
  hMute = '静音',
  hFullscreen = '全屏 / 退出全屏',
  hChapter = '上一章 / 下一章',
  hSend = '发弹幕',
  hToggleDanmaku = '开关弹幕',
  hSync = '同步到房主',
  hSubs = '选字幕',
  hAudio = '选音轨',
  hProgress = '看一眼进度',
  hHelp = '快捷键一览',
  hClose = '关闭播放器',
  -- 本机字幕、共享标记、表情反应
  loadSub = '加载本机字幕…',
  react = '发表情',
  markTip = '点一下跳到这里',
  hReact = '发表情',
  hMark = '标记这一刻',
  hMarkNote = '标记这一刻并写一句',
}

-- 快捷键一览：{键, 说明的 label}。键名不翻译，「空格」「长按 →」除外（@ 开头的换成 label）
local HELP_ROWS = {
  { '@keySpace', 'hPlay' },
  { '← →', 'hSeek' },
  { '@keyHold', 'hHold' },
  { 'Shift + ← →', 'hSeekLong' },
  { '↑ ↓', 'hVolume' },
  { 'M', 'hMute' },
  { 'Enter / F', 'hFullscreen' },
  { 'PgUp PgDn', 'hChapter' },
  { 'D', 'hSend' },
  { 'B', 'hToggleDanmaku' },
  { 'S', 'hSync' },
  { 'C', 'hSubs' },
  { 'A', 'hAudio' },
  { '1 – 8', 'hReact' },
  { 'K', 'hMark' },
  { 'Shift + K', 'hMarkNote' },
  { 'O', 'hProgress' },
  { '? / F1', 'hHelp' },
  { 'Q', 'hClose' },
}

-- 表情反应（和 lib/moments.js 的 REACTIONS 同一个顺序）。libass 画出来是单色线条字形，按颜色区分
local REACTIONS = { '❤', '😂', '😮', '😭', '👍', '👏', '🔥', '🎉' }
local REACTION_COLORS = { 'FF5A6E', 'FFD23F', 'FFD23F', '6FB8FF', 'FFD23F', 'FFD23F', 'FF8A3D', 'C792FF' }
-- 一个表情飘多久（秒）、同时最多飘几个
local REACTION_S = 2.6
local MAX_REACTIONS = 24

local function bgr(hex)
  return hex:sub(5, 6) .. hex:sub(3, 4) .. hex:sub(1, 2)
end

local function clamp(v, lo, hi)
  if v < lo then return lo end
  if v > hi then return hi end
  return v
end

-- 不透明度（0–1）换成 ASS 的 alpha：00 是完全不透明，FF 是全透明
local function alpha(op)
  return string.format('%02X', math.floor((1 - clamp(op, 0, 1)) * 255 + 0.5))
end

-- 拼进 ASS 的文字：花括号是样式覆盖块、反斜杠是转义引导符，一律丢掉（和主进程 escapeAss 同一个做法）；
-- 控制字符换成空格，换行只能由我们自己插
local function esc(s)
  s = tostring(s or '')
  s = s:gsub('[\\{}]', '')
  s = s:gsub('%c', ' ')
  return s
end

-- 按 UTF-8 拆成一个个字
local function chars(s)
  local out = {}
  for ch in tostring(s or ''):gmatch('[\1-\127\194-\244][\128-\191]*') do out[#out + 1] = ch end
  return out
end

local function fmt_time(sec, hours)
  if type(sec) ~= 'number' or sec ~= sec or sec < 0 then sec = 0 end
  sec = math.floor(sec)
  local h = math.floor(sec / 3600)
  local m = math.floor((sec % 3600) / 60)
  local s = sec % 60
  if hours or h > 0 then return string.format('%d:%02d:%02d', h, m, s) end
  return string.format('%d:%02d', m, s)
end

--------------------------------------------------------------------------------
-- 画图的小工具。坐标都是虚拟单位（按屏幕缩放比例折算过的像素），画的时候用 \p3（×4）保留小数
--------------------------------------------------------------------------------

local events = {}

local function push(s)
  events[#events + 1] = s
end

local function n(v)
  return math.floor(v * 4 + 0.5)
end

local function head(extra)
  return '{\\an7\\pos(0,0)\\bord0\\shad0' .. (extra or '')
end

-- 圆角矩形的路径。ccw 为真时逆时针走：libass 按非零环绕填充，挖洞要反着走
local function rr_path(x0, y0, x1, y1, r, ccw)
  r = math.max(0, math.min(r or 0, (x1 - x0) / 2, (y1 - y0) / 2))
  if ccw then
    if r <= 0 then
      return string.format('m %d %d l %d %d l %d %d l %d %d', n(x0), n(y0), n(x0), n(y1), n(x1), n(y1), n(x1), n(y0))
    end
    local k = 0.5523 * r
    return string.format(
      'm %d %d b %d %d %d %d %d %d l %d %d b %d %d %d %d %d %d l %d %d b %d %d %d %d %d %d l %d %d b %d %d %d %d %d %d l %d %d',
      n(x0 + r), n(y0),
      n(x0 + r - k), n(y0), n(x0), n(y0 + r - k), n(x0), n(y0 + r),
      n(x0), n(y1 - r),
      n(x0), n(y1 - r + k), n(x0 + r - k), n(y1), n(x0 + r), n(y1),
      n(x1 - r), n(y1),
      n(x1 - r + k), n(y1), n(x1), n(y1 - r + k), n(x1), n(y1 - r),
      n(x1), n(y0 + r),
      n(x1), n(y0 + r - k), n(x1 - r + k), n(y0), n(x1 - r), n(y0),
      n(x0 + r), n(y0)
    )
  end
  if r <= 0 then
    return string.format('m %d %d l %d %d l %d %d l %d %d', n(x0), n(y0), n(x1), n(y0), n(x1), n(y1), n(x0), n(y1))
  end
  local k = 0.5523 * r
  return string.format(
    'm %d %d l %d %d b %d %d %d %d %d %d l %d %d b %d %d %d %d %d %d l %d %d b %d %d %d %d %d %d l %d %d b %d %d %d %d %d %d',
    n(x0 + r), n(y0), n(x1 - r), n(y0),
    n(x1 - r + k), n(y0), n(x1), n(y0 + r - k), n(x1), n(y0 + r),
    n(x1), n(y1 - r),
    n(x1), n(y1 - r + k), n(x1 - r + k), n(y1), n(x1 - r), n(y1),
    n(x0 + r), n(y1),
    n(x0 + r - k), n(y1), n(x0), n(y1 - r + k), n(x0), n(y1 - r),
    n(x0), n(y0 + r),
    n(x0), n(y0 + r - k), n(x0 + r - k), n(y0), n(x0 + r), n(y0)
  )
end

-- 实心的圆角矩形。extra 是放在 \p 之前的额外样式（\blur 之类）
local function fill_rect(x0, y0, x1, y1, r, color, op, extra)
  if op <= 0 or x1 <= x0 or y1 <= y0 then return end
  push(head(string.format('\\1c&H%s&\\1a&H%s&%s\\p3}', bgr(color), alpha(op), extra or '')) .. rr_path(x0, y0, x1, y1, r) .. '{\\p0}')
end

-- 圆角矩形的边框：外圈顺时针、内圈逆时针，中间挖空。线宽和位置都准，不靠 libass 的描边
local function ring_rect(x0, y0, x1, y1, r, width, color, op, extra)
  if op <= 0 then return end
  push(
    head(string.format('\\1c&H%s&\\1a&H%s&%s\\p3}', bgr(color), alpha(op), extra or ''))
      .. rr_path(x0, y0, x1, y1, r)
      .. ' '
      .. rr_path(x0 + width, y0 + width, x1 - width, y1 - width, math.max(0, r - width), true)
      .. '{\\p0}'
  )
end

local function circle(cx, cy, r, color, op, extra)
  fill_rect(cx - r, cy - r, cx + r, cy + r, r, color, op, extra)
end

-- 裁剪：只画矩形里面的部分；按圆角矩形的形状裁（inverse 为真时反过来，只画形状外面的）
local function clip_rect(x0, y0, x1, y1)
  return string.format('\\clip(%d,%d,%d,%d)', math.floor(x0), math.floor(y0), math.ceil(x1), math.ceil(y1))
end

local function clip_shape(x0, y0, x1, y1, r, inverse)
  return (inverse and '\\iclip(3,' or '\\clip(3,') .. rr_path(x0, y0, x1, y1, r) .. ')'
end

-- 玻璃。真正的 Liquid Glass 靠把身后的画面模糊、折射，libass 做不到；画得出的是这几层：
-- 投影（挖掉面板底下那块，不然面板中间被压暗）、半透明底色、顶部往下淡出的一层高光（按形状裁）、
-- 一圈细边、顶边一道更亮的光。op 乘在每一层上（控件淡入淡出用）。
-- o：base / base_op 底色，rim / rim_op 细边（用颜色表示语气），glow / glow_op 外面一圈光，shadow 投影浓度
local function glass(x0, y0, x1, y1, r, op, o)
  if op <= 0 or x1 <= x0 or y1 <= y0 then return end
  o = o or {}
  local h = y1 - y0
  r = math.min(r, h / 2, (x1 - x0) / 2)
  local shadow = o.shadow or 0.34
  if shadow > 0 then
    local dy = math.min(10, h * 0.15 + 2)
    fill_rect(x0, y0 + dy, x1, y1 + dy, r, C.black, shadow * op,
      string.format('\\blur%.1f', math.min(16, h * 0.2 + 4)) .. clip_shape(x0, y0, x1, y1, r, true))
  end
  if o.glow then
    fill_rect(x0, y0, x1, y1, r, o.glow, (o.glow_op or 0.3) * op, '\\blur10' .. clip_shape(x0, y0, x1, y1, r, true))
  end
  fill_rect(x0, y0, x1, y1, r, o.base or C.glass, (o.base_op or GLASS_OP) * op)
  -- 高光带最多 30 高：卡片、一览这种高的玻璃上整块发白就不像玻璃了
  fill_rect(x0, y0 - math.min(h * 0.2, 20), x1, y0 + math.min(h * 0.32, 30), 0, C.white, 0.09 * op,
    string.format('\\blur%.1f', math.min(h * 0.16, 14)) .. clip_shape(x0, y0, x1, y1, r))
  ring_rect(x0, y0, x1, y1, r, 1, o.rim or C.white, (o.rim_op or 0.09) * op)
  ring_rect(x0, y0, x1, y1, r, 1, C.white, 0.22 * op, clip_rect(x0, y0, x1, y0 + math.max(3, r * 0.5)))
end

-- 按钮底下那颗玻璃珠（悬停、按下、展开的音量胶囊）：比面板亮一层，顶边一道光
local function bead(x0, y0, x1, y1, r, op, fill_op, top_op)
  if op <= 0 then return end
  fill_rect(x0, y0, x1, y1, r, C.white, (fill_op or 0.12) * op)
  ring_rect(x0, y0, x1, y1, r, 1, C.white, 0.08 * op)
  ring_rect(x0, y0, x1, y1, r, 1, C.white, (top_op or 0.24) * op, clip_rect(x0, y0, x1, y0 + math.max(3, r * 0.5)))
end

local function text(x, y, an, size, color, op, str, bold, extra)
  if op <= 0 or str == nil or str == '' then return end
  push(string.format(
    '{\\an%d\\pos(%.2f,%.2f)\\fn%s\\fs%.1f\\b%d\\q2\\bord0\\shad0\\1c&H%s&\\1a&H%s&%s}%s',
    an, x, y, opts.font, size, bold and 1 or 0, bgr(color), alpha(op), extra or '', esc(str)
  ))
end

-- 同一行里几段不同颜色的字：runs = { {颜色, 文字}, ... }
local function text_runs(x, y, an, size, op, runs, bold)
  if op <= 0 then return end
  local parts = { string.format(
    '{\\an%d\\pos(%.2f,%.2f)\\fn%s\\fs%.1f\\b%d\\q2\\bord0\\shad0\\1a&H%s&}',
    an, x, y, opts.font, size, bold and 1 or 0, alpha(op)
  ) }
  for _, r in ipairs(runs) do parts[#parts + 1] = string.format('{\\1c&H%s&}', bgr(r[1])) .. esc(r[2]) end
  push(table.concat(parts))
end

-- 路径：{ x, y, {'l', x, y}, {'b', x1, y1, x2, y2, x3, y3}, ... }，一条路径一个起点
local function path_string(p, ox, oy, k, reverse_too)
  local function pt(x, y) return string.format('%d %d', n(ox + x * k), n(oy + y * k)) end
  local parts = { 'm ' .. pt(p[1], p[2]) }
  local ends = { { p[1], p[2] } }
  for i = 3, #p do
    local s = p[i]
    if s[1] == 'l' then
      parts[#parts + 1] = 'l ' .. pt(s[2], s[3])
      ends[#ends + 1] = { s[2], s[3] }
    else
      parts[#parts + 1] = 'b ' .. pt(s[2], s[3]) .. ' ' .. pt(s[4], s[5]) .. ' ' .. pt(s[6], s[7])
      ends[#ends + 1] = { s[6], s[7] }
    end
  end
  if reverse_too then
    -- 原路返回：把每一段倒过来走（贝塞尔的两个控制点对调）
    for i = #p, 3, -1 do
      local s = p[i]
      local back = ends[i - 2]
      if s[1] == 'l' then
        parts[#parts + 1] = 'l ' .. pt(back[1], back[2])
      else
        parts[#parts + 1] = 'b ' .. pt(s[4], s[5]) .. ' ' .. pt(s[2], s[3]) .. ' ' .. pt(back[1], back[2])
      end
    end
  end
  return table.concat(parts, ' ')
end

-- 一组线条。libass 会把画出来的路径自动闭合，所以每条都画成「去程 + 原路返回」的零面积路径再描边
local function stroke_event(paths, ox, oy, k, width, color, op)
  if op <= 0 or #paths == 0 then return end
  local body = {}
  for _, p in ipairs(paths) do body[#body + 1] = path_string(p, ox, oy, k, true) end
  push('{\\an7\\pos(0,0)\\shad0\\bord' .. string.format('%.2f', width / 2)
    .. string.format('\\1a&HFF&\\3c&H%s&\\3a&H%s&\\p3}', bgr(color), alpha(op))
    .. table.concat(body, ' ') .. '{\\p0}')
end

local function fill_event(paths, ox, oy, k, color, op, round)
  if op <= 0 or #paths == 0 then return end
  local body = {}
  for _, p in ipairs(paths) do body[#body + 1] = path_string(p, ox, oy, k, false) end
  local bord = round and round > 0 and string.format('\\bord%.2f\\3c&H%s&\\3a&H%s&', round * k, bgr(color), alpha(op)) or ''
  push(head(string.format('\\1c&H%s&\\1a&H%s&%s\\p3}', bgr(color), alpha(op), bord)) .. table.concat(body, ' ') .. '{\\p0}')
end

-- 圆弧（角度按屏幕坐标：0 在右边，90 在下边），拆成不超过 90 度的几段贝塞尔
local function arc(p, cx, cy, r, a0, a1)
  local steps = math.max(1, math.ceil(math.abs(a1 - a0) / 90))
  local step = (a1 - a0) / steps
  local rad = math.pi / 180
  for i = 0, steps - 1 do
    local t1 = (a0 + step * i) * rad
    local t2 = (a0 + step * (i + 1)) * rad
    local kk = 4 / 3 * math.tan((t2 - t1) / 4)
    local x1, y1 = math.cos(t1), math.sin(t1)
    local x2, y2 = math.cos(t2), math.sin(t2)
    p[#p + 1] = {
      'b',
      cx + r * (x1 - kk * y1), cy + r * (y1 + kk * x1),
      cx + r * (x2 + kk * y2), cy + r * (y2 - kk * x2),
      cx + r * x2, cy + r * y2,
    }
  end
  return p
end

local function arc_path(cx, cy, r, a0, a1)
  local rad = math.pi / 180
  return arc({ cx + r * math.cos(a0 * rad), cy + r * math.sin(a0 * rad) }, cx, cy, r, a0, a1)
end

local function with_line(p, x, y)
  p[#p + 1] = { 'l', x, y }
  return p
end

local function poly(...)
  local pts = { ... }
  local p = { pts[1], pts[2] }
  for i = 3, #pts, 2 do p[#p + 1] = { 'l', pts[i], pts[i + 1] } end
  return p
end

local function rr_sub(x0, y0, x1, y1, r)
  local k = 0.5523 * r
  return {
    x0 + r, y0,
    { 'l', x1 - r, y0 }, { 'b', x1 - r + k, y0, x1, y0 + r - k, x1, y0 + r },
    { 'l', x1, y1 - r }, { 'b', x1, y1 - r + k, x1 - r + k, y1, x1 - r, y1 },
    { 'l', x0 + r, y1 }, { 'b', x0 + r - k, y1, x0, y1 - r + k, x0, y1 - r },
    { 'l', x0, y0 + r }, { 'b', x0, y0 + r - k, x0 + r - k, y0, x0 + r, y0 },
  }
end

-- 图标都画在 24×24 的格子里（和设计稿的 SVG 一样）。stroke 是线条（线宽按格子算），fill 是实心
local ICONS = {
  play = { fill = { poly(8.6, 5.8, 18.8, 12, 8.6, 18.2) }, round = 1.3 },
  pause = { fill = { rr_sub(6, 5, 10.2, 19, 1.2), rr_sub(13.8, 5, 18, 19, 1.2) } },
  back = { stroke = { with_line(arc_path(12, 12, 9, 180, -135), 3, 8), poly(3, 3, 3, 8, 8, 8) } },
  fwd = { stroke = { with_line(arc_path(12, 12, 9, 0, 315), 21, 8), poly(21, 3, 21, 8, 16, 8) } },
  speaker = { fill = { poly(3, 9, 6.5, 9, 11, 5, 11, 19, 6.5, 15, 3, 15) }, round = 0.8 },
  wave1 = { stroke = { arc_path(11, 12, 4.5, -48, 48) } },
  wave2 = { stroke = { arc_path(11, 12, 8.2, -52, 52) } },
  wave3 = { stroke = { arc_path(11, 12, 11.6, -54, 54) } },
  muteX = { stroke = { poly(15.5, 9.5, 20.5, 14.5), poly(20.5, 9.5, 15.5, 14.5) } },
  captions = { stroke = { rr_sub(3, 5, 21, 19, 3), poly(7, 15, 11, 15), poly(14, 15, 17, 15), poly(7, 11, 9, 11), poly(12, 11, 17, 11) } },
  audio = { stroke = { poly(3, 10, 3, 14), poly(7, 6.5, 7, 17.5), poly(11, 3.5, 11, 20.5), poly(15, 8, 15, 16), poly(19, 5.5, 19, 18.5) } },
  fullscreen = { stroke = {
    { 8, 3, { 'l', 5, 3 }, { 'b', 3.9, 3, 3, 3.9, 3, 5 }, { 'l', 3, 8 } },
    { 21, 8, { 'l', 21, 5 }, { 'b', 21, 3.9, 20.1, 3, 19, 3 }, { 'l', 16, 3 } },
    { 3, 16, { 'l', 3, 19 }, { 'b', 3, 20.1, 3.9, 21, 5, 21 }, { 'l', 8, 21 } },
    { 16, 21, { 'l', 19, 21 }, { 'b', 20.1, 21, 21, 20.1, 21, 19 }, { 'l', 21, 16 } },
  } },
  unfullscreen = { stroke = {
    { 8, 3, { 'l', 8, 6 }, { 'b', 8, 7.1, 7.1, 8, 6, 8 }, { 'l', 3, 8 } },
    { 21, 8, { 'l', 18, 8 }, { 'b', 16.9, 8, 16, 7.1, 16, 6 }, { 'l', 16, 3 } },
    { 3, 16, { 'l', 6, 16 }, { 'b', 7.1, 16, 8, 16.9, 8, 18 }, { 'l', 8, 21 } },
    { 16, 21, { 'l', 16, 18 }, { 'b', 16, 16.9, 16.9, 16, 18, 16 }, { 'l', 21, 16 } },
  } },
  chevronUp = { stroke = { poly(6, 15, 12, 9, 18, 15) } },
  ffwd = { fill = { poly(4, 6, 12, 12, 4, 18), poly(12, 6, 20, 12, 12, 18) }, round = 1 },
  check = { stroke = { poly(20, 6, 9, 17, 4, 12) } },
  smile = { stroke = { arc_path(12, 12, 9, 0, 360), arc_path(12, 12, 5, 25, 155), poly(9, 9.6, 9, 10.4), poly(15, 9.6, 15, 10.4) } },
  sync = { stroke = {
    with_line(arc_path(12, 12, 9, 180, 315), 21, 8), poly(21, 3, 21, 8, 16, 8),
    with_line(arc_path(12, 12, 9, 0, 135), 3, 16), poly(3, 21, 3, 16, 8, 16),
  } },
  shield = { stroke = {
    { 12, 2.8, { 'l', 19.5, 5.6 }, { 'l', 19.5, 12 }, { 'b', 19.5, 16.8, 16.2, 19.6, 12, 21.2 },
      { 'b', 7.8, 19.6, 4.5, 16.8, 4.5, 12 }, { 'l', 4.5, 5.6 }, { 'l', 12, 2.8 } },
    poly(9, 12, 11, 14, 15, 10),
  } },
  warning = { stroke = { poly(12, 3.5, 21.5, 20, 2.5, 20, 12, 3.5), poly(12, 10, 12, 14), poly(12, 17, 12, 17.05) } },
  winMin = { stroke = { poly(6.5, 12, 17.5, 12) } },
  winMax = { stroke = { rr_sub(6.5, 6.5, 17.5, 17.5, 1.6) } },
  winRestore = { stroke = { rr_sub(6.5, 8.5, 15.5, 17.5, 1.4), { 9, 6.5, { 'l', 16, 6.5 }, { 'b', 16.8, 6.5, 17.5, 7.2, 17.5, 8 }, { 'l', 17.5, 15 } } } },
  winClose = { stroke = { poly(6.5, 6.5, 17.5, 17.5), poly(17.5, 6.5, 6.5, 17.5) } },
}

local function icon(name, cx, cy, size, color, op, stroke_width)
  local def = ICONS[name]
  if not def or op <= 0 then return end
  local k = size / 24
  local ox, oy = cx - 12 * k, cy - 12 * k
  if def.fill then fill_event(def.fill, ox, oy, k, color, op, def.round) end
  if def.stroke then stroke_event(def.stroke, ox, oy, k, (stroke_width or 1.75) * k, color, op) end
end

--------------------------------------------------------------------------------
-- 量字宽：用一个不显示的覆盖层让 mpv 算出排版后的边界（compute_bounds），量过的记下来
--------------------------------------------------------------------------------

-- 界面状态（下面「状态」一节里填全）。量字宽要用它的宽高比，得先声明
local ui

local width_cache = {}
local width_cache_size = 0

local function estimate_width(str, size)
  local w = 0
  for _, ch in ipairs(chars(str)) do
    local b = ch:byte(1)
    if b >= 0xE0 then w = w + size
    elseif b >= 0x80 then w = w + size * 0.6
    elseif ch:match('%d') then w = w + size * 0.56
    elseif ch == ' ' then w = w + size * 0.28
    else w = w + size * 0.52 end
  end
  return w
end

local function text_width(str, size, bold)
  str = esc(str)
  if str == '' then return 0 end
  -- 虚拟画布的宽高比不同，量出来的宽度就不同（libass 按窗口的像素比例排字），宽高比也算进键里
  local key = math.floor(ui.W / math.max(1, ui.H) * 100) .. ':' .. size .. (bold and 'b' or 'r') .. str
  local cached = width_cache[key]
  if cached then return cached end
  local w = nil
  if measurer then
    measurer.res_x = ui.W
    measurer.res_y = ui.H
    measurer.data = string.format('{\\an7\\pos(0,0)\\fn%s\\fs%.1f\\b%d\\q2\\bord0\\shad0}%s', opts.font, size, bold and 1 or 0, str)
    local ok, r = pcall(function() return measurer:update() end)
    if ok and type(r) == 'table' and type(r.x0) == 'number' and type(r.x1) == 'number' and r.x1 > r.x0 then
      w = r.x1 - r.x0
    end
  end
  w = w or estimate_width(str, size)
  if width_cache_size > 2000 then
    width_cache = {}
    width_cache_size = 0
  end
  width_cache[key] = w
  width_cache_size = width_cache_size + 1
  return w
end

-- 放不下就截短加「…」
local function fit(str, size, bold, maxw)
  str = esc(str)
  if maxw <= 0 then return '' end
  if text_width(str, size, bold) <= maxw then return str end
  local list = chars(str)
  local lo, hi = 0, #list
  while lo < hi do
    local mid = math.floor((lo + hi + 1) / 2)
    if text_width(table.concat(list, '', 1, mid) .. '…', size, bold) <= maxw then lo = mid else hi = mid - 1 end
  end
  if lo == 0 then return '' end
  return table.concat(list, '', 1, lo) .. '…'
end

--------------------------------------------------------------------------------
-- 状态
--------------------------------------------------------------------------------

-- NoxReel 推来的房间状态（见 apply_state）。没推过就是空表：控制条照样能用，只是没有房间那部分
local room = {}
local room_at = 0
local labels = {}

local function L(key)
  return labels[key] or DEFAULT_LABELS[key] or key
end

local media = {
  pause = true,
  time = nil,
  duration = 0,
  volume = 100,
  mute = false,
  chapters = {},
  tracks = {},
  cache = nil,
  fullscreen = false,
  maximized = false,
  border = true,
  title_bar = true,
  idle = true,
  loading = false,
  buffering = false,
  buffering_pct = nil,
  title = '',
  remote = false,
  loaded_at = nil,
  volume_max = 130,
  seeking = false,
  core_idle = false,
  -- 从什么时候开始在等数据（见 update_waiting），没在等是 nil
  wait_since = nil,
}

ui = {
  fade = 0,
  target = 0,
  fade_from = 0,
  fade_start = 0,
  last_move = -100,
  flash_until = 0,
  mouse_in = false,
  mx = -1,
  my = -1,
  hover = nil,
  pressed = nil,
  drag = nil,
  menu = nil,
  toasts = {},
  layout = nil,
  W = 1280,
  H = 720,
  px = 1,
  sections = {},
  margins = nil,
  -- 长按 → 的 2 倍速：active 快进中；timer 等长按的那一下；prev_speed 松手时回到的倍速；
  -- quiet_until 之前倍速变化不弹「倍速 N×」（这是我们自己改的）
  hold = { active = false, timer = nil, prev_speed = 1, quiet_until = 0 },
  -- 快捷键一览开着
  help = false,
  -- 正在往上飘的表情反应：{ e = 第几个, name = 谁发的, t0 = 开始的时刻, x = 横向偏移 }
  reactions = {},
}

local function now()
  return mp.get_time()
end

local function has_media()
  return not media.idle or media.loading
end

local function can_seek()
  return room.canSeek ~= false
end

local function position()
  local t = media.time or 0
  if ui.drag and ui.drag.kind == 'seek' and media.duration > 0 then return ui.drag.frac * media.duration end
  return t
end

-- 房主现在放到哪：收到时的位置，房间在走的话按经过的时间往后推
local function host_position()
  local h = room.host
  if not h then return nil end
  local p = h.pos
  if h.playing then p = p + (now() - room_at) end
  return p
end

local request

--------------------------------------------------------------------------------
-- 动效
--------------------------------------------------------------------------------
-- 两种会动的值：弹簧（越过目标一点再落回，像液体）和按时长走的渐变。有值在动时每秒重画 60 次，
-- 全停了就不再画（平时的开销不变）；提示条进场、退场那零点几秒也算在动。
-- 弹簧按角频率 w 和阻尼比 z 走：z 小于 1 会越过目标，越小越弹；等于 1 正好不越过

local motion = { springs = {}, tweens = {}, last = 0, tick = nil }
-- 提示条落下来、收上去各用多久（秒）
local TOAST_S = { enter = 0.3, leave = 0.24 }

local function kick()
  if timers.anim or fell_back then return end
  if timers.anim_wake then
    timers.anim_wake:kill()
    timers.anim_wake = nil
  end
  motion.last = now()
  timers.anim = mp.add_periodic_timer(1 / 60, function() motion.tick() end)
end

local function new_spring(x)
  local s = { x = x, v = 0, target = x, w = 20, z = 1 }
  motion.springs[#motion.springs + 1] = s
  return s
end

local function spring_to(s, target, w, z)
  if w then s.w = w end
  if z then s.z = z end
  if s.target == target then return end
  s.target = target
  kick()
end

local function spring_set(s, x)
  s.x, s.v, s.target = x, 0, x
end

local function new_tween(x)
  local t = { x = x, from = x, target = x, dur = 0.16, t0 = 0 }
  motion.tweens[#motion.tweens + 1] = t
  return t
end

-- delay 秒之后才开始动（声波一条接一条）
local function tween_to(t, target, dur, delay)
  if t.target == target then return end
  t.from, t.target, t.dur, t.t0 = t.x, target, dur or t.dur, now() + (delay or 0)
  kick()
end

local function tween_set(t, x)
  t.x, t.from, t.target = x, x, x
end

-- 越过一点再落回的缓动（0 → 1，中途最多到约 1.1）
local function back_out(p)
  local q = p - 1
  return 1 + 2.70158 * q * q * q + 1.70158 * q * q
end

motion.tick = guard(function()
  local t = now()
  local dt = clamp(t - motion.last, 0, 0.05)
  motion.last = t
  local busy = false
  for _, s in ipairs(motion.springs) do
    if s.x ~= s.target or s.v ~= 0 then
      -- 小步积分：卡了一下、dt 很大时也不会发散
      local steps = math.max(1, math.ceil(dt * 240))
      local h = dt / steps
      local k, c = s.w * s.w, 2 * s.z * s.w
      for _ = 1, steps do
        s.v = s.v + ((s.target - s.x) * k - s.v * c) * h
        s.x = s.x + s.v * h
      end
      local scale = math.max(1, math.abs(s.target))
      if math.abs(s.target - s.x) < 0.002 * scale and math.abs(s.v) < 0.02 * scale then s.x, s.v = s.target, 0 end
      busy = true
    end
  end
  for _, tw in ipairs(motion.tweens) do
    if tw.x ~= tw.target then
      if t >= tw.t0 then
        local p = tw.dur > 0 and clamp((t - tw.t0) / tw.dur, 0, 1) or 1
        tw.x = p >= 1 and tw.target or tw.from + (tw.target - tw.from) * p
      end
      busy = true
    end
  end
  -- 提示条：进场、退场时在动；中间那段不动，到退场前再叫醒
  local wake = nil
  for _, item in ipairs(ui.toasts) do
    if t - item.t0 < TOAST_S.enter + 0.05 or item.until_t - t < TOAST_S.leave + 0.05 then
      busy = true
    else
      wake = math.min(wake or math.huge, item.until_t - TOAST_S.leave - 0.03)
    end
  end
  request()
  if not busy and timers.anim then
    timers.anim:kill()
    timers.anim = nil
    if wake then timers.anim_wake = mp.add_timeout(math.max(0, wake - t), function() kick() end) end
  end
end)

--------------------------------------------------------------------------------
-- 提示条
--------------------------------------------------------------------------------

local function toast(str, ms, tone, kind)
  str = tostring(str or '')
  if str == '' then return end
  ms = clamp(tonumber(ms) or 2000, 500, 15000)
  local t = now()
  if kind then
    for i = #ui.toasts, 1, -1 do
      local old = ui.toasts[i]
      if old.kind == kind then
        -- 同一类还挂着（连按 ↑↓、连着切轨道）：原地换字、续时间，不重新落一遍
        if old.until_t - t > TOAST_S.leave then
          old.text, old.tone, old.until_t = str, tone or 'info', t + ms / 1000
          kick()
          request()
          return
        end
        table.remove(ui.toasts, i)
      end
    end
  end
  ui.toasts[#ui.toasts + 1] = { text = str, tone = tone or 'info', kind = kind, t0 = t, until_t = t + ms / 1000 }
  while #ui.toasts > 3 do table.remove(ui.toasts, 1) end
  kick()
  request()
end

--------------------------------------------------------------------------------
-- 音量
--------------------------------------------------------------------------------
-- 平时只有一个喇叭按钮。鼠标停上去，按钮底下那颗玻璃珠拉长成胶囊、露出音量条，移开 0.7 秒后收回；
-- 拖的时候音量条变粗、面板上方冒出数值气泡；拖过右端轨道被拉长、松手弹回（音量停在 100）；
-- 100 以上（滚轮、↑ 键能调到 volume-max）接一段琥珀色。数值变化一律滑过去，不跳。
-- 控件显示着时音量变了只在胶囊上反馈，收起着才从顶部落下一条音量胶囊（以前两边都给，拖的时候顶部还弹一条）

local VOL = {
  track = 96,    -- 0–100 那一段多长
  boost = 16,    -- 100 到 volume-max 那一段最长多长
  stretch = 16,  -- 拖过右端最多拉长多少
  open = 126,    -- 展开时胶囊比按钮宽出多少：轨道、增益段和两头的留白
}

local vol = {
  open = new_spring(0),     -- 胶囊展开多少：0 收起、1 展开（弹的时候会稍微超过 1）
  bead = new_tween(0),      -- 收起时按钮底下那颗玻璃珠（悬停）
  fat = new_spring(0),      -- 轨道变粗：0 是 6 像素，1 是 10 像素
  fill = new_spring(-1),    -- 画出来的音量（0–130），跟着真实音量滑过去；-1 是还没收到过
  stretch = new_spring(0),  -- 拖过右端时轨道被拉长了多少（像素）
  bubble = new_tween(0),    -- 面板上方的数值气泡
  ghost = new_tween(0),     -- 静音时留在原来音量处的那道刻痕
  waves = { new_tween(1), new_tween(1), new_tween(0) },
  xa = new_tween(0),        -- 静音叉的两笔
  xb = new_tween(0),
  digits = {},              -- 气泡里每一位数字滚到哪了（个位在前），各自一个弹簧
  hover = false,            -- 鼠标在胶囊上
  track_hover = false,      -- 鼠标在音量条上
  bubble_until = 0,         -- 键盘、滚轮调的：气泡挂到这时候
}

-- 进度条鼓起来（悬停、拖动）
local seek_fat = new_spring(0)

function vol.dragging()
  return ui.drag ~= nil and ui.drag.kind == 'vol'
end

-- 100 以上那段占增益段的几成（按 volume-max 算，默认 130）
function vol.boost_frac(v)
  local span = media.volume_max - 100
  if span <= 0 then return 0 end
  return clamp((v - 100) / span, 0, 1)
end

-- 声波几条：静音或 0 一条不画
function vol.level()
  if media.mute or media.volume <= 0 then return 0 end
  if media.volume < 34 then return 1 end
  if media.volume < 67 then return 2 end
  return 3
end

-- 音量或静音变了：声波、静音叉、填充、刻痕都朝新的样子动过去。instant 为真时直接到位（刚收到第一个值）
function vol.retarget(instant)
  local level = vol.level()
  local muted = level == 0
  local fill = muted and 0 or media.volume
  local ghost = (media.mute and media.volume > 0) and 1 or 0
  if instant or vol.fill.x < 0 then
    spring_set(vol.fill, fill)
    for i, w in ipairs(vol.waves) do tween_set(w, level >= i and 1 or 0) end
    tween_set(vol.xa, muted and 1 or 0)
    tween_set(vol.xb, muted and 1 or 0)
    tween_set(vol.ghost, ghost)
    return
  end
  -- 拖的时候 60ms 跟手；滚轮、键盘、静音滑过去，略带一点回弹
  if vol.dragging() then spring_to(vol.fill, fill, 60, 1) else spring_to(vol.fill, fill, 22, 0.75) end
  for i, w in ipairs(vol.waves) do
    local on = level >= i and 1 or 0
    -- 长出来由内向外、收起来由外向内，一条接一条
    tween_to(w, on, 0.16, on == 1 and (i - 1) * 0.045 or (3 - i) * 0.045)
  end
  -- 静音：声波先收，叉再一笔一笔画出来；取消静音倒过来
  if muted then
    tween_to(vol.xa, 1, 0.16, 0.08)
    tween_to(vol.xb, 1, 0.16, 0.16)
  else
    tween_to(vol.xb, 0, 0.12, 0)
    tween_to(vol.xa, 0, 0.12, 0.05)
  end
  tween_to(vol.ghost, ghost, 0.2, ghost == 1 and 0.15 or 0)
end

-- 气泡里的数字：每一位一个弹簧，往近的方向滚（9 → 0 往前滚一格，不倒着滚过 8、7……）。返回有几位
function vol.roll_digits(value)
  local s = tostring(math.floor(value + 0.5))
  local count = #s
  for i = 1, count do
    local d = tonumber(s:sub(count - i + 1, count - i + 1))
    local sp = vol.digits[i]
    if not sp then
      sp = new_spring(d)
      vol.digits[i] = sp
    end
    spring_to(sp, d + 10 * math.floor((sp.target - d) / 10 + 0.5), 20, 0.7)
  end
  return count
end

function vol.expand()
  if timers.vol_close then
    timers.vol_close:kill()
    timers.vol_close = nil
  end
  tween_to(vol.bead, 1, 0.12)
  spring_to(vol.open, 1, 18, 0.62)
end

function vol.collapse()
  if timers.vol_close then
    timers.vol_close:kill()
    timers.vol_close = nil
  end
  vol.track_hover = false
  spring_to(vol.fat, 0, 24, 1)
  tween_to(vol.bubble, 0, 0.14)
  spring_to(vol.open, 0, 22, 1)
  if not vol.hover then tween_to(vol.bead, 0, 0.2, 0.1) end
end

function vol.collapse_later(s)
  if timers.vol_close then timers.vol_close:kill() end
  timers.vol_close = mp.add_timeout(s, guard(function()
    timers.vol_close = nil
    if vol.hover or vol.dragging() then return end
    vol.collapse()
  end))
end

-- 冒出数值气泡，s 秒后收回（鼠标停在音量条上、拖动中不收）
function vol.show_bubble(s)
  vol.bubble_until = math.max(vol.bubble_until, now() + s)
  tween_to(vol.bubble, 1, 0.16)
  if timers.vol_bubble then timers.vol_bubble:kill() end
  timers.vol_bubble = mp.add_timeout(s, guard(function()
    timers.vol_bubble = nil
    if not vol.track_hover and not vol.dragging() then tween_to(vol.bubble, 0, 0.14) end
  end))
end

-- 鼠标动了：进出胶囊决定展开 / 收起，进出音量条决定变粗、冒气泡
function vol.update_hover(x, y)
  local lay = ui.layout
  local c = lay and lay.volcap
  local inside = c ~= nil and ui.target > 0 and x >= c.x0 and x < c.x1 and y >= c.y0 and y < c.y1
  if inside and not vol.hover then
    vol.hover = true
    vol.expand()
  elseif not inside and vol.hover then
    vol.hover = false
    if not vol.dragging() then vol.collapse_later(0.7) end
  end
  local v = lay and lay.vol
  local on_track = inside and v ~= nil and x >= v.x0 and x < v.x1 and y >= v.y0 and y < v.y1
  if on_track ~= vol.track_hover then
    vol.track_hover = on_track
    if not vol.dragging() then
      spring_to(vol.fat, on_track and 1 or 0, 24, on_track and 0.55 or 1)
      if on_track then
        tween_to(vol.bubble, 1, 0.16)
      elseif now() >= vol.bubble_until then
        tween_to(vol.bubble, 0, 0.14)
      end
    end
  end
end

-- 松手：拉长的那截弹回去（比展开弹得更明显），变粗、气泡看鼠标还在不在音量条上
function vol.drag_end()
  spring_to(vol.stretch, 0, 20, 0.4)
  spring_to(vol.fat, vol.track_hover and 1 or 0, 24, vol.track_hover and 0.55 or 1)
  spring_to(vol.fill, vol.fill.target, 22, 0.75)
  if not vol.track_hover then vol.show_bubble(0.6) end
  if not vol.hover then vol.collapse_later(0.7) end
end

-- 音量变了怎么告诉人：控件显示着就在面板里的胶囊上（展开、冒出数值），收起着才从顶部落下一条音量胶囊
function vol.feedback()
  if ui.target > 0 and ui.layout then
    if vol.dragging() then return end
    vol.expand()
    vol.show_bubble(1.1)
    if not vol.hover then vol.collapse_later(1.5) end
  else
    local muted = media.mute or media.volume <= 0
    toast(muted and L('muted') or string.format('%d%%', math.floor(media.volume + 0.5)), 1300, 'volume', 'volume')
  end
end

--------------------------------------------------------------------------------
-- 排版
--------------------------------------------------------------------------------

local PANEL_H = 112
local PANEL_R = 30
-- 菜单一行多高
local MENU_ROW = 40

local function window_controls_shown()
  return (not media.border or not media.title_bar) and not media.fullscreen
end

local function add_hit(list, id, x0, y0, x1, y1, extra)
  local h = extra or {}
  h.id, h.x0, h.y0, h.x1, h.y1 = id, x0, y0, x1, y1
  list[#list + 1] = h
  return h
end

local function layout()
  local W, H = ui.W, ui.H
  local lay = { hits = {}, buttons = {} }
  local side = W < 700 and 12 or 24
  local bottom = W < 700 and 12 or 20
  local P = { x0 = side, x1 = W - side, y1 = H - bottom }
  P.y0 = P.y1 - PANEL_H
  lay.panel = P
  add_hit(lay.hits, 'panel', P.x0, P.y0, P.x1, P.y1)

  -- 进度条那一行
  lay.seek = { x0 = P.x0 + 24, x1 = P.x1 - 24, cy = P.y0 + 24 }
  add_hit(lay.hits, 'seek', lay.seek.x0 - 6, P.y0 + 6, lay.seek.x1 + 6, P.y0 + 44)
  -- 共享标记：进度条上方的小菱形，比进度条后登记（hit_at 倒着找，点到标记的时候算标记）
  lay.marks = {}
  if room.marks and media.duration > 0 then
    local S = lay.seek
    for _, m in ipairs(room.marks) do
      local x = S.x0 + clamp(m.t / media.duration, 0, 1) * (S.x1 - S.x0)
      lay.marks[#lay.marks + 1] = add_hit(lay.hits, 'mark', x - 6, S.cy - 19, x + 6, S.cy + 1, { t = m.t, note = m.n, cx = x })
    end
  end

  -- 按钮那一行
  local cy = P.y0 + 78
  lay.cy = cy
  local bx = P.x0 + 16
  local function button(id, w, extra)
    local half = id == 'play' and 26 or 22
    local b = add_hit(lay.hits, id, bx, cy - half, bx + w, cy + half, extra)
    b.cx = bx + w / 2
    lay.buttons[#lay.buttons + 1] = b
    bx = bx + w
    return b
  end
  button('play', 52, { round = true, tip = media.pause and L('play') or L('pause'), key = L('keySpace') })
  bx = bx + 14
  if W >= 640 then
    button('back', 44, { tip = L('back'), key = '←', disabled = not can_seek() })
    bx = bx + 4
    button('fwd', 44, { tip = L('fwd'), key = '→', disabled = not can_seek() })
    bx = bx + 4
  end
  -- 音量胶囊：收起时就是喇叭按钮，展开时往右长出音量条（宽度跟着弹簧走，时间跟着往右让）
  local open = math.max(0, vol.open.x)
  local mute = button('mute', 44, { tip = (media.mute and L('unmute') or L('mute')), key = 'M' })
  lay.volcap = { x0 = mute.x0, x1 = mute.x0 + 44 + VOL.open * open, y0 = cy - 22, y1 = cy + 22, open = open }
  if open > 0.6 then
    local tx0 = mute.x0 + 46
    lay.vol = add_hit(lay.hits, 'vol', tx0 - 6, cy - 16, tx0 + VOL.track + VOL.boost + 4, cy + 16)
    lay.vol.tx0, lay.vol.tx1 = tx0, tx0 + VOL.track
  end
  bx = lay.volcap.x1 + 4
  lay.time_x = bx + 10

  local rx = P.x1 - 16
  local function rbutton(id, w, extra)
    local b = add_hit(lay.hits, id, rx - w, cy - 22, rx, cy + 22, extra)
    b.cx = rx - w / 2
    lay.buttons[#lay.buttons + 1] = b
    rx = rx - w
    return b
  end
  rbutton('fullscreen', 44, { tip = media.fullscreen and L('exitFullscreen') or L('fullscreen'), key = 'Enter' })
  lay.divider = rx - 4 - 6.5
  rx = rx - 4 - 13 - 4
  local audio_tracks, sub_tracks = 0, 0
  for _, t in ipairs(media.tracks) do
    if t.type == 'audio' then audio_tracks = audio_tracks + 1 elseif t.type == 'sub' then sub_tracks = sub_tracks + 1 end
  end
  rbutton('audio', 44, { tip = audio_tracks > 1 and L('audio') or L('noAudio'), key = 'A', disabled = audio_tracks < 2 })
  rx = rx - 4
  -- 没有字幕也能点：菜单里有「加载本机字幕…」
  rbutton('subs', 44, { tip = sub_tracks > 0 and L('subs') or L('noSubs'), key = 'C' })
  if room.danmaku ~= nil then
    rx = rx - 4
    rbutton('danmaku', 44, { tip = room.danmaku and L('danmakuOn') or L('danmakuOff'), key = 'B' })
    -- 表情反应只在房间里有（和弹幕开关同一个条件）
    if W >= 560 then
      rx = rx - 4
      rbutton('react', 44, { tip = L('react'), key = '1–8' })
    end
  end
  if room.quality then
    rx = rx - 10
    local label = room.quality.label or ''
    local w = math.floor(text_width(label, 13, true) + 12 + 6 + 14 + 10 + 0.5)
    local b = add_hit(lay.hits, 'quality', rx - w, cy - 16, rx, cy + 16, { tip = L('quality') })
    b.cx = rx - w / 2
    b.label = label
    lay.buttons[#lay.buttons + 1] = b
    lay.quality = b
    rx = rx - w
  end
  lay.right_x = rx - 12

  -- 顶栏
  lay.wc = window_controls_shown()
  local chip_right = W - 24
  if lay.wc then
    -- 窗口按钮收在右上角一颗玻璃胶囊里；能点到的范围一直伸到窗口的顶边和右边（甩到角上就能点到关闭）
    local x1 = W - 14
    local x0 = x1 - (3 + 40 * 3 + 3)
    lay.wc_rect = { x0 = x0, y0 = 12, x1 = x1, y1 = 48 }
    for i, id in ipairs({ 'minimize', 'maximize', 'close' }) do
      local vx0 = x0 + 3 + (i - 1) * 40
      add_hit(lay.hits, id, vx0, 0, i == 3 and W or vx0 + 40, 48, { win = true, vx0 = vx0, vx1 = vx0 + 40 })
    end
    lay.wc_x0 = x0
    chip_right = x0 - 12
  end
  if room.chip and room.chip.text then
    local tw = text_width(room.chip.text, 13, false)
    lay.chip = { x1 = chip_right, x0 = chip_right - (12 + 8 + 9 + tw + 14), y0 = 14, y1 = 46 }
  end
  if room.drift then
    local dt = room.drift.text or ''
    local bt = room.drift.button or ''
    local kt = room.drift.key or ''
    local tw = text_width(dt, 14, false)
    -- 按钮：左边留 12、图标 15、间隔 8、字、（快捷键：间隔 8、键名左右各 8）、右边留 6
    local bw = 12 + 15 + 8 + text_width(bt, 13, true) + (kt ~= '' and (8 + text_width(kt, 11, false) + 16) or 0) + 6
    local w = 34 + tw + 12 + bw + 5
    local x0 = math.floor(W / 2 - w / 2)
    lay.drift = { x0 = x0, x1 = x0 + w, y0 = 14, y1 = 58, tw = tw, bw = bw }
    lay.drift_btn = add_hit(lay.hits, 'sync', x0 + w - 5 - bw, 19, x0 + w - 5, 53)
  end
  -- 窗口窄时居中的差开提示会压到右上角的房间状态上：差开提示本身就说了同步状态，房间状态让路
  if lay.drift and lay.chip and lay.drift.x1 + 12 > lay.chip.x0 then lay.chip = nil end
  local title_max = (lay.chip and lay.chip.x0 or chip_right) - 32 - 24
  if lay.drift then title_max = math.min(title_max, lay.drift.x0 - 32 - 24) end
  lay.title_max = title_max

  -- 菜单（在按钮上方、右边对齐）。放不下的项目滚着看（滚轮），不截掉：YouTube 的字幕常有几十种语言
  if ui.menu then
    local m = ui.menu
    local anchor = nil
    for _, b in ipairs(lay.buttons) do if b.id == m.anchor then anchor = b end end
    if anchor then
      local header = m.title and 34 or 0
      local n = #m.items
      -- 上面留出窗口按钮那一行
      local top = lay.wc and 56 or 12
      local fit_n = math.max(1, math.floor((P.y0 - 10 - top - 8 - header - 8) / MENU_ROW))
      local visible = math.min(n, fit_n)
      if m.want then
        -- 刚打开：让选中的那一项落在可见范围中间
        m.offset = m.want - math.ceil(visible / 2)
        m.want = nil
      end
      m.offset = clamp(m.offset or 0, 0, math.max(0, n - visible))
      m.visible = visible
      local scroll = n > visible
      local w = 220
      for _, it in ipairs(m.items) do w = math.max(w, text_width(it.label, 14, true) + 16 + 24 + 30 + (scroll and 10 or 0)) end
      if m.title then w = math.max(w, text_width(m.title, 13, true) + (m.note and text_width(m.note, 12, false) + 40 or 0) + 40) end
      w = math.min(w, W - 24)
      local hh = 8 + header + visible * MENU_ROW + 8
      local x1 = math.min(anchor.x1 + 8, W - 12)
      local x0 = math.max(12, x1 - w)
      local y1 = P.y0 - 10
      local y0 = y1 - hh
      lay.menu = { x0 = x0, x1 = x0 + w, y0 = y0, y1 = y1, scroll = scroll, list_y0 = y0 + 8 + header }
      add_hit(lay.hits, 'menu', x0, y0, x0 + w, y1, { menu = true })
      local iy = y0 + 8 + header
      for i = m.offset + 1, m.offset + visible do
        add_hit(lay.hits, 'item', x0 + 8, iy, x0 + w - 8 - (scroll and 10 or 0), iy + MENU_ROW, { menu = true, item = m.items[i], index = i })
        iy = iy + MENU_ROW
      end
    end
  end
  return lay
end

--------------------------------------------------------------------------------
-- 画
--------------------------------------------------------------------------------

local function ranges_now()
  if type(room.ranges) == 'table' then return room.ranges end
  if media.remote and media.cache and media.duration > 0 then
    local out = {}
    for _, r in ipairs(media.cache['seekable-ranges'] or {}) do
      if type(r.start) == 'number' and type(r['end']) == 'number' then
        out[#out + 1] = { r.start / media.duration, r['end'] / media.duration }
      end
    end
    return out
  end
  return nil
end

-- 进度条上的一段，章节断点处留 2 个单位的缝
local function bar_piece(x0, x1, y0, y1, a, b, color, op, gaps)
  a, b = clamp(a, 0, 1), clamp(b, 0, 1)
  if b <= a then return end
  local w = x1 - x0
  local from = x0 + a * w
  local to = x0 + b * w
  local r = (y1 - y0) / 2
  local cuts = {}
  for _, g in ipairs(gaps or {}) do
    local gx = x0 + g * w
    if gx > from + 1 and gx < to - 1 then cuts[#cuts + 1] = gx end
  end
  local s = from
  for _, gx in ipairs(cuts) do
    fill_rect(s, y0, gx - 1.5, y1, math.min(r, (gx - 1.5 - s) / 2), color, op)
    s = gx + 1.5
  end
  fill_rect(s, y0, to, y1, math.min(r, (to - s) / 2), color, op)
end

-- 章节断点。挨得太近的（不到 10 个单位）只留第一个、离两头太近的不要：几百个章节的片子
-- 每个都开缝的话，缝比进度条还宽，整条就没了
local function chapter_gaps(width)
  local all = {}
  if media.duration > 0 then
    for _, c in ipairs(media.chapters) do
      if type(c.time) == 'number' then all[#all + 1] = c.time / media.duration end
    end
  end
  table.sort(all)
  local gaps, last = {}, nil
  for _, g in ipairs(all) do
    if g * width >= 8 and (1 - g) * width >= 8 and (not last or (g - last) * width >= 10) then
      gaps[#gaps + 1] = g
      last = g
    end
  end
  return gaps
end

local function chapter_at(t)
  local title = nil
  for _, c in ipairs(media.chapters) do
    if type(c.time) == 'number' and c.time <= t then title = c.title end
  end
  return title
end

-- 键帽：快捷键一览、按钮说明后面的键名。返回宽度
local function keycap(x0, cy, label, size, op, h)
  h = h or 22
  local kw = text_width(label, size, false) + 14
  fill_rect(x0, cy - h / 2, x0 + kw, cy + h / 2, 8, C.white, 0.06 * op)
  ring_rect(x0, cy - h / 2, x0 + kw, cy + h / 2, 8, 1, C.white, 0.2 * op)
  text(x0 + kw / 2, cy, 5, size, C.body, op, label)
  return kw
end

-- 带一圈光的小圆点（房间状态、差开提示）
local function glow_dot(cx, cy, color, op)
  circle(cx, cy, 7, color, 0.3 * op, '\\blur3')
  circle(cx, cy, 4, color, op)
end

local function draw_seek_bar(lay, f)
  local S = lay.seek
  local hover = ui.hover and ui.hover.id == 'seek' and can_seek()
  local dragging = ui.drag and ui.drag.kind == 'seek'
  -- 鼠标停上去轨道鼓起来（5 → 9），拖柄从中间长出来
  if hover or dragging then spring_to(seek_fat, 1, 24, 0.55) else spring_to(seek_fat, 0, 26, 1) end
  local fat = math.max(0, seek_fat.x)
  local thick = 5 + 4 * fat
  local y0, y1 = S.cy - thick / 2, S.cy + thick / 2
  local gaps = chapter_gaps(S.x1 - S.x0)
  bar_piece(S.x0, S.x1, y0, y1, 0, 1, C.white, 0.16 * f, gaps)
  local ranges = ranges_now()
  if ranges then
    for _, r in ipairs(ranges) do bar_piece(S.x0, S.x1, y0, y1, r[1], r[2], C.white, 0.3 * f, gaps) end
  end
  local frac = media.duration > 0 and clamp(position() / media.duration, 0, 1) or 0
  bar_piece(S.x0, S.x1, y0, y1, 0, frac, C.white, f, gaps)

  local hp = host_position()
  if hp and media.duration > 0 then
    local hx = S.x0 + clamp(hp / media.duration, 0, 1) * (S.x1 - S.x0)
    fill_rect(hx - 1, S.cy - 7, hx + 1, S.cy + 7, 1, C.host, f)
    local lw = text_width(L('host'), 11, true) + 16
    local py = S.cy - 34
    fill_rect(hx - lw / 2, py + 2, hx + lw / 2, py + 20, 9, C.black, 0.3 * f, '\\blur3')
    fill_rect(hx - lw / 2, py, hx + lw / 2, py + 18, 9, C.host, f)
    ring_rect(hx - lw / 2, py, hx + lw / 2, py + 18, 9, 1, C.white, 0.45 * f, clip_rect(hx - lw / 2, py, hx + lw / 2, py + 5))
    text(hx, py + 9, 5, 11, C.hostText, f, L('host'), true)
  end

  -- 共享标记：进度条上方的小菱形，鼠标停着的那个放大，上面浮出「几分几秒 · 谁：一句话」
  local hover_mark = ui.hover and ui.hover.id == 'mark' and ui.hover or nil
  for _, m in ipairs(lay.marks or {}) do
    local on = hover_mark and hover_mark.cx == m.cx and hover_mark.t == m.t
    local r = on and 5 or 3.5
    local y = S.cy - 12
    fill_event({ poly(m.cx, y - r - 1.5, m.cx + r + 1.5, y, m.cx, y + r + 1.5, m.cx - r - 1.5, y) }, 0, 0, 1, C.black, 0.4 * f)
    fill_event({ poly(m.cx, y - r, m.cx + r, y, m.cx, y + r, m.cx - r, y) }, 0, 0, 1, C.mark, f * (on and 1 or 0.9))
  end
  if hover_mark and not dragging then
    local label = fmt_time(hover_mark.t, false)
    local note = hover_mark.note ~= '' and hover_mark.note or nil
    local hint = can_seek() and L('markTip') or nil
    local bw = math.max(text_width(label, 15, true), note and text_width(note, 13, false) or 0, hint and text_width(hint, 12, false) or 0) + 32
    bw = math.min(math.max(bw, 80), 320)
    local bh = 36 + (note and 20 or 0) + (hint and 18 or 0)
    local bx0 = clamp(hover_mark.cx - bw / 2, lay.panel.x0, lay.panel.x1 - bw)
    local by1 = lay.panel.y0 - 10
    glass(bx0, by1 - bh, bx0 + bw, by1, 18, f, { base = C.deep, base_op = DEEP_OP, rim = C.mark, rim_op = 0.55 })
    local ty = by1 - bh + 9
    text(bx0 + bw / 2, ty, 8, 15, C.mark, f, label, true)
    ty = ty + 21
    if note then
      text(bx0 + bw / 2, ty, 8, 13, C.text, f, fit(note, 13, false, bw - 20))
      ty = ty + 20
    end
    if hint then text(bx0 + bw / 2, ty, 8, 12, C.dim, f, hint) end
  end

  local px = S.x0 + frac * (S.x1 - S.x0)
  if fat > 0.02 then
    local kr = 8 * math.min(fat, 1.15)
    circle(px, S.cy + 2, kr + 1, C.black, 0.45 * f, '\\blur4')
    circle(px, S.cy, kr + 4 * math.min(fat, 1), C.white, 0.18 * f)
    circle(px, S.cy, kr, C.white, f)
  end
  if hover or dragging then
    local mx = dragging and px or clamp(ui.mx, S.x0, S.x1)
    local t = (mx - S.x0) / (S.x1 - S.x0) * media.duration
    if not dragging then fill_rect(mx - 1, S.cy - 7, mx + 1, S.cy + 7, 1, C.white, 0.8 * f) end
    local label = fmt_time(t, false)
    local chap = chapter_at(t)
    local bw = math.max(text_width(label, 15, true), chap and text_width(chap, 12, false) or 0) + 32
    bw = math.min(math.max(bw, 80), 240)
    local bh = chap and 52 or 36
    local bx0 = clamp(mx - bw / 2, lay.panel.x0, lay.panel.x1 - bw)
    local by1 = lay.panel.y0 - 10
    glass(bx0, by1 - bh, bx0 + bw, by1, 18, f)
    text(bx0 + bw / 2, by1 - bh + (chap and 9 or 10), 8, 15, C.text, f, label, true)
    if chap then text(bx0 + bw / 2, by1 - bh + 30, 8, 12, 'B4BFCD', f, fit(chap, 12, false, bw - 20)) end
  end
end

-- 喇叭：声波按音量分三档，一条接一条从喇叭口长出来 / 收回去；静音时叉一笔一笔画出来
local function draw_speaker(cx, cy, size, color, op)
  if op <= 0 then return end
  local k = size / 24
  local ox, oy = cx - 12 * k, cy - 12 * k
  local sw = 1.75 * k
  fill_event(ICONS.speaker.fill, ox, oy, k, color, op, ICONS.speaker.round)
  for i, w in ipairs(vol.waves) do
    local p = clamp(w.x, 0, 1)
    if p > 0.01 then
      local k2 = k * (0.5 + 0.5 * back_out(p))
      stroke_event(ICONS['wave' .. i].stroke, ox + 11 * (k - k2), oy + 12 * (k - k2), k2, sw, color, op * p)
    end
  end
  local a, b = clamp(vol.xa.x, 0, 1), clamp(vol.xb.x, 0, 1)
  if a > 0.01 then stroke_event({ poly(15.5, 9.5, 15.5 + 5 * a, 9.5 + 5 * a) }, ox, oy, k, sw, color, op) end
  if b > 0.01 then stroke_event({ poly(20.5, 9.5, 20.5 - 5 * b, 9.5 + 5 * b) }, ox, oy, k, sw, color, op) end
end

-- 一位数字占多宽：量「00」减「0」（只量一个字时量出来的宽度会多带一截边距）
local function digit_w(size)
  local w = text_width('00', size, true) - text_width('0', size, true)
  return w > 0 and w or size * 0.58
end

-- 一串上下滚着换的数字（像老式计数器），右边缘在 xr。返回左边缘
local function draw_digits(xr, cy, size, color, op, value)
  local count = vol.roll_digits(value)
  local dw = digit_w(size)
  local lh = size * 1.2
  local x = xr
  for i = 1, count do
    local p = vol.digits[i].x
    local base = math.floor(p)
    local frac = p - base
    local cx = x - dw / 2
    local cl = clip_rect(cx - dw, cy - lh / 2, cx + dw, cy + lh / 2)
    text(cx, cy - frac * lh, 5, size, color, op, tostring(base % 10), true, cl)
    if frac > 0.01 then text(cx, cy + (1 - frac) * lh, 5, size, color, op, tostring((base + 1) % 10), true, cl) end
    x = x - dw
  end
  return x
end

-- 按钮那一行的中线，draw_panel 画按钮前设好
local lay_cy = 0

local function draw_button(b, f)
  local hovered = ui.hover and ui.hover.id == b.id
  local pressed = ui.pressed and ui.pressed.id == b.id
  local col = b.disabled and C.faint or C.body
  local op = b.disabled and 0.75 or 1
  if b.id == 'play' then
    -- 播放键是一颗更亮的玻璃珠，图标纯白
    fill_rect(b.cx - 26, lay_cy - 20, b.cx + 26, lay_cy + 32, 26, C.black, 0.25 * f, '\\blur8' .. clip_shape(b.cx - 26, lay_cy - 26, b.cx + 26, lay_cy + 26, 26, true))
    bead(b.cx - 26, lay_cy - 26, b.cx + 26, lay_cy + 26, 26, f, pressed and 0.26 or hovered and 0.22 or 0.16, 0.42)
    icon(media.pause and 'play' or 'pause', b.cx + (media.pause and 1 or 0), lay_cy, pressed and 22 or 24, C.white, f)
    return
  end
  if b.id == 'mute' then return end
  if b.id == 'quality' then
    local open = ui.menu and ui.menu.anchor == 'quality'
    fill_rect(b.x0, b.y0, b.x1, b.y1, 16, C.white, (hovered and 0.13 or 0.07) * f)
    ring_rect(b.x0, b.y0, b.x1, b.y1, 16, 1, open and C.accent or C.white, (open and 1 or 0.12) * f)
    ring_rect(b.x0, b.y0, b.x1, b.y1, 16, 1, C.white, 0.22 * f, clip_rect(b.x0, b.y0, b.x1, b.y0 + 8))
    text(b.x0 + 12, lay_cy, 4, 13, C.text, f, b.label, true)
    icon('chevronUp', b.x1 - 10 - 7, lay_cy, 14, C.text, f, 2.2)
    return
  end
  local open_menu_here = ui.menu and ui.menu.anchor == b.id
  if (hovered or pressed or open_menu_here) and not b.disabled then
    bead(b.cx - 22, lay_cy - 22, b.cx + 22, lay_cy + 22, 22, f, pressed and 0.18 or (open_menu_here and 0.14 or 0.12))
  end
  local s = pressed and 0.92 or 1
  if b.id == 'back' or b.id == 'fwd' then
    icon(b.id, b.cx, lay_cy, 24 * s, col, op * f, 1.7)
    text(b.cx + (b.id == 'back' and 0.4 or -0.4), lay_cy + 0.6, 5, 7.5 * s, col, op * f, '10', true)
  elseif b.id == 'danmaku' then
    local on = room.danmaku == true
    local x0, x1, y0, y1 = b.cx - 12, b.cx + 12, lay_cy - 10.5, lay_cy + 10.5
    if on then
      fill_rect(x0, y0, x1, y1, 7, C.accent, 0.45 * f, '\\blur5')
      fill_rect(x0, y0, x1, y1, 7, C.accent, f)
      ring_rect(x0, y0, x1, y1, 7, 1, C.white, 0.4 * f, clip_rect(x0, y0, x1, y0 + 4))
      text(b.cx, lay_cy, 5, 12.5, C.white, f, '弹', true)
    else
      ring_rect(x0, y0, x1, y1, 7, 1.7, C.sub, f)
      text(b.cx, lay_cy, 5, 12.5, C.sub, f, '弹', true)
    end
  elseif b.id == 'subs' then
    icon('captions', b.cx, lay_cy, 23 * s, col, op * f)
  elseif b.id == 'audio' then
    icon('audio', b.cx, lay_cy, 22 * s, col, op * f)
  elseif b.id == 'react' then
    icon('smile', b.cx, lay_cy, 22 * s, col, op * f)
  elseif b.id == 'fullscreen' then
    icon(media.fullscreen and 'unfullscreen' or 'fullscreen', b.cx, lay_cy, 22 * s, col, op * f)
  end
end

-- 音量胶囊：玻璃珠、喇叭、音量条（增益段、拉长、静音刻痕）。数值气泡另画在面板上方
local function draw_volume(lay, f)
  local c = lay.volcap
  if not c then return end
  local cy = lay.cy
  local open = c.open
  local pressed = ui.pressed and ui.pressed.id == 'mute'
  -- 底下那颗玻璃珠：悬停时出现，展开时跟着拉长
  local bop = math.max(vol.bead.x, clamp(open * 3, 0, 1))
  if bop > 0.01 then bead(c.x0, c.y0, c.x1, c.y1, 22, bop * f, pressed and 0.18 or 0.11) end
  draw_speaker(c.x0 + 22, cy, pressed and 20 or 22, C.body, f)
  lay.vol_anchor = nil
  local a = clamp((open - 0.4) / 0.45, 0, 1) * f
  if a <= 0 then return end
  -- 收的时候音量条不能伸到胶囊外面
  local clip = clip_rect(c.x0, c.y0, c.x1, c.y1)
  local tx0 = c.x0 + 46
  local fat = math.max(0, vol.fat.x)
  local stretch = math.max(0, vol.stretch.x)
  local h = 6 + 4 * fat - 2 * stretch / VOL.stretch
  local fv = math.max(0, vol.fill.x)
  local boost_w = VOL.boost * vol.boost_frac(fv)
  local y0, y1 = cy - h / 2, cy + h / 2
  fill_rect(tx0, y0, tx0 + VOL.track + boost_w + stretch, y1, h / 2, C.white, 0.2 * a, clip)
  local fill_px = clamp(fv, 0, 100) / 100 * VOL.track + (fv >= 99.5 and stretch or 0)
  if fill_px > 0.5 then
    if fat > 0.05 then fill_rect(tx0, y0, tx0 + fill_px, y1, h / 2, C.white, 0.35 * math.min(fat, 1) * a, '\\blur5' .. clip) end
    fill_rect(tx0, y0, tx0 + fill_px, y1, h / 2, C.white, a, clip)
  end
  if boost_w > 2.5 then
    fill_rect(tx0 + VOL.track + 2, y0, tx0 + VOL.track + boost_w, y1, h / 2, C.boost, a, clip)
  end
  local real = clamp(media.volume, 0, 100) / 100 * VOL.track
  if vol.ghost.x > 0.01 then
    fill_rect(tx0 + real - 1, y0 - 3, tx0 + real + 1, y1 + 3, 1, C.white, 0.55 * vol.ghost.x * a, clip)
  end
  -- 气泡跟着填充的末端走（静音时跟着刻痕）
  lay.vol_anchor = tx0 + ((media.mute or media.volume <= 0) and real or fill_px + boost_w)
end

local function draw_vol_bubble(lay, f)
  local b = vol.bubble.x
  if b <= 0.01 or not lay.vol_anchor then return end
  local op = b * f
  local muted = media.mute or media.volume <= 0
  local boost = not muted and media.volume > 100.5
  local label_w
  if muted then
    label_w = text_width(L('muted'), 13, true)
  else
    label_w = #tostring(math.floor(media.volume + 0.5)) * digit_w(14)
    if boost then label_w = label_w + 5 + text_width(L('boost'), 11, true) end
  end
  local w = math.max(46, label_w + 22)
  local h = 30
  local cx = clamp(lay.vol_anchor, lay.panel.x0 + w / 2, lay.panel.x1 - w / 2)
  local cyb = lay.panel.y0 - 10 - h / 2 + 8 * (1 - b)
  glass(cx - w / 2, cyb - h / 2, cx + w / 2, cyb + h / 2, h / 2, op)
  if muted then
    text(cx, cyb, 5, 13, C.text, op, L('muted'), true)
    return
  end
  local x0 = cx - label_w / 2
  local digits_w = #tostring(math.floor(media.volume + 0.5)) * digit_w(14)
  draw_digits(x0 + digits_w, cyb, 14, C.text, op, media.volume)
  if boost then text(x0 + digits_w + 5, cyb, 4, 11, C.boost, op, L('boost'), true) end
end

local function draw_panel(lay, f)
  local P = lay.panel
  -- 面板后面压暗一层，免得浅色的画面上看不清
  fill_rect(-40, P.y0 - 70, ui.W + 40, ui.H + 60, 0, C.black, 0.5 * f, '\\blur45')
  glass(P.x0, P.y0, P.x1, P.y1, PANEL_R, f)

  draw_seek_bar(lay, f)

  lay_cy = lay.cy
  draw_volume(lay, f)
  for _, b in ipairs(lay.buttons) do draw_button(b, f) end

  -- 时间：当前位置亮一些、总时长暗一些，同一行里换颜色；放不下总时长就只写当前位置。
  -- 跟着音量胶囊的宽度走（胶囊展开时往右让）
  local cur = fmt_time(position(), false)
  local total = media.duration > 0 and (' / ' .. fmt_time(media.duration, false)) or ''
  local room_w = lay.right_x - lay.time_x
  if total ~= '' and room_w > text_width(cur .. total, 15, false) then
    text_runs(lay.time_x, lay.cy, 4, 15, f, { { C.text, cur }, { C.dim, total } })
  elseif room_w > text_width(cur, 15, false) then
    text(lay.time_x, lay.cy, 4, 15, C.text, f, cur)
  end

  if lay.divider then fill_rect(lay.divider - 0.5, lay.cy - 11, lay.divider + 0.5, lay.cy + 11, 0, C.white, 0.14 * f) end

  -- 鼠标停在按钮上：上方给一句说明。按这一次排版里的按钮取（点完按钮说明会变，比如弹幕开关）。
  -- 音量的数值气泡出来了就不再叠说明
  local h = nil
  if ui.hover then
    for _, b in ipairs(lay.buttons) do
      if b.id == ui.hover.id then h = b end
    end
  end
  if h and h.id == 'mute' and vol.bubble.x > 0.05 then h = nil end
  if h and h.tip and not ui.menu and not ui.drag then
    -- 说明后面跟着快捷键（暗一些、加个键帽）
    local kw = h.key and (text_width(h.key, 11, false) + 14) or 0
    local tw = 14 + text_width(h.tip, 13, false) + (h.key and (10 + kw + 6) or 14)
    local x0 = clamp(h.cx - tw / 2, 12, ui.W - 12 - tw)
    local y1 = P.y0 - 10
    glass(x0, y1 - 34, x0 + tw, y1, 17, f)
    text(x0 + 14, y1 - 17, 4, 13, C.body, f, h.tip)
    if h.key then keycap(x0 + tw - 6 - kw, y1 - 17, h.key, 11, f) end
  end

  draw_vol_bubble(lay, f)
end

local function draw_top(lay, f)
  local W = ui.W
  fill_rect(-40, -80, W + 40, 100, 0, C.black, 0.55 * f, '\\blur40')
  local title = room.title and room.title ~= '' and room.title or media.title
  text(32, 22, 7, 20, C.text, f, fit(title, 20, true, lay.title_max), true)
  if room.subtitle and room.subtitle ~= '' then
    text(32, 52, 7, 13, 'B4BFCD', f, fit(room.subtitle, 13, false, lay.title_max))
  end

  if lay.chip then
    local c = lay.chip
    local tone = room.chip.tone
    local cy = (c.y0 + c.y1) / 2
    if tone == 'wait' then
      glass(c.x0, c.y0, c.x1, c.y1, 16, f, { rim = C.host, rim_op = 0.5 })
    else
      glass(c.x0, c.y0, c.x1, c.y1, 16, f)
    end
    local dot = ({ sync = C.ok, wait = C.host, paused = C.dim, manual = C.manual })[tone]
    local dx = c.x0 + 16
    if dot == C.dim then
      circle(dx, cy, 4, dot, f)
    elseif dot then
      glow_dot(dx, cy, dot, f)
    else
      ring_rect(dx - 4, cy - 4, dx + 4, cy + 4, 4, 1.5, C.sub, f)
    end
    text(c.x0 + 29, cy, 4, 13, C.body, f, room.chip.text)
  end

  if lay.wc then
    local r = lay.wc_rect
    glass(r.x0, r.y0, r.x1, r.y1, 18, f)
    for _, h in ipairs(lay.hits) do
      if h.win then
        local hovered = ui.hover and ui.hover.id == h.id
        local cy = (r.y0 + r.y1) / 2
        if hovered then
          if h.id == 'close' then
            fill_rect(h.vx0, cy - 15, h.vx1, cy + 15, 15, C.danger, f)
          else
            bead(h.vx0, cy - 15, h.vx1, cy + 15, 15, f, 0.14)
          end
        end
        local name = h.id == 'minimize' and 'winMin' or h.id == 'close' and 'winClose' or (media.maximized and 'winRestore' or 'winMax')
        icon(name, (h.vx0 + h.vx1) / 2, cy, 17, hovered and h.id == 'close' and C.white or 'C9D2DE', f, 1.1)
      end
    end
  end
end

-- 和房主差开了（在线视频的手动同步）：顶部正中一条，带「同步到房主」按钮。不跟着控件收起
local function draw_drift(lay)
  local d = lay.drift
  if not d then return end
  glass(d.x0, d.y0, d.x1, d.y1, 22, 1, { rim = C.host, rim_op = 0.45, glow = C.host, glow_op = 0.18 })
  local cy = (d.y0 + d.y1) / 2
  glow_dot(d.x0 + 20, cy, C.host, 1)
  text(d.x0 + 34, cy, 4, 14, C.text, 1, room.drift.text)
  local b = lay.drift_btn
  local hovered = ui.hover and ui.hover.id == 'sync'
  fill_rect(b.x0, b.y0 + 3, b.x1, b.y1 + 3, 17, C.accent, 0.35, '\\blur6' .. clip_shape(b.x0, b.y0, b.x1, b.y1, 17, true))
  fill_rect(b.x0, b.y0, b.x1, b.y1, 17, C.accent, hovered and 0.82 or 0.92)
  ring_rect(b.x0, b.y0, b.x1, b.y1, 17, 1, C.white, 0.42, clip_rect(b.x0, b.y0, b.x1, b.y0 + 8))
  icon('sync', b.x0 + 12 + 7.5, cy, 15, C.white, 1, 2.2)
  local tx = b.x0 + 12 + 15 + 8
  text(tx, cy, 4, 13, C.white, 1, room.drift.button, true)
  local key = room.drift.key
  if key and key ~= '' then
    local kx = tx + text_width(room.drift.button, 13, true) + 8
    local kw = text_width(key, 11, false) + 16
    fill_rect(kx, cy - 11, kx + kw, cy + 11, 11, C.black, 0.22)
    text(kx + kw / 2, cy, 5, 11, C.white, 1, key)
  end
end

local function draw_spinner(cx, cy, r, width, color)
  local a0 = (now() * 300) % 360
  stroke_event({ arc_path(0, 0, r, 0, 360) }, cx, cy, 1, width, C.white, 0.12)
  stroke_event({ arc_path(0, 0, r, a0, a0 + 90) }, cx, cy, 1, width, color, 1)
end

-- 全员暂停在等人缓冲：画面压暗，正中一张卡片。控件露出来时卡片挪到面板上方，别被面板压住
local function draw_stall(lay, f)
  local s = room.stall
  local W, H = ui.W, ui.H
  fill_rect(-10, -10, W + 10, H + 10, 0, C.black, 0.45)
  local w = math.min(440, W - 48)
  local inner = w - 64
  local title = fit(s.title or '', 22, true, inner)
  local sub = s.sub and s.sub ~= '' and fit(s.sub, 14, false, inner) or nil
  local has_bar = type(s.progress) == 'number'
  local note = s.note and s.note ~= '' and fit(s.note, 13, false, inner) or nil
  local h = 28 + 44 + 16 + 30 + (sub and 26 or 0) + ((has_bar or s.left or s.right) and 42 or 0) + (note and 36 or 0) + 22
  local x0 = math.floor(W / 2 - w / 2)
  local y0 = math.floor(H / 2 - h / 2)
  if lay and f > 0 then y0 = math.max(8, math.min(y0, lay.panel.y0 - 12 - h)) end
  glass(x0, y0, x0 + w, y0 + h, 30, 1, { base = C.deep, base_op = DEEP_OP, shadow = 0.5 })
  local cx = W / 2
  local y = y0 + 28
  draw_spinner(cx, y + 22, 18, 4, C.accent)
  y = y + 44 + 16
  text(cx, y, 8, 22, C.text, 1, title, true)
  y = y + 30
  if sub then
    text(cx, y, 8, 14, 'B4BFCD', 1, sub)
    y = y + 26
  end
  if has_bar or s.left or s.right then
    y = y + 8
    if has_bar then
      local fx = x0 + 32 + clamp(s.progress, 0, 1) * inner
      fill_rect(x0 + 32, y, x0 + w - 32, y + 6, 3, C.white, 0.12)
      if fx > x0 + 33 then
        fill_rect(x0 + 32, y, fx, y + 6, 3, C.accent, 0.5, '\\blur4')
        fill_rect(x0 + 32, y, fx, y + 6, 3, C.accent, 1)
      end
    end
    if s.left then text(x0 + 32, y + 14, 7, 13, C.body, 1, fit(s.left, 13, false, inner / 2)) end
    if s.right then text(x0 + w - 32, y + 14, 9, 13, 'B4BFCD', 1, fit(s.right, 13, false, inner / 2)) end
    y = y + 34
  end
  if note then
    fill_rect(x0 + 32, y + 6, x0 + w - 32, y + 7, 0, C.white, 0.08)
    text(cx, y + 18, 8, 13, '9AA6B6', 1, note)
  end
end

-- 刚打开、在线视频在缓冲：正中一颗玻璃珠里转圈
local function draw_busy(label)
  local cx, cy = ui.W / 2, ui.H / 2
  glass(cx - 38, cy - 46, cx + 38, cy + 30, 38, 1)
  draw_spinner(cx, cy - 8, 18, 4, C.accent)
  if label and label ~= '' then
    local tw = text_width(label, 14, false) + 28
    glass(cx - tw / 2, cy + 40, cx + tw / 2, cy + 72, 16, 1)
    text(cx, cy + 56, 5, 14, C.body, 1, label)
  end
end

-- 控件收起时调音量：顶部那条音量胶囊（喇叭、音量条、滚动的数字）
local function draw_volume_hud(y, op)
  local muted = media.mute or media.volume <= 0
  local boost_w = 22 * vol.boost_frac(math.max(0, vol.fill.x))
  local bar_w = 150 + boost_w
  local w = 14 + 22 + 12 + bar_w + 12 + 56 + 18
  local x0 = math.floor(ui.W / 2 - w / 2)
  local cy = y + 24
  glass(x0, y, x0 + w, y + 48, 24, op)
  draw_speaker(x0 + 14 + 11, cy, 22, C.body, op)
  local bx = x0 + 14 + 22 + 12
  fill_rect(bx, cy - 3, bx + bar_w, cy + 3, 3, C.white, 0.2 * op)
  local fv = clamp(vol.fill.x, 0, 100) / 100 * 150
  if fv > 0.5 then fill_rect(bx, cy - 3, bx + fv, cy + 3, 3, C.white, op) end
  if boost_w > 2.5 then fill_rect(bx + 152, cy - 3, bx + 150 + boost_w, cy + 3, 3, C.boost, op) end
  local xr = x0 + w - 18
  if muted then
    text(xr, cy, 6, 14, 'C9D2DE', op, L('muted'), true)
  else
    local pw = text_width('%', 12, true)
    text(xr, cy + 0.5, 6, 12, C.sub, op, '%', true)
    draw_digits(xr - pw - 1, cy, 15, C.text, op, media.volume)
  end
end

local function draw_toasts(start_y)
  local y = start_y
  local t = now()
  for _, item in ipairs(ui.toasts) do
    if item.until_t > t then
      -- 进场：从上面落下来、略微越过一点；退场：往上收、淡掉
      local appear = clamp((t - item.t0) / TOAST_S.enter, 0, 1)
      local leave = clamp((item.until_t - t) / TOAST_S.leave, 0, 1)
      local op = math.min(clamp((t - item.t0) / 0.2, 0, 1), leave)
      local ty = y - 14 * (1 - back_out(appear)) - 10 * (1 - leave)
      if item.tone == 'volume' then
        draw_volume_hud(ty, op)
        y = y + 56
      else
        local icon_name = item.tone == 'ok' and 'shield' or item.tone == 'warn' and 'warning' or nil
        local tw = text_width(item.text, 14, false)
        local w = math.min((icon_name and (12 + 19 + 10) or 16) + tw + 16, ui.W - 24)
        local x0 = math.floor(ui.W / 2 - w / 2)
        local cy = ty + 20
        if item.tone == 'warn' then
          glass(x0, ty, x0 + w, ty + 40, 20, op, { rim = C.warn, rim_op = 0.55 })
        else
          glass(x0, ty, x0 + w, ty + 40, 20, op)
        end
        local tx = x0 + 16
        if icon_name then
          icon(icon_name, x0 + 12 + 9.5, cy, 19, item.tone == 'ok' and C.ok or C.mark, op, 1.9)
          tx = x0 + 12 + 19 + 10
        end
        text(tx, cy, 4, 14, C.text, op, fit(item.text, 14, false, w - (tx - x0) - 16))
        y = y + 48
      end
    end
  end
end

-- 2 倍速快进那一条（自己按着、别人按着都是这个样子）：蓝色描边、带一圈光
local function draw_rate_bar(y, label, note)
  local tw = text_width(label, 14, true)
  local nw = note and (text_width(note, 13, false) + 10) or 0
  local w = math.min(12 + 20 + 10 + tw + nw + 18, ui.W - 24)
  local x0 = math.floor(ui.W / 2 - w / 2)
  local cy = y + 20
  glass(x0, y, x0 + w, y + 40, 20, 1, { rim = C.accent, rim_op = 0.6, glow = C.accent, glow_op = 0.22 })
  icon('ffwd', x0 + 12 + 10, cy, 18, '6FA3FF', 1)
  text(x0 + 12 + 20 + 10, cy, 4, 14, C.text, 1, fit(label, 14, true, w - (12 + 20 + 10) - 16), true)
  if note then text(x0 + 12 + 20 + 10 + tw + 10, cy, 4, 13, 'B4BFCD', 1, fit(note, 13, false, w - (12 + 20 + 10 + tw + 10) - 16)) end
end

-- 长按 → 快进时顶部那一条：「▶▶ 2 倍速快进中 全房跟着一起快进」（房里有别人时才说后半句）
local function draw_hold(y)
  draw_rate_bar(y, L('speedHold'), room.chip and L('speedHoldNote') or nil)
end

-- 别人按着 → 让全房快进时顶部那一条：「▶▶ 全房 2 倍速 · 谁在快进」
local function draw_room_rate(y)
  draw_rate_bar(y, room.rate.text, nil)
end

-- 快捷键一览（? / F1）：画面压暗，正中一张两列的表
local function draw_help()
  local W, H = ui.W, ui.H
  fill_rect(-10, -10, W + 10, H + 10, 0, C.black, 0.5)
  local rows = {}
  local kw, dw = 0, 0
  for _, r in ipairs(HELP_ROWS) do
    local key = r[1]:sub(1, 1) == '@' and L(r[1]:sub(2)) or r[1]
    local desc = L(r[2])
    rows[#rows + 1] = { key, desc }
    kw = math.max(kw, text_width(key, 12, false) + 14)
    dw = math.max(dw, text_width(desc, 14, false))
  end
  local colw = kw + 14 + dw
  local cols = (2 * colw + 40 + 64 <= W - 32) and 2 or 1
  local per = math.ceil(#rows / cols)
  local note = L('helpNote')
  local w = math.max(cols * colw + (cols - 1) * 40 + 64, text_width(note, 12, false) + 64)
  w = math.min(w, W - 24)
  local h = 28 + 22 + 20 + per * 32 + 12 + 20 + 22
  local x0 = math.floor(W / 2 - w / 2)
  local y0 = math.max(12, math.floor(H / 2 - h / 2))
  glass(x0, y0, x0 + w, y0 + h, 24, 1, { base = C.deep, base_op = 0.9, shadow = 0.5 })
  text(x0 + 32, y0 + 28, 7, 18, C.text, 1, L('helpTitle'), true)
  local ry = y0 + 28 + 22 + 20
  for i, r in ipairs(rows) do
    local col = math.floor((i - 1) / per)
    local cx = x0 + 32 + col * (colw + 40)
    local cy = ry + ((i - 1) % per) * 32 + 11
    keycap(cx, cy, r[1], 12, 1)
    text(cx + kw + 14, cy, 4, 14, 'C9D2DE', 1, fit(r[2], 14, false, dw + 4))
  end
  text(x0 + 32, y0 + h - 22 - 10, 4, 12, '9AA6B6', 1, fit(note, 12, false, w - 64))
end

local function draw_menu(lay)
  local M = lay.menu
  if not M or not ui.menu then return end
  local m = ui.menu
  glass(M.x0, M.y0, M.x1, M.y1, 22, 1, { base = C.deep, base_op = DEEP_OP, shadow = 0.5 })
  if m.title then
    text(M.x0 + 20, M.y0 + 8 + 17, 4, 13, C.text, 1, m.title, true)
    if m.note then text(M.x1 - 20, M.y0 + 8 + 17, 6, 12, C.dim, 1, m.note) end
  end
  for _, h in ipairs(lay.hits) do
    if h.id == 'item' then
      local it = h.item
      -- 鼠标停着的、或者键盘移到的那一项
      local hovered = (ui.hover and ui.hover.id == 'item' and ui.hover.index == h.index) or (m.kbd and m.cursor == h.index)
      if it.selected then
        fill_rect(h.x0, h.y0, h.x1, h.y1, 13, C.accent, 0.24)
        ring_rect(h.x0, h.y0, h.x1, h.y1, 13, 1, '6EA0FF', 0.22)
        ring_rect(h.x0, h.y0, h.x1, h.y1, 13, 1, 'A0C3FF', 0.32, clip_rect(h.x0, h.y0, h.x1, h.y0 + 7))
        if hovered then fill_rect(h.x0, h.y0, h.x1, h.y1, 13, C.white, 0.05) end
      elseif hovered then
        fill_rect(h.x0, h.y0, h.x1, h.y1, 13, C.white, 0.08)
      end
      local cy = (h.y0 + h.y1) / 2
      text(h.x0 + 12, cy, 4, 14, it.selected and C.white or 'C9D2DE', 1, fit(it.label, 14, it.selected, h.x1 - h.x0 - 48), it.selected)
      if it.selected then icon('check', h.x1 - 12 - 8, cy, 16, C.accentText, 1, 2.4) end
    end
  end
  -- 放不下、要滚着看：右边一条滚动条，看得出上下还有多少
  if M.scroll then
    local n = #m.items
    local ty0, ty1 = M.list_y0, M.list_y0 + m.visible * MENU_ROW - 2
    local tx = M.x1 - 10
    fill_rect(tx, ty0, tx + 3, ty1, 1.5, C.white, 0.08)
    local th = math.max(18, (ty1 - ty0) * m.visible / n)
    local ty = ty0 + (ty1 - ty0 - th) * (m.offset / math.max(1, n - m.visible))
    fill_rect(tx, ty, tx + 3, ty + th, 1.5, C.white, 0.4)
  end
end

-- 控件收起时贴在底边的一条细线
local function draw_mini(op)
  if media.duration <= 0 or op <= 0 then return end
  if room.miniBar == false or (room.miniBar == nil and not opts.mini_bar) then return end
  local W, H = ui.W, ui.H
  fill_rect(0, H - 3, W, H, 0, C.white, 0.12 * op)
  local ranges = ranges_now()
  if ranges then
    for _, r in ipairs(ranges) do
      fill_rect(clamp(r[1], 0, 1) * W, H - 3, clamp(r[2], 0, 1) * W, H, 0, C.white, 0.3 * op)
    end
  end
  fill_rect(0, H - 3, clamp(position() / media.duration, 0, 1) * W, H, 0, C.white, op)
  local hp = host_position()
  if hp then
    local hx = clamp(hp / media.duration, 0, 1) * W
    fill_rect(hx - 1, H - 7, hx + 1, H, 0, C.host, op)
  end
  for _, m in ipairs(room.marks or {}) do
    local mx = clamp(m.t / media.duration, 0, 1) * W
    fill_rect(mx - 1.5, H - 7, mx + 1.5, H, 0, C.mark, op)
  end
end

-- 表情反应：从右下往上飘，边飘边淡，下面写着谁发的
local function draw_reactions()
  local t = now()
  for i = #ui.reactions, 1, -1 do
    if t - ui.reactions[i].t0 >= REACTION_S then table.remove(ui.reactions, i) end
  end
  local base_x = ui.W - (ui.W < 700 and 70 or 110)
  local base_y = ui.H - (ui.target > 0 and ui.layout and (ui.H - ui.layout.panel.y0 + 40) or 60)
  for _, r in ipairs(ui.reactions) do
    local age = (t - r.t0) / REACTION_S
    local op = age < 0.1 and age / 0.1 or age > 0.6 and math.max(0, (1 - age) / 0.4) or 1
    local x = base_x + r.x + math.sin(age * math.pi * 2 + r.x) * 8
    local y = base_y - age * math.min(320, ui.H * 0.45)
    local size = 44 * (age < 0.12 and (0.6 + age / 0.12 * 0.4) or 1)
    text(x, y, 2, size, REACTION_COLORS[r.e + 1] or C.white, op, REACTIONS[r.e + 1], false, '\\bord1.2\\3c&H000000&\\3a&H60&')
    if r.name ~= '' then text(x, y + 4, 8, 12, C.sub, op, fit(r.name, 12, false, 120), false, '\\bord1\\3c&H000000&\\3a&H80&') end
  end
end

--------------------------------------------------------------------------------
-- 一次完整的重画
--------------------------------------------------------------------------------

local function set_area(section, x0, y0, x1, y1)
  local px = ui.px
  mp.set_mouse_area(math.floor(x0 * px), math.floor(y0 * px), math.ceil(x1 * px), math.ceil(y1 * px), section)
end

local function set_section(section, on, flags)
  if ui.sections[section] == on then return end
  ui.sections[section] = on
  if on then mp.enable_key_bindings(section, flags) else mp.disable_key_bindings(section) end
end

local function update_input(lay)
  local shown = ui.target > 0
  set_area('nx-showhide', 0, 0, ui.W, ui.H)
  if ui.menu or ui.help then
    -- 菜单、快捷键一览开着：点哪都先把它收起来
    set_area('nx-bottom', 0, 0, ui.W, ui.H)
  elseif shown and lay then
    local P = lay.panel
    set_area('nx-bottom', P.x0, P.y0, P.x1, P.y1)
  else
    set_area('nx-bottom', 0, 0, 0, 0)
  end
  set_section('nx-bottom', (shown and lay ~= nil) or ui.menu ~= nil or ui.help)
  if shown and lay and lay.wc then
    set_area('nx-wc', lay.wc_x0, 0, ui.W, lay.wc_rect.y1)
    set_section('nx-wc', true)
  else
    set_area('nx-wc', 0, 0, 0, 0)
    set_section('nx-wc', false)
  end
  if lay and lay.drift then
    local d = lay.drift_btn
    set_area('nx-pill', d.x0, d.y0, d.x1, d.y1)
    set_section('nx-pill', true)
  else
    set_area('nx-pill', 0, 0, 0, 0)
    set_section('nx-pill', false)
  end
end

-- 让 mpv 的输入框（聊天脚本的 mp.input）躲开控制条
local function update_margins(lay)
  local b = 0
  if ui.target > 0 and lay then b = (ui.H - lay.panel.y0 + 8) / ui.H end
  if ui.margins == b then return end
  ui.margins = b
  mp.set_property_native('user-data/osc/margins', { l = 0, r = 0, t = 0, b = b })
end

local function osd_size()
  local w, h = mp.get_osd_size()
  if (not w or w <= 0 or not h or h <= 0) and opts.debug and opts.debug_size ~= '' then
    local dw, dh = opts.debug_size:match('^(%d+)x(%d+)$')
    w, h = tonumber(dw), tonumber(dh)
  end
  return w, h
end

-- 转圈至少过这么久才出现：本地文件跳转几毫秒就好，别闪一下
local WAIT_SPINNER_S = 0.5
-- 两次重画之间至少隔这么久（约一帧）
local MIN_RENDER_GAP_S = 1 / 60

local function render()
  local ow, oh = osd_size()
  if not ow or ow <= 0 or not oh or oh <= 0 then return end
  local scale = (mp.get_property_number('display-hidpi-scale', 1) or 1) * (tonumber(opts.scale) or 1)
  if scale <= 0 then scale = 1 end
  -- 窗口很小时整体缩小，至少按 560×320 排得下
  if ow / scale < 560 then scale = ow / 560 end
  if oh / scale < 320 then scale = math.min(scale, oh / 320) end
  ui.px = scale
  ui.W = math.floor(ow / scale + 0.5)
  ui.H = math.floor(oh / scale + 0.5)

  events = {}
  local t = now()
  for i = #ui.toasts, 1, -1 do
    if ui.toasts[i].until_t <= t then table.remove(ui.toasts, i) end
  end

  local lay = has_media() and layout() or nil
  ui.layout = lay
  local f = ui.fade

  local spinning = false
  if room.stall then
    draw_stall(lay, f)
    spinning = true
  elseif media.loading then
    draw_busy(L('opening'))
    spinning = true
  elseif media.buffering then
    local pct = media.buffering_pct and string.format(' %d%%', media.buffering_pct) or ''
    draw_busy(L('buffering') .. pct)
    spinning = true
  elseif media.wait_since and t - media.wait_since >= WAIT_SPINNER_S then
    -- 跳转后在等数据（在线视频跳一次要好几秒，paused-for-cache 这时还是假的）
    draw_busy(L('buffering'))
    spinning = true
  end

  if lay then
    if f < 1 then draw_mini(1 - f) end
    if f > 0 then
      draw_panel(lay, f)
      draw_top(lay, f)
    end
    draw_drift(lay)
    draw_menu(lay)
  end
  local toast_y = (f > 0.5 or (lay and lay.drift)) and 72 or 24
  if ui.hold.active then
    draw_hold(toast_y)
    toast_y = toast_y + 48
  elseif room.rate then
    draw_room_rate(toast_y)
    toast_y = toast_y + 48
  end
  draw_toasts(toast_y)
  draw_reactions()
  if ui.help then draw_help() end

  -- 转圈要一直转：显示着的时候每秒重画 15 次（再快看不出区别，4K 下白费 CPU）
  if spinning and not timers.busy then
    timers.busy = mp.add_periodic_timer(1 / 15, function() request() end)
  elseif not spinning and timers.busy then
    timers.busy:kill()
    timers.busy = nil
  end
  -- 表情在飘的时候每秒重画 30 次，飘完就停
  if #ui.reactions > 0 and not timers.react then
    timers.react = mp.add_periodic_timer(1 / 30, function() request() end)
  elseif #ui.reactions == 0 and timers.react then
    timers.react:kill()
    timers.react = nil
  end

  overlay.res_x = ui.W
  overlay.res_y = ui.H
  overlay.z = 10
  overlay.data = table.concat(events, '\n')
  overlay:update()
  if opts.debug then mp.set_property_native('user-data/noxreel_osc/ass', { w = ui.W, h = ui.H, data = overlay.data }) end

  update_input(lay)
  update_margins(lay)
end

local render_pending = false
local last_render = -1
local safe_render = guard(render)

-- 合并重画：同一轮事件里的多次请求只画一次，两次之间至少隔一帧（鼠标事件很密时不跟着每个事件重画）
request = function()
  if render_pending then return end
  render_pending = true
  local wait = math.max(0, last_render + MIN_RENDER_GAP_S - now())
  mp.add_timeout(wait, function()
    render_pending = false
    last_render = now()
    safe_render()
  end)
end

--------------------------------------------------------------------------------
-- 显示 / 收起
--------------------------------------------------------------------------------

local function want_visible()
  if not has_media() then return false end
  if ui.menu or ui.drag or ui.pressed then return true end
  local t = now()
  if t < ui.flash_until then return true end
  if not ui.mouse_in then return false end
  if ui.over then return true end
  if t - ui.last_move < opts.hide_ms / 1000 then return true end
  return media.pause and not room.stall
end

local function step_fade()
  local dur = ui.target > ui.fade_from and 0.12 or 0.2
  local p = clamp((now() - ui.fade_start) / dur, 0, 1)
  ui.fade = ui.fade_from + (ui.target - ui.fade_from) * p
  if p >= 1 and timers.fade then
    timers.fade:kill()
    timers.fade = nil
  end
  request()
end

local function check_visibility()
  local target = want_visible() and 1 or 0
  if target ~= ui.target then
    ui.target = target
    if target == 0 then
      -- 控件收起：音量胶囊跟着收，下次露出来是收起的
      vol.hover = false
      vol.collapse()
    end
    ui.fade_from = ui.fade
    ui.fade_start = now()
    if not timers.fade then timers.fade = mp.add_periodic_timer(1 / 60, guard(step_fade)) end
    request()
  end
end

--------------------------------------------------------------------------------
-- 菜单
--------------------------------------------------------------------------------

-- 菜单开着时键盘归菜单：↑↓ 选、Enter 确定、Esc 关（盖过 ↑↓ 调音量、Enter 全屏）
local MENU_KEYS = { 'nx-menu-esc', 'nx-menu-up', 'nx-menu-down', 'nx-menu-enter', 'nx-menu-kpenter' }

local function close_menu()
  if not ui.menu then return end
  ui.menu = nil
  for _, name in ipairs(MENU_KEYS) do pcall(mp.remove_key_binding, name) end
  request()
end

-- 键盘在菜单里移动：光标项一定在可见范围里
local function menu_move(step)
  local m = ui.menu
  if not m then return end
  m.cursor = clamp((m.cursor or 1) + step, 1, #m.items)
  m.kbd = true
  ui.hover = nil
  local visible = m.visible or #m.items
  if m.cursor <= (m.offset or 0) then m.offset = m.cursor - 1 end
  if m.cursor > (m.offset or 0) + visible then m.offset = m.cursor - visible end
  request()
end

local function menu_confirm()
  local m = ui.menu
  local it = m and m.items[m.cursor or 1]
  close_menu()
  if it then it.run() end
end

local function track_label(t)
  local parts = {}
  if t.title and t.title ~= '' then parts[#parts + 1] = t.title end
  if t.lang and t.lang ~= '' and t.lang ~= t.title then parts[#parts + 1] = t.lang end
  if #parts == 0 then parts[1] = L('track') .. ' ' .. tostring(t.id) end
  return table.concat(parts, ' · ')
end

-- keep_offset：状态变了按新状态重开时，保持原来滚到的位置
-- 发一个表情反应（第几个，0 起）。飘的那一下由 NoxReel 发给大家之后再推回来画，自己的也一样
local function send_reaction(e)
  mp.commandv('script-message', MESSAGE, 'react', tostring(e))
end

local function open_menu(kind, keep_offset)
  local m = { anchor = kind, items = {} }
  if kind == 'subs' then
    m.title, m.note = L('subs'), 'C'
    local any = false
    for _, t in ipairs(media.tracks) do if t.type == 'sub' and t.selected then any = true end end
    m.items[#m.items + 1] = { label = L('subsOff'), selected = not any, run = function() mp.set_property('sid', 'no') end }
    for _, t in ipairs(media.tracks) do
      if t.type == 'sub' then
        local id = t.id
        m.items[#m.items + 1] = { label = track_label(t), selected = t.selected == true, run = function() mp.set_property_number('sid', id) end }
      end
    end
    -- 成员自己加的字幕，只影响自己。文件对话框由 NoxReel 开：全屏时它会被播放器挡住，先退出全屏
    m.items[#m.items + 1] = {
      label = L('loadSub'),
      run = function()
        if media.fullscreen then mp.set_property_bool('fullscreen', false) end
        mp.commandv('script-message', MESSAGE, 'load-sub')
      end,
    }
  elseif kind == 'react' then
    for i, glyph in ipairs(REACTIONS) do
      local e = i - 1
      m.items[#m.items + 1] = { label = glyph .. '    ' .. i, run = function() send_reaction(e) end }
    end
  elseif kind == 'audio' then
    m.title, m.note = L('audio'), 'A'
    for _, t in ipairs(media.tracks) do
      if t.type == 'audio' then
        local id = t.id
        m.items[#m.items + 1] = { label = track_label(t), selected = t.selected == true, run = function() mp.set_property_number('aid', id) end }
      end
    end
  elseif kind == 'quality' and room.quality then
    m.title = L('quality')
    m.note = L('qualityNote')
    for _, o in ipairs(room.quality.options or {}) do
      local h = o.h
      m.items[#m.items + 1] = {
        label = o.label,
        selected = h == room.quality.current,
        run = function()
          if h ~= room.quality.current then mp.commandv('script-message', MESSAGE, 'quality', tostring(h)) end
        end,
      }
    end
  end
  -- 放不下的滚着看（见 layout）；这里只挡住离谱的数量
  while #m.items > 300 do table.remove(m.items) end
  if #m.items == 0 then return end
  local selected = 1
  for i, it in ipairs(m.items) do
    if it.selected then selected = i end
  end
  if keep_offset then
    m.offset = keep_offset.offset
    m.cursor = clamp(keep_offset.cursor or selected, 1, #m.items)
  else
    m.want = selected
    m.cursor = selected
  end
  ui.menu = m
  mp.add_forced_key_binding('ESC', 'nx-menu-esc', guard(close_menu))
  mp.add_forced_key_binding('UP', 'nx-menu-up', guard(function() menu_move(-1) end), { repeatable = true })
  mp.add_forced_key_binding('DOWN', 'nx-menu-down', guard(function() menu_move(1) end), { repeatable = true })
  mp.add_forced_key_binding('ENTER', 'nx-menu-enter', guard(menu_confirm))
  mp.add_forced_key_binding('KP_ENTER', 'nx-menu-kpenter', guard(menu_confirm))
  request()
end

local function toggle_menu(kind)
  if ui.menu and ui.menu.anchor == kind then close_menu() else open_menu(kind) end
end

--------------------------------------------------------------------------------
-- 鼠标
--------------------------------------------------------------------------------

local function mouse_pos()
  local x, y = mp.get_mouse_pos()
  return (x or -1) / ui.px, (y or -1) / ui.px
end

local function hit_at(x, y)
  local lay = ui.layout
  if not lay then return nil end
  for i = #lay.hits, 1, -1 do
    local h = lay.hits[i]
    local interactive = h.id ~= 'panel' and h.id ~= 'menu'
    local visible = ui.target > 0 or h.menu or h.id == 'sync'
    if visible and x >= h.x0 and x < h.x1 and y >= h.y0 and y < h.y1 then
      if interactive then return h end
      return nil
    end
  end
  return nil
end

local function over_ui(x, y)
  local lay = ui.layout
  if not lay then return false end
  local P = lay.panel
  if x >= P.x0 and x < P.x1 and y >= P.y0 - 6 and y < P.y1 then return true end
  if lay.menu and x >= lay.menu.x0 and x < lay.menu.x1 and y >= lay.menu.y0 and y < lay.menu.y1 then return true end
  if lay.wc and x >= lay.wc_x0 and y < lay.wc_rect.y1 + 6 then return true end
  return false
end

local function seek_frac(x)
  local S = ui.layout.seek
  return clamp((x - S.x0) / (S.x1 - S.x0), 0, 1)
end

local function set_volume_at(x)
  local v = ui.layout and ui.layout.vol
  if not v then return end
  local px = x - v.tx0
  local frac = clamp(px / VOL.track, 0, 1)
  -- 拖过右端：轨道被拉长（越往外越拉不动），音量停在 100
  local over = px - VOL.track
  spring_to(vol.stretch, over > 0 and math.min(VOL.stretch, over * 0.35) or 0, 60, 1)
  mp.set_property_number('volume', math.floor(frac * 100 + 0.5))
  if media.mute and frac > 0 then mp.set_property_bool('mute', false) end
end

local function on_move()
  ui.mouse_in = true
  ui.mx, ui.my = mouse_pos()
  ui.last_move = now()
  if ui.drag then
    if ui.drag.kind == 'seek' then ui.drag.frac = seek_frac(ui.mx) end
    if ui.drag.kind == 'vol' then set_volume_at(ui.mx) end
  end
  -- 先定显不显示：鼠标刚动的这一下就把控件叫出来了，悬停也该从这一下算起
  check_visibility()
  ui.hover = hit_at(ui.mx, ui.my)
  ui.over = over_ui(ui.mx, ui.my)
  vol.update_hover(ui.mx, ui.my)
  check_visibility()
  request()
end

local function on_leave()
  ui.mouse_in = false
  ui.hover = nil
  ui.over = false
  vol.update_hover(-1, -1)
  -- 鼠标离开窗口：菜单也收起来，不然它一直挂在画面上，回来第一下点击还会被吃掉
  close_menu()
  check_visibility()
  request()
end

local function guest_toast()
  toast(L('guestSeek'), 2000, 'info', 'guest')
end

local ACTIONS = {
  play = function() mp.commandv('cycle', 'pause') end,
  back = function()
    if can_seek() then mp.commandv('seek', '-10', 'relative+exact') else guest_toast() end
  end,
  fwd = function()
    if can_seek() then mp.commandv('seek', '10', 'relative+exact') else guest_toast() end
  end,
  mute = function() mp.commandv('cycle', 'mute') end,
  danmaku = function()
    -- 先把按钮翻过来，NoxReel 改完设置会再推一份状态
    room.danmaku = not room.danmaku
    mp.commandv('script-message', MESSAGE, 'danmaku')
  end,
  subs = function() toggle_menu('subs') end,
  audio = function() toggle_menu('audio') end,
  react = function() toggle_menu('react') end,
  quality = function() toggle_menu('quality') end,
  fullscreen = function() mp.commandv('cycle', 'fullscreen') end,
  minimize = function() mp.set_property_bool('window-minimized', true) end,
  maximize = function() mp.commandv('cycle', 'window-maximized') end,
  close = function() mp.commandv('quit') end,
  sync = function() mp.commandv('script-message', SYNC_MESSAGE) end,
}

local function close_help()
  if not ui.help then return end
  ui.help = false
  pcall(mp.remove_key_binding, 'nx-help-esc')
  request()
end

local function toggle_help()
  if ui.help then
    close_help()
    return
  end
  close_menu()
  ui.help = true
  mp.add_forced_key_binding('ESC', 'nx-help-esc', guard(close_help))
  request()
end

local function on_down()
  local x, y = mouse_pos()
  ui.mx, ui.my = x, y
  -- 快捷键一览开着：点哪都是关掉它
  if ui.help then
    close_help()
    return
  end
  local h = hit_at(x, y)
  if ui.menu and not (h and h.id == 'item') then
    local lay = ui.layout
    local inside_menu = lay and lay.menu and x >= lay.menu.x0 and x < lay.menu.x1 and y >= lay.menu.y0 and y < lay.menu.y1
    local on_anchor = h and h.id == ui.menu.anchor
    if not inside_menu and not on_anchor then close_menu() end
    if not on_anchor then return end
  end
  if not h then return end
  if h.id == 'seek' then
    if not can_seek() then
      guest_toast()
      return
    end
    if media.duration > 0 then ui.drag = { kind = 'seek', frac = seek_frac(x) } end
  elseif h.id == 'vol' then
    ui.drag = { kind = 'vol' }
    spring_to(vol.fat, 1, 24, 0.55)
    tween_to(vol.bubble, 1, 0.16)
    set_volume_at(x)
  else
    ui.pressed = h
  end
  request()
end

local function on_up()
  local x, y = mouse_pos()
  if ui.drag then
    local d = ui.drag
    ui.drag = nil
    -- 拖进度条只在松手时跳一次：房间里每一次跳转都要同步给所有人，拖的途中不该跳几十次。
    -- 拖的途中被降成游客（canSeek 变假）就不跳了
    if d.kind == 'seek' and media.duration > 0 and can_seek() then
      mp.commandv('seek', string.format('%.3f', d.frac * media.duration), 'absolute+exact')
    end
    if d.kind == 'vol' then vol.drag_end() end
  elseif ui.pressed then
    local p = ui.pressed
    ui.pressed = nil
    local h = hit_at(x, y)
    if h and h.id == p.id and (h.id ~= 'item' or h.index == p.index) then
      if h.id == 'item' then
        close_menu()
        h.item.run()
      elseif h.id == 'mark' then
        -- 点标记：控制者跳过去（和拖进度条一样同步给全房）；游客只提示
        if can_seek() then mp.commandv('seek', string.format('%.3f', h.t), 'absolute+exact') else guest_toast() end
      elseif ACTIONS[h.id] and not (h.disabled and h.id ~= 'back' and h.id ~= 'fwd') then
        ACTIONS[h.id]()
      end
    end
  end
  check_visibility()
  request()
end

-- delta：滚轮往上是正
local function on_wheel(delta)
  local x, y = mouse_pos()
  local lay = ui.layout
  -- 菜单开着、鼠标在菜单上：滚菜单
  if ui.menu and lay and lay.menu and x >= lay.menu.x0 and x < lay.menu.x1 and y >= lay.menu.y0 and y < lay.menu.y1 then
    ui.menu.offset = (ui.menu.offset or 0) + (delta > 0 and -1 or 1)
    ui.hover = nil
    request()
    return
  end
  local h = hit_at(x, y)
  if h and (h.id == 'vol' or h.id == 'mute') then
    -- 上限跟 mpv 的 volume-max 走（默认 130）：已经开到 100 以上时往上滚不能反倒压回 100
    local top = math.max(100, media.volume_max)
    mp.set_property_number('volume', clamp(math.floor(media.volume + delta + 0.5), 0, top))
  end
end

--------------------------------------------------------------------------------
-- 快捷键（? / F1 看一览）
--------------------------------------------------------------------------------
-- mpv 自带的键位大多照旧（空格、F、M、Esc、9/0、J、V……），下面这些按一起看片的习惯改掉或补上。
-- 一起看时每一次跳转都会同步给全房：随手就会碰到、又会把全房拽走的键（Home 回片头）去掉；
-- 改倍速会让自己和房间越差越远（没人纠正），[ ] { } 只提示不改，临时快进用长按 →。
-- 1–8 在 mpv 里是调对比度、亮度这些，OSD 文字关掉之后改了什么都看不出来，一并去掉。
-- 发弹幕的 D 在聊天脚本里（noxreel-chat.lua），和 Ctrl+Shift+D 同一个输入框。

-- → 按住超过这么久算长按
local HOLD_S = 0.35

local function bind(key, name, fn, flags)
  bound_keys[#bound_keys + 1] = name
  mp.add_key_binding(key, name, guard(fn), flags)
end

-- 键盘跳转：带 exact，说 5 秒就是 5 秒（按关键帧跳的话，关键帧稀的片子一下能跳出几十秒，全房跟着走）；
-- 游客直接说不行，不先跳再被拽回来
local function seek_by(sec)
  if not can_seek() then
    guest_toast()
    return
  end
  if media.duration <= 0 then return end
  mp.commandv('seek', tostring(sec), 'relative+exact')
end

local function chapter_by(step)
  if not can_seek() then
    guest_toast()
    return
  end
  if #media.chapters > 0 then mp.commandv('add', 'chapter', tostring(step)) end
end

-- 长按 → 结束：倍速回到原来的。report 为真时告诉 NoxReel 停在哪（房主 / 管理员据此把全房带过来）；
-- 换片途中收尾就不报（那个位置是上一部的）
local function end_hold(report)
  local h = ui.hold
  if not h.active then return end
  h.active = false
  h.quiet_until = now() + 0.6
  mp.set_property_number('speed', h.prev_speed or 1)
  if report then
    local pos = mp.get_property_number('time-pos')
    mp.commandv('script-message', MESSAGE, 'speed-hold', 'end', pos and string.format('%.3f', pos) or '')
  else
    mp.commandv('script-message', MESSAGE, 'speed-hold', 'cancel')
  end
  request()
end

-- →：点一下前进 5 秒；按住超过 HOLD_S 变 2 倍速，松手恢复（按住期间只有自己在快进，
-- 松手后房主 / 管理员的位置同步给全房 —— 和拖进度条松手一个道理）。游客不能快进，和不能跳转一样
local function right_key(t)
  local h = ui.hold
  if t.event == 'down' then
    if h.timer then h.timer:kill() end
    h.timer = mp.add_timeout(HOLD_S, guard(function()
      h.timer = nil
      if not can_seek() then
        guest_toast()
        return
      end
      if media.pause or not has_media() or media.duration <= 0 then return end
      h.active = true
      h.prev_speed = mp.get_property_number('speed', 1) or 1
      h.quiet_until = now() + 0.6
      mp.set_property_number('speed', 2)
      mp.commandv('script-message', MESSAGE, 'speed-hold', 'start')
      request()
    end))
  elseif t.event == 'up' or t.event == 'press' then
    if h.timer then
      h.timer:kill()
      h.timer = nil
      seek_by(5)
    elseif h.active then
      end_hold(true)
    elseif t.event == 'press' then
      -- 报不出按下 / 松开的输入方式只给一个 press：当成点一下
      seek_by(5)
    end
  end
end

-- C / A：用键盘打开字幕 / 音轨菜单（↑↓ 选、Enter 确定、Esc 关）
local function keyboard_menu(kind)
  local count = 0
  for _, t in ipairs(media.tracks) do
    if t.type == (kind == 'subs' and 'sub' or 'audio') then count = count + 1 end
  end
  -- 没有字幕也照样打开：菜单里有「加载本机字幕…」
  if kind == 'audio' and count < 2 then return toast(L('noAudio'), 1500, 'info', 'track') end
  if ui.menu and ui.menu.anchor == kind then return close_menu() end
  close_help()
  open_menu(kind)
  if ui.menu then ui.menu.kbd = true end
  check_visibility()
end

local function flash_controls()
  ui.flash_until = now() + 3
  check_visibility()
  request()
end

bind('RIGHT', 'nx-right', right_key, { complex = true })
bind('LEFT', 'nx-left', function() seek_by(-5) end, { repeatable = true })
bind('Shift+RIGHT', 'nx-right-30', function() seek_by(30) end, { repeatable = true })
bind('Shift+LEFT', 'nx-left-30', function() seek_by(-30) end, { repeatable = true })
-- ↑↓ 调音量（mpv 自带的是跳 1 分钟）
bind('UP', 'nx-volume-up', function() mp.commandv('add', 'volume', '5') end, { repeatable = true })
bind('DOWN', 'nx-volume-down', function() mp.commandv('add', 'volume', '-5') end, { repeatable = true })
-- Enter 全屏（mpv 自带的是播放列表下一个，NoxReel 的列表不在 mpv 里）
bind('ENTER', 'nx-fullscreen', function() mp.commandv('cycle', 'fullscreen') end)
bind('KP_ENTER', 'nx-fullscreen-kp', function() mp.commandv('cycle', 'fullscreen') end)
-- PgUp 上一章、PgDn 下一章（mpv 自带的反过来）
bind('PGUP', 'nx-chapter-prev', function() chapter_by(-1) end)
bind('PGDWN', 'nx-chapter-next', function() chapter_by(1) end)
bind('HOME', 'nx-home', function() end)
bind('b', 'nx-danmaku', function()
  if room.danmaku == nil then return end
  ACTIONS.danmaku()
  toast(room.danmaku and L('danmakuShown') or L('danmakuHidden'), 1200, 'info', 'danmaku')
end)
bind('s', 'nx-sync', function()
  if room.drift then mp.commandv('script-message', SYNC_MESSAGE) else toast(L('inSync'), 1500, 'info', 'sync') end
end)
bind('c', 'nx-subs-menu', function() keyboard_menu('subs') end)
bind('a', 'nx-audio-menu', function() keyboard_menu('audio') end)
bind('?', 'nx-help', toggle_help)
bind('F1', 'nx-help-f1', toggle_help)
bind('o', 'nx-progress', flash_controls)
bind('P', 'nx-progress-p', flash_controls)
-- O 在 mpv 里是切 OSD 级别，会把我们关掉的 OSD 文字又打开
bind('O', 'nx-progress-o', flash_controls)
-- Q 在 mpv 里是「记住位置再退出」，会往 mpv 的配置目录写续播文件
bind('Q', 'nx-quit', function() mp.commandv('quit') end)
for i, key in ipairs({ '[', ']', '{', '}' }) do
  bind(key, 'nx-speed-' .. i, function() toast(L('noSpeed'), 2500, 'info', 'speed') end)
end
bind('BS', 'nx-speed-reset', function() mp.set_property_number('speed', 1) end)
-- 1–8 发表情（mpv 自带的是调对比度、亮度这些，OSD 文字关了改了什么都看不出来）。
-- 不在房间里（没有弹幕开关）时什么都不做
for d = 1, 8 do
  bind(tostring(d), 'nx-digit-' .. d, function()
    if room.danmaku ~= nil then send_reaction(d - 1) end
  end)
end

--------------------------------------------------------------------------------
-- NoxReel 推来的状态
--------------------------------------------------------------------------------

-- 按字节截短（上限只是护栏，主进程已经按字数卡过）；截在一个字中间时把那半个字去掉
local function str(v, max)
  if type(v) ~= 'string' then return nil end
  max = (max or 400) * 3
  if #v > max then
    v = v:sub(1, max):gsub('[\192-\244][\128-\191]*$', '')
  end
  return v
end

local function num(v, lo, hi)
  if type(v) ~= 'number' or v ~= v or v == math.huge or v == -math.huge then return nil end
  if (lo and v < lo) or (hi and v > hi) then return nil end
  return v
end

local TONES = { sync = true, wait = true, paused = true, manual = true, guest = true }

local function apply_state(json)
  local raw = utils.parse_json(tostring(json or ''))
  if type(raw) ~= 'table' then return end
  local next_room = {}
  next_room.title = str(raw.title, 300)
  next_room.subtitle = str(raw.subtitle, 300)
  if type(raw.chip) == 'table' and str(raw.chip.text, 120) then
    next_room.chip = { text = str(raw.chip.text, 120), tone = TONES[raw.chip.tone] and raw.chip.tone or 'guest' }
  end
  if type(raw.ranges) == 'table' then
    local list = {}
    for _, r in ipairs(raw.ranges) do
      if type(r) == 'table' and num(r[1], 0, 1) and num(r[2], 0, 1) and r[2] > r[1] then list[#list + 1] = { r[1], r[2] } end
      if #list >= 64 then break end
    end
    next_room.ranges = list
  end
  if type(raw.danmaku) == 'boolean' then next_room.danmaku = raw.danmaku end
  if type(raw.miniBar) == 'boolean' then next_room.miniBar = raw.miniBar end
  next_room.canSeek = raw.canSeek ~= false
  if type(raw.stall) == 'table' and str(raw.stall.title, 200) then
    local s = raw.stall
    next_room.stall = {
      title = str(s.title, 200),
      sub = str(s.sub, 200),
      progress = num(s.progress, 0, 1),
      left = str(s.left, 80),
      right = str(s.right, 80),
      note = str(s.note, 160),
    }
  end
  if type(raw.drift) == 'table' and str(raw.drift.text, 120) then
    next_room.drift = { text = str(raw.drift.text, 120), button = str(raw.drift.button, 40) or '', key = str(raw.drift.key, 30) or '' }
  end
  if type(raw.host) == 'table' and num(raw.host.pos, 0) then
    next_room.host = { pos = raw.host.pos, playing = raw.host.playing == true }
  end
  -- 全房在快进（别人按着 →）：顶部那一条的字由 NoxReel 拼好、翻译好
  if type(raw.rate) == 'table' and num(raw.rate.x, 0.5, 2) and str(raw.rate.text, 120) then
    next_room.rate = { x = raw.rate.x, text = str(raw.rate.text, 120) }
  end
  if type(raw.marks) == 'table' then
    local list = {}
    for _, m in ipairs(raw.marks) do
      if type(m) == 'table' and num(m.t, 0) then list[#list + 1] = { t = m.t, n = str(m.n, 120) or '' } end
      if #list >= 40 then break end
    end
    next_room.marks = list
  end
  if type(raw.quality) == 'table' and type(raw.quality.options) == 'table' then
    local q = { current = num(raw.quality.current, 0, 10000) or 0, options = {} }
    for _, o in ipairs(raw.quality.options) do
      if type(o) == 'table' and num(o.h, 0, 10000) and str(o.label, 40) then q.options[#q.options + 1] = { h = o.h, label = o.label } end
      if #q.options >= 12 then break end
    end
    for _, o in ipairs(q.options) do if o.h == q.current then q.label = o.label end end
    q.label = str(raw.quality.label, 40) or q.label or ''
    if #q.options > 0 then next_room.quality = q end
  end
  local next_labels = {}
  if type(raw.labels) == 'table' then
    for k, v in pairs(raw.labels) do
      if type(k) == 'string' and DEFAULT_LABELS[k] ~= nil then
        local s = str(v, 80)
        if s then next_labels[k] = s end
      end
    end
  end
  room = next_room
  room_at = now()
  labels = next_labels
  -- 菜单开着的时候状态变了（清晰度换了、轨道换了）：按新的状态重开一次，免得点到过时的选项
  if ui.menu then
    local kind, keep = ui.menu.anchor, { offset = ui.menu.offset, cursor = ui.menu.cursor }
    close_menu()
    if kind ~= 'quality' or room.quality then open_menu(kind, keep) end
  end
  check_visibility()
  request()
end

--------------------------------------------------------------------------------
-- 接线
--------------------------------------------------------------------------------

local function observe(name, kind, fn)
  mp.observe_property(name, kind, guard(fn))
end

local volume_seen, mute_seen = false, false

-- 在等数据：跳转之后（在线视频跳一次要好几秒，这时 paused-for-cache 还是假的）、没暂停却 core-idle。
-- 超过 WAIT_SPINNER_S 才画转圈（见 render），本地文件跳转几毫秒就好，不闪
local function update_waiting()
  local waiting = media.loaded_at ~= nil and not media.idle and not media.pause and not media.loading
    and (media.seeking or media.core_idle)
  if waiting and not media.wait_since then
    media.wait_since = now()
    mp.add_timeout(WAIT_SPINNER_S + 0.05, function() request() end)
  elseif not waiting and media.wait_since then
    media.wait_since = nil
    request()
  end
end

observe('pause', 'bool', function(_, v)
  media.pause = v ~= false
  update_waiting()
  check_visibility()
  request()
end)
local last_time_key = nil
observe('time-pos', 'number', function(_, v)
  media.time = v
  -- 时间只显示到秒；细线和进度条按半秒重画就够了
  local key = v and math.floor(v * 2) or -1
  if key ~= last_time_key then
    last_time_key = key
    request()
  end
end)
observe('duration', 'number', function(_, v)
  media.duration = v or 0
  request()
end)
observe('volume', 'number', function(_, v)
  media.volume = v or 100
  vol.retarget(not volume_seen)
  if volume_seen then vol.feedback() end
  volume_seen = true
  request()
end)
observe('mute', 'bool', function(_, v)
  media.mute = v == true
  vol.retarget(not mute_seen)
  if mute_seen then vol.feedback() end
  mute_seen = true
  request()
end)
observe('chapter-list', 'native', function(_, v)
  media.chapters = type(v) == 'table' and v or {}
  request()
end)
observe('track-list', 'native', function(_, v)
  media.tracks = type(v) == 'table' and v or {}
  if ui.menu and ui.menu.anchor ~= 'quality' then
    local kind, keep = ui.menu.anchor, { offset = ui.menu.offset, cursor = ui.menu.cursor }
    close_menu()
    open_menu(kind, keep)
  end
  request()
end)

-- 自带的 OSD 文字关掉了（osd-level=0）：键盘上切字幕、音轨、倍速时由这里说一声。
-- 刚载入那一下（自动选轨）不算
local function settled()
  return media.loaded_at and now() - media.loaded_at > 1.5
end

local function current_track_label(kind)
  for _, t in ipairs(media.tracks) do
    if t.type == kind and t.selected then return track_label(t) end
  end
  return nil
end

observe('sid', 'native', function()
  if not settled() then return end
  local label = current_track_label('sub')
  toast(label and (L('subs') .. ' · ' .. label) or L('subsOff'), 1500, 'info', 'track')
end)
observe('aid', 'native', function()
  if not settled() then return end
  local label = current_track_label('audio')
  if label then toast(L('audio') .. ' · ' .. label, 1500, 'info', 'track') end
end)
observe('speed', 'number', function(_, v)
  -- 长按 → 的 2 倍速是我们自己改的，顶部另有一条「2 倍速快进中」。
  -- 在房间里时倍速只会跟着房间变（别人按着 → 全房快进，顶部另有一条「全房 2 倍速」），也不弹
  if ui.hold.active or now() < ui.hold.quiet_until or room.danmaku ~= nil then return end
  if not settled() or type(v) ~= 'number' then return end
  toast(string.format('%s %s×', L('speed'), (string.format('%.2f', v):gsub('0+$', ''):gsub('%.$', ''))), 1500, 'info', 'speed')
end)
observe('volume-max', 'number', function(_, v)
  media.volume_max = type(v) == 'number' and v or 130
end)
observe('seeking', 'bool', function(_, v)
  media.seeking = v == true
  update_waiting()
end)
observe('core-idle', 'bool', function(_, v)
  media.core_idle = v == true
  update_waiting()
end)
observe('demuxer-cache-state', 'native', function(_, v)
  media.cache = type(v) == 'table' and v or nil
  if media.remote then request() end
end)
observe('fullscreen', 'bool', function(_, v)
  media.fullscreen = v == true
  request()
end)
observe('window-maximized', 'bool', function(_, v)
  media.maximized = v == true
  request()
end)
observe('border', 'bool', function(_, v)
  media.border = v ~= false
  request()
end)
observe('title-bar', 'bool', function(_, v)
  media.title_bar = v ~= false
  request()
end)
observe('idle-active', 'bool', function(_, v)
  media.idle = v == true
  update_waiting()
  check_visibility()
  request()
end)
observe('paused-for-cache', 'bool', function(_, v)
  media.buffering = v == true
  request()
end)
observe('cache-buffering-state', 'number', function(_, v)
  media.buffering_pct = v
  if media.buffering then request() end
end)
observe('media-title', 'string', function(_, v)
  media.title = v or ''
  request()
end)
observe('osd-dimensions', 'native', function() request() end)
observe('display-hidpi-scale', 'number', function() request() end)

mp.register_event('start-file', guard(function()
  -- 换片时还按着 →：倍速先还原，不然下一部一开就是 2 倍速
  end_hold(false)
  media.loading = true
  media.loaded_at = nil
  update_waiting()
  close_menu()
  request()
end))
mp.register_event('file-loaded', guard(function()
  media.loading = false
  media.loaded_at = now()
  media.remote = (mp.get_property('path', '') or ''):match('^%a[%w+.-]*://') ~= nil
  update_waiting()
  request()
end))
mp.register_event('end-file', guard(function()
  media.loading = false
  media.loaded_at = nil
  update_waiting()
  request()
end))
-- 跳转之后亮一下控件，看得到跳到了哪（键盘跳转、房主跳转都算）；刚载入时那一下不算
mp.register_event('seek', guard(function()
  if media.loaded_at and now() - media.loaded_at > 1 then
    ui.flash_until = now() + 1.4
    check_visibility()
  end
  request()
end))

mp.register_script_message('noxreel-state', guard(apply_state))
mp.register_script_message('noxreel-toast', guard(function(str_text, ms, tone)
  local t = tone == 'ok' and 'ok' or tone == 'warn' and 'warn' or 'info'
  toast(str_text, ms, t)
end))
-- 有人发了个表情（自己的也从这里来）：{ e = 第几个, name = 谁 }
mp.register_script_message('noxreel-react', guard(function(json)
  local raw = utils.parse_json(tostring(json or ''))
  if type(raw) ~= 'table' or type(raw.e) ~= 'number' or raw.e < 0 or raw.e >= #REACTIONS or raw.e ~= math.floor(raw.e) then return end
  local name = str(raw.name, 40) or ''
  -- 横向错开一点，连着发的几个不叠成一个
  local jitter = ((#ui.reactions * 37) % 90) - 45
  ui.reactions[#ui.reactions + 1] = { e = raw.e, name = name, t0 = now(), x = jitter }
  while #ui.reactions > MAX_REACTIONS do table.remove(ui.reactions, 1) end
  request()
end))

mp.set_key_bindings({
  { 'mouse_move', guard(on_move) },
  { 'mouse_leave', guard(on_leave) },
}, 'nx-showhide', 'force')
mp.enable_key_bindings('nx-showhide', 'allow-vo-dragging+allow-hide-cursor')
ui.sections['nx-showhide'] = true

local mouse_bindings = {
  { 'mbtn_left', guard(on_up), guard(on_down) },
  { 'mbtn_left_dbl', 'ignore' },
  { 'mbtn_right', 'ignore' },
  { 'mbtn_right_dbl', 'ignore' },
  { 'mbtn_mid', 'ignore' },
  { 'wheel_up', guard(function() on_wheel(5) end) },
  { 'wheel_down', guard(function() on_wheel(-5) end) },
}
for _, section in ipairs({ 'nx-bottom', 'nx-wc', 'nx-pill' }) do
  mp.set_key_bindings(mouse_bindings, section, 'force')
  set_area(section, 0, 0, 0, 0)
end

overlay = mp.create_osd_overlay('ass-events')
measurer = mp.create_osd_overlay('ass-events')
measurer.compute_bounds = true
measurer.hidden = true

-- 自带的 OSD 文字（音量、跳转进度条）由这里画成提示条和控件，别再叠一份
mp.set_property_number('osd-level', 0)
mp.set_property('osd-on-seek', 'no')

timers.visibility = mp.add_periodic_timer(0.2, guard(function()
  check_visibility()
  -- 提示条到点了要擦掉
  if #ui.toasts > 0 then request() end
end))

request()
-- 主进程要在 mpv 起来约 100ms 后才连上管道，这一声它多半收不到：同时写进属性，它连上后订阅一下就看得到
mp.set_property_native(STATUS_PROP, 'ready')
mp.commandv('script-message', MESSAGE, 'ready')
