-- NoxReel 的播放器控制条，替掉 mpv 自带的 osc.lua（主进程启动时带 --osc=no 和 --script=本文件）。
--
-- 为什么自己画：自带控制条能调的只有颜色和几个尺寸，房间里的事（在等谁缓冲、和房主差多少、
-- 收到了哪几段、弹幕开没开）它画不出来；全屏看片时 NoxReel 的主窗口整个看不见，这些只能画在这里。
--
-- 怎么画：一个 osd 覆盖层（ass-events），全部用 ASS 矢量绘图 —— 圆角面板、半透明、柔和阴影都画得出来；
-- 毛玻璃（把身后的画面模糊掉）画不出来，所以面板是纯色半透明。图标也是画出来的：libass 会把画出来的
-- 路径自动闭合，线条一律画成「去程 + 原路返回」的零面积路径再描边（见 stroke_event）。
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
  panel = '0A0D13',
  menu = '0C1017',
  text = 'F2F5F9',
  body = 'E6EDF3',
  sub = 'A8B3C2',
  dim = '8E9AAB',
  faint = '7D8898',
  accent = '4C8DFF',
  manual = '8AB4FF',
  ok = '3FB950',
  warn = 'D29922',
  host = 'F2B84B',
  hostText = '1F1500',
  danger = 'C42B1C',
  white = 'FFFFFF',
  black = '000000',
}

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
  speed = '倍速',
  track = '轨道',
  host = '房主',
  -- 快捷键（见「快捷键」一节和 ? 键的一览）
  keySpace = '空格',
  keyHold = '长按 →',
  speedHold = '2 倍速快进中',
  speedHoldNote = '松开后全房跟到这里',
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
  { 'O', 'hProgress' },
  { '? / F1', 'hHelp' },
  { 'Q', 'hClose' },
}

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
local function ring_rect(x0, y0, x1, y1, r, width, color, op)
  if op <= 0 then return end
  push(
    head(string.format('\\1c&H%s&\\1a&H%s&\\p3}', bgr(color), alpha(op)))
      .. rr_path(x0, y0, x1, y1, r)
      .. ' '
      .. rr_path(x0 + width, y0 + width, x1 - width, y1 - width, math.max(0, r - width), true)
      .. '{\\p0}'
  )
end

local function circle(cx, cy, r, color, op, extra)
  fill_rect(cx - r, cy - r, cx + r, cy + r, r, color, op, extra)
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

--------------------------------------------------------------------------------
-- 提示条
--------------------------------------------------------------------------------

local request

local function toast(str, ms, tone, kind)
  str = tostring(str or '')
  if str == '' then return end
  ms = clamp(tonumber(ms) or 2000, 500, 15000)
  if kind then
    for i = #ui.toasts, 1, -1 do
      if ui.toasts[i].kind == kind then table.remove(ui.toasts, i) end
    end
  end
  ui.toasts[#ui.toasts + 1] = { text = str, tone = tone or 'info', kind = kind, until_t = now() + ms / 1000 }
  while #ui.toasts > 3 do table.remove(ui.toasts, 1) end
  request()
end

local function volume_toast()
  local muted = media.mute or media.volume <= 0
  toast(muted and L('muted') or string.format('%d%%', math.floor(media.volume + 0.5)), 1200, 'volume', 'volume')
end

--------------------------------------------------------------------------------
-- 排版
--------------------------------------------------------------------------------

local PANEL_H = 94

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
  lay.seek = { x0 = P.x0 + 18, x1 = P.x1 - 18, cy = P.y0 + 12 + 9 }
  add_hit(lay.hits, 'seek', lay.seek.x0 - 6, P.y0 + 2, lay.seek.x1 + 6, P.y0 + 12 + 18 + 3)

  -- 按钮那一行
  local cy = P.y0 + 12 + 18 + 8 + 22
  lay.cy = cy
  local bx = P.x0 + 18
  local function button(id, w, extra)
    local b = add_hit(lay.hits, id, bx, cy - 22, bx + w, cy + 22, extra)
    b.cx = bx + w / 2
    lay.buttons[#lay.buttons + 1] = b
    bx = bx + w
    return b
  end
  button('play', 44, { round = true, tip = media.pause and L('play') or L('pause'), key = L('keySpace') })
  bx = bx + 8
  if W >= 640 then
    button('back', 40, { tip = L('back'), key = '←', disabled = not can_seek() })
    bx = bx + 4
    button('fwd', 40, { tip = L('fwd'), key = '→', disabled = not can_seek() })
    bx = bx + 8
  end
  button('mute', 40, { tip = (media.mute and L('unmute') or L('mute')), key = 'M' })
  if W >= 760 then
    bx = bx + 6
    lay.vol = add_hit(lay.hits, 'vol', bx - 4, cy - 12, bx + 84 + 4, cy + 12)
    lay.vol.tx0, lay.vol.tx1 = bx, bx + 84
    bx = bx + 84
  end
  bx = bx + 16
  lay.time_x = bx

  local rx = P.x1 - 18
  local function rbutton(id, w, extra)
    local b = add_hit(lay.hits, id, rx - w, cy - 22, rx, cy + 22, extra)
    b.cx = rx - w / 2
    lay.buttons[#lay.buttons + 1] = b
    rx = rx - w
    return b
  end
  rbutton('fullscreen', 40, { tip = media.fullscreen and L('exitFullscreen') or L('fullscreen'), key = 'Enter' })
  lay.divider = rx - 7
  rx = rx - 14
  local audio_tracks, sub_tracks = 0, 0
  for _, t in ipairs(media.tracks) do
    if t.type == 'audio' then audio_tracks = audio_tracks + 1 elseif t.type == 'sub' then sub_tracks = sub_tracks + 1 end
  end
  rbutton('audio', 40, { tip = audio_tracks > 1 and L('audio') or L('noAudio'), key = 'A', disabled = audio_tracks < 2 })
  rx = rx - 4
  rbutton('subs', 40, { tip = sub_tracks > 0 and L('subs') or L('noSubs'), key = 'C', disabled = sub_tracks < 1 })
  if room.danmaku ~= nil then
    rx = rx - 4
    rbutton('danmaku', 40, { tip = room.danmaku and L('danmakuOn') or L('danmakuOff'), key = 'B' })
  end
  if room.quality then
    rx = rx - 10
    local label = room.quality.label or ''
    local w = math.floor(text_width(label, 13, true) + 11 + 4 + 14 + 8 + 0.5)
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
    local x = W - 46 * 3
    for i, id in ipairs({ 'minimize', 'maximize', 'close' }) do
      add_hit(lay.hits, id, x + (i - 1) * 46, 0, x + i * 46, 34, { win = true })
    end
    lay.wc_x0 = x
    chip_right = x - 16
  end
  if room.chip and room.chip.text then
    local tw = text_width(room.chip.text, 13, false)
    lay.chip = { x1 = chip_right, x0 = chip_right - (12 + 8 + 8 + tw + 12), y0 = 22, y1 = 52 }
  end
  if room.drift then
    local dt = room.drift.text or ''
    local bt = room.drift.button or ''
    local kt = room.drift.key or ''
    local tw = text_width(dt, 14, false)
    local bw = 12 + 15 + 8 + text_width(bt, 13, true) + (kt ~= '' and (8 + text_width(kt, 11, false) + 12) or 0) + 6
    local w = 14 + 8 + 10 + tw + 10 + bw + 5
    local x0 = math.floor(W / 2 - w / 2)
    lay.drift = { x0 = x0, x1 = x0 + w, y0 = 22, y1 = 60, tw = tw, bw = bw }
    lay.drift_btn = add_hit(lay.hits, 'sync', x0 + w - 5 - bw, 27, x0 + w - 5, 55)
  end
  -- 窗口窄时居中的差开提示会压到右上角的房间状态上：差开提示本身就说了同步状态，房间状态让路
  if lay.drift and lay.chip and lay.drift.x1 + 12 > lay.chip.x0 then lay.chip = nil end
  local title_max = (lay.chip and lay.chip.x0 or chip_right) - 28 - 24
  if lay.drift then title_max = math.min(title_max, lay.drift.x0 - 28 - 24) end
  lay.title_max = title_max

  -- 菜单（在按钮上方、右边对齐）。放不下的项目滚着看（滚轮），不截掉：YouTube 的字幕常有几十种语言
  if ui.menu then
    local m = ui.menu
    local anchor = nil
    for _, b in ipairs(lay.buttons) do if b.id == m.anchor then anchor = b end end
    if anchor then
      local header = m.title and 30 or 0
      local n = #m.items
      -- 上面留出窗口按钮那一行
      local top = lay.wc and 44 or 12
      local fit_n = math.max(1, math.floor((P.y0 - 8 - top - 10 - header - 8) / 38))
      local visible = math.min(n, fit_n)
      if m.want then
        -- 刚打开：让选中的那一项落在可见范围中间
        m.offset = m.want - math.ceil(visible / 2)
        m.want = nil
      end
      m.offset = clamp(m.offset or 0, 0, math.max(0, n - visible))
      m.visible = visible
      local scroll = n > visible
      local w = 200
      for _, it in ipairs(m.items) do w = math.max(w, text_width(it.label, 14, true) + 20 + 26 + (scroll and 10 or 0)) end
      if m.title then w = math.max(w, text_width(m.title, 13, true) + (m.note and text_width(m.note, 12, false) + 40 or 0) + 16) end
      w = math.min(w, W - 24)
      local hh = 10 + header + visible * 38 + 8
      local x1 = math.min(anchor.x1 + 8, W - 12)
      local x0 = math.max(12, x1 - w)
      local y1 = P.y0 - 8
      local y0 = y1 - hh
      lay.menu = { x0 = x0, x1 = x0 + w, y0 = y0, y1 = y1, scroll = scroll, list_y0 = y0 + 10 + header }
      add_hit(lay.hits, 'menu', x0, y0, x0 + w, y1, { menu = true })
      local iy = y0 + 10 + header
      for i = m.offset + 1, m.offset + visible do
        add_hit(lay.hits, 'item', x0 + 8, iy, x0 + w - 8 - (scroll and 10 or 0), iy + 36, { menu = true, item = m.items[i], index = i })
        iy = iy + 38
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

local function draw_seek_bar(lay, f)
  local S = lay.seek
  local hover = ui.hover and ui.hover.id == 'seek' and can_seek()
  local dragging = ui.drag and ui.drag.kind == 'seek'
  local thick = (hover or dragging) and 6 or 4
  local y0, y1 = S.cy - thick / 2, S.cy + thick / 2
  local gaps = chapter_gaps(S.x1 - S.x0)
  bar_piece(S.x0, S.x1, y0, y1, 0, 1, C.white, 0.14 * f, gaps)
  local ranges = ranges_now()
  if ranges then
    for _, r in ipairs(ranges) do bar_piece(S.x0, S.x1, y0, y1, r[1], r[2], C.white, 0.34 * f, gaps) end
  end
  local frac = media.duration > 0 and clamp(position() / media.duration, 0, 1) or 0
  bar_piece(S.x0, S.x1, y0, y1, 0, frac, C.accent, f, gaps)

  local hp = host_position()
  if hp and media.duration > 0 then
    local hx = S.x0 + clamp(hp / media.duration, 0, 1) * (S.x1 - S.x0)
    fill_rect(hx - 1, S.cy - 6, hx + 1, S.cy + 6, 1, C.host, f)
    local lw = text_width(L('host'), 11, true) + 14
    fill_rect(hx - lw / 2, S.cy - 30, hx + lw / 2, S.cy - 12, 9, C.host, f)
    text(hx, S.cy - 21, 5, 11, C.hostText, f, L('host'), true)
  end

  local px = S.x0 + frac * (S.x1 - S.x0)
  if hover or dragging then
    circle(px, S.cy, 12, C.accent, 0.35 * f)
    circle(px, S.cy, 8, C.white, f)
    local mx = dragging and px or clamp(ui.mx, S.x0, S.x1)
    local t = (mx - S.x0) / (S.x1 - S.x0) * media.duration
    if not dragging then fill_rect(mx - 1, S.cy - 6, mx + 1, S.cy + 6, 1, C.white, f) end
    local label = fmt_time(t, false)
    local chap = chapter_at(t)
    local bw = math.max(text_width(label, 15, true), chap and text_width(chap, 12, false) or 0) + 24
    bw = math.min(math.max(bw, 76), 240)
    local bh = chap and 52 or 34
    local bx0 = clamp(mx - bw / 2, lay.panel.x0, lay.panel.x1 - bw)
    local by1 = lay.panel.y0 - 8
    fill_rect(bx0, by1 - bh + 8, bx0 + bw, by1 + 8, 10, C.black, 0.4 * f, '\\blur8')
    fill_rect(bx0, by1 - bh, bx0 + bw, by1, 10, C.panel, 0.96 * f)
    ring_rect(bx0, by1 - bh, bx0 + bw, by1, 10, 1, C.white, 0.1 * f)
    text(bx0 + bw / 2, by1 - bh + 8, 8, 15, C.text, f, label, true)
    if chap then text(bx0 + bw / 2, by1 - bh + 29, 8, 12, C.sub, f, fit(chap, 12, false, bw - 16)) end
  end
end

-- 按钮那一行的中线，draw_panel 画按钮前设好
local lay_cy = 0

local function draw_button(b, f)
  local hovered = ui.hover and ui.hover.id == b.id
  local col = b.disabled and C.faint or C.body
  local op = b.disabled and 0.7 or 1
  if b.id == 'play' then
    circle(b.cx, lay_cy, 22, C.accent, f * (hovered and 0.88 or 1))
    icon(media.pause and 'play' or 'pause', b.cx + (media.pause and 1 or 0), lay_cy, 22, C.white, f)
    return
  end
  if hovered and not b.disabled then fill_rect(b.x0, lay_cy - 20, b.x1, lay_cy + 20, 10, C.white, 0.1 * f) end
  if b.id == 'back' or b.id == 'fwd' then
    icon(b.id, b.cx, lay_cy, 24, col, op * f, 1.7)
    text(b.cx + (b.id == 'back' and 0.4 or -0.4), lay_cy + 0.6, 5, 7.5, col, op * f, '10', true)
  elseif b.id == 'mute' then
    icon('speaker', b.cx, lay_cy, 22, col, op * f)
    if media.mute or media.volume <= 0 then
      icon('muteX', b.cx, lay_cy, 22, col, op * f)
    else
      icon('wave1', b.cx, lay_cy, 22, col, op * f)
      if media.volume >= 40 then icon('wave2', b.cx, lay_cy, 22, col, op * f) end
    end
  elseif b.id == 'danmaku' then
    local on = room.danmaku == true
    local x0, x1, y0, y1 = b.cx - 12, b.cx + 12, lay_cy - 10.5, lay_cy + 10.5
    if on then
      fill_rect(x0, y0, x1, y1, 6, C.accent, f)
      text(b.cx, lay_cy, 5, 12.5, C.white, f, '弹', true)
    else
      ring_rect(x0, y0, x1, y1, 6, 1.7, C.sub, f)
      text(b.cx, lay_cy, 5, 12.5, C.sub, f, '弹', true)
    end
  elseif b.id == 'subs' then
    icon('captions', b.cx, lay_cy, 23, col, op * f)
  elseif b.id == 'audio' then
    icon('audio', b.cx, lay_cy, 22, col, op * f)
  elseif b.id == 'fullscreen' then
    icon(media.fullscreen and 'unfullscreen' or 'fullscreen', b.cx, lay_cy, 22, col, op * f)
  elseif b.id == 'quality' then
    local open = ui.menu and ui.menu.anchor == 'quality'
    if hovered then fill_rect(b.x0, b.y0, b.x1, b.y1, 8, C.white, 0.08 * f) end
    ring_rect(b.x0, b.y0, b.x1, b.y1, 8, 1, open and C.accent or C.white, (open and 1 or 0.18) * f)
    text(b.x0 + 11, lay_cy, 4, 13, C.text, f, b.label, true)
    icon('chevronUp', b.x1 - 8 - 7, lay_cy, 14, C.text, f, 2.2)
  end
end

local function draw_panel(lay, f)
  local P = lay.panel
  -- 面板后面压暗一层，面板本身再加一圈柔和的阴影
  fill_rect(-40, P.y0 - 70, ui.W + 40, ui.H + 60, 0, C.black, 0.5 * f, '\\blur45')
  fill_rect(P.x0, P.y0 + 12, P.x1, P.y1 + 12, 16, C.black, 0.45 * f, '\\blur18')
  fill_rect(P.x0, P.y0, P.x1, P.y1, 16, C.panel, 0.82 * f)
  ring_rect(P.x0, P.y0, P.x1, P.y1, 16, 1, C.white, 0.08 * f)

  draw_seek_bar(lay, f)

  lay_cy = lay.cy
  for _, b in ipairs(lay.buttons) do draw_button(b, f) end

  if lay.vol then
    local v = lay.vol
    local frac = media.mute and 0 or clamp(media.volume / 100, 0, 1)
    fill_rect(v.tx0, lay.cy - 2, v.tx1, lay.cy + 2, 2, C.white, 0.2 * f)
    fill_rect(v.tx0, lay.cy - 2, v.tx0 + frac * (v.tx1 - v.tx0), lay.cy + 2, 2, C.body, f)
    circle(v.tx0 + frac * (v.tx1 - v.tx0), lay.cy, 6, C.white, f)
  end

  -- 时间：当前位置亮一些、总时长暗一些，同一行里换颜色；放不下总时长就只写当前位置
  local cur = fmt_time(position(), false)
  local total = media.duration > 0 and (' / ' .. fmt_time(media.duration, false)) or ''
  local room_w = lay.right_x - lay.time_x
  if total ~= '' and room_w > text_width(cur .. total, 15, false) then
    text_runs(lay.time_x, lay.cy, 4, 15, f, { { C.text, cur }, { C.dim, total } })
  elseif room_w > text_width(cur, 15, false) then
    text(lay.time_x, lay.cy, 4, 15, C.text, f, cur)
  end

  if lay.divider then fill_rect(lay.divider - 0.5, lay.cy - 10, lay.divider + 0.5, lay.cy + 10, 0, C.white, 0.12 * f) end

  -- 鼠标停在按钮上：上方给一句说明。按这一次排版里的按钮取（点完按钮说明会变，比如弹幕开关）
  local h = nil
  if ui.hover then
    for _, b in ipairs(lay.buttons) do
      if b.id == ui.hover.id then h = b end
    end
  end
  if h and h.tip and not ui.menu and not ui.drag then
    -- 说明后面跟着快捷键（暗一些、加个小框）
    local kw = h.key and (text_width(h.key, 11, false) + 12) or 0
    local tw = text_width(h.tip, 13, false) + 20 + (h.key and kw + 8 or 0)
    local x0 = clamp(h.cx - tw / 2, 12, ui.W - 12 - tw)
    local y1 = P.y0 - 8
    fill_rect(x0, y1 - 28, x0 + tw, y1, 8, C.panel, 0.94 * f)
    text(x0 + 10, y1 - 14, 4, 13, C.body, f, h.tip)
    if h.key then
      local kx = x0 + tw - 10 - kw
      ring_rect(kx, y1 - 23, kx + kw, y1 - 5, 5, 1, C.white, 0.18 * f)
      text(kx + kw / 2, y1 - 14, 5, 11, C.sub, f, h.key)
    end
  end
end

local function draw_top(lay, f)
  local W = ui.W
  fill_rect(-40, -80, W + 40, 100, 0, C.black, 0.55 * f, '\\blur40')
  local title = room.title and room.title ~= '' and room.title or media.title
  text(28, 20, 7, 19, C.text, f, fit(title, 19, true, lay.title_max), true)
  if room.subtitle and room.subtitle ~= '' then
    text(28, 47, 7, 13, C.sub, f, fit(room.subtitle, 13, false, lay.title_max))
  end

  if lay.chip then
    local c = lay.chip
    local tone = room.chip.tone
    local border_col, border_op = C.white, 0.08
    if tone == 'wait' then border_col, border_op = C.warn, 0.45 end
    fill_rect(c.x0, c.y0, c.x1, c.y1, 15, C.panel, 0.74 * f)
    ring_rect(c.x0, c.y0, c.x1, c.y1, 15, 1, border_col, border_op * f)
    local dot = ({ sync = C.ok, wait = C.warn, paused = C.dim, manual = C.manual })[tone]
    local dx = c.x0 + 16
    if dot then
      circle(dx, (c.y0 + c.y1) / 2, 4, dot, f)
    else
      ring_rect(dx - 4, (c.y0 + c.y1) / 2 - 4, dx + 4, (c.y0 + c.y1) / 2 + 4, 4, 1.5, C.sub, f)
    end
    text(c.x0 + 28, (c.y0 + c.y1) / 2, 4, 13, C.body, f, room.chip.text)
  end

  if lay.wc then
    for _, h in ipairs(lay.hits) do
      if h.win then
        local hovered = ui.hover and ui.hover.id == h.id
        if hovered then fill_rect(h.x0, h.y0, h.x1, h.y1, 0, h.id == 'close' and C.danger or C.white, (h.id == 'close' and 1 or 0.12) * f) end
        local name = h.id == 'minimize' and 'winMin' or h.id == 'close' and 'winClose' or (media.maximized and 'winRestore' or 'winMax')
        icon(name, (h.x0 + h.x1) / 2, 17, 17, hovered and h.id == 'close' and C.white or 'C9D2DE', f, 1.1)
      end
    end
  end
end

-- 和房主差开了（在线视频的手动同步）：顶部正中一条，带「同步到房主」按钮。不跟着控件收起
local function draw_drift(lay)
  local d = lay.drift
  if not d then return end
  fill_rect(d.x0, d.y0 + 8, d.x1, d.y1 + 8, 19, C.black, 0.4, '\\blur12')
  fill_rect(d.x0, d.y0, d.x1, d.y1, 19, C.panel, 0.88)
  ring_rect(d.x0, d.y0, d.x1, d.y1, 19, 1, C.warn, 0.5)
  local cy = (d.y0 + d.y1) / 2
  circle(d.x0 + 18, cy, 4, C.warn, 1)
  text(d.x0 + 32, cy, 4, 14, C.text, 1, room.drift.text)
  local b = lay.drift_btn
  local hovered = ui.hover and ui.hover.id == 'sync'
  fill_rect(b.x0, b.y0, b.x1, b.y1, 14, C.accent, hovered and 0.88 or 1)
  icon('sync', b.x0 + 12 + 7.5, cy, 15, C.white, 1, 2.2)
  local tx = b.x0 + 12 + 15 + 8
  text(tx, cy, 4, 13, C.white, 1, room.drift.button, true)
  local key = room.drift.key
  if key and key ~= '' then
    local kx = tx + text_width(room.drift.button, 13, true) + 8
    local kw = text_width(key, 11, false) + 12
    fill_rect(kx, cy - 9, kx + kw, cy + 9, 5, C.black, 0.22)
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
  fill_rect(x0, y0 + 16, x0 + w, y0 + h + 16, 20, C.black, 0.55, '\\blur24')
  fill_rect(x0, y0, x0 + w, y0 + h, 20, C.panel, 0.9)
  ring_rect(x0, y0, x0 + w, y0 + h, 20, 1, C.white, 0.08)
  local cx = W / 2
  local y = y0 + 28
  draw_spinner(cx, y + 22, 18, 4, C.accent)
  y = y + 44 + 16
  text(cx, y, 8, 22, C.text, 1, title, true)
  y = y + 30
  if sub then
    text(cx, y, 8, 14, C.sub, 1, sub)
    y = y + 26
  end
  if has_bar or s.left or s.right then
    y = y + 8
    if has_bar then
      fill_rect(x0 + 32, y, x0 + w - 32, y + 6, 3, C.white, 0.12)
      fill_rect(x0 + 32, y, x0 + 32 + clamp(s.progress, 0, 1) * inner, y + 6, 3, C.accent, 1)
    end
    if s.left then text(x0 + 32, y + 14, 7, 13, C.body, 1, fit(s.left, 13, false, inner / 2)) end
    if s.right then text(x0 + w - 32, y + 14, 9, 13, C.sub, 1, fit(s.right, 13, false, inner / 2)) end
    y = y + 34
  end
  if note then
    fill_rect(x0 + 32, y + 6, x0 + w - 32, y + 7, 0, C.white, 0.08)
    text(cx, y + 18, 8, 13, C.dim, 1, note)
  end
end

-- 刚打开、在线视频在缓冲：正中一个转圈
local function draw_busy(label)
  local cx, cy = ui.W / 2, ui.H / 2
  circle(cx, cy - 8, 34, C.panel, 0.6)
  draw_spinner(cx, cy - 8, 18, 4, C.accent)
  if label and label ~= '' then
    local tw = text_width(label, 14, false) + 24
    fill_rect(cx - tw / 2, cy + 36, cx + tw / 2, cy + 64, 14, C.panel, 0.7)
    text(cx, cy + 50, 5, 14, C.body, 1, label)
  end
end

local function draw_toasts(start_y)
  local y = start_y
  local t = now()
  for _, item in ipairs(ui.toasts) do
    if item.until_t > t then
      local icon_name = item.tone == 'ok' and 'shield' or item.tone == 'warn' and 'warning' or nil
      local tw = text_width(item.text, 14, item.tone == 'volume')
      local w, x0
      if item.tone == 'volume' then
        w = 12 + 19 + 12 + 120 + 12 + tw + 16
      else
        w = (icon_name and (12 + 19 + 10) or 16) + tw + 16
      end
      w = math.min(w, ui.W - 24)
      x0 = math.floor(ui.W / 2 - w / 2)
      local cy = y + 20
      fill_rect(x0, y + 8, x0 + w, y + 48, 20, C.black, 0.4, '\\blur12')
      fill_rect(x0, y, x0 + w, y + 40, 20, C.panel, 0.86)
      ring_rect(x0, y, x0 + w, y + 40, 20, 1, item.tone == 'warn' and C.warn or C.white, item.tone == 'warn' and 0.45 or 0.1)
      if item.tone == 'volume' then
        local muted = media.mute or media.volume <= 0
        icon('speaker', x0 + 12 + 9.5, cy, 19, C.body, 1)
        if muted then icon('muteX', x0 + 12 + 9.5, cy, 19, C.body, 1) else icon('wave1', x0 + 12 + 9.5, cy, 19, C.body, 1) end
        local bx = x0 + 12 + 19 + 12
        local frac = muted and 0 or clamp(media.volume / math.max(100, media.volume_max), 0, 1)
        fill_rect(bx, cy - 2, bx + 120, cy + 2, 2, C.white, 0.16)
        fill_rect(bx, cy - 2, bx + 120 * frac, cy + 2, 2, C.body, 1)
        text(bx + 120 + 12, cy, 4, 14, C.sub, 1, item.text)
      else
        local tx = x0 + 16
        if icon_name then
          icon(icon_name, x0 + 12 + 9.5, cy, 19, item.tone == 'ok' and C.ok or C.warn, 1, 1.9)
          tx = x0 + 12 + 19 + 10
        end
        text(tx, cy, 4, 14, C.text, 1, fit(item.text, 14, false, w - (tx - x0) - 16))
      end
      y = y + 48
    end
  end
end

-- 长按 → 快进时顶部那一条：「▶▶ 2 倍速快进中 · 松开后全房跟到这里」（房里有别人时才说后半句）
local function draw_hold(y)
  local label = L('speedHold')
  local note = room.chip and L('speedHoldNote') or nil
  local tw = text_width(label, 14, true)
  local nw = note and (text_width(note, 13, false) + 20) or 0
  local w = math.min(12 + 20 + 10 + tw + nw + 18, ui.W - 24)
  local x0 = math.floor(ui.W / 2 - w / 2)
  local cy = y + 20
  fill_rect(x0, y + 8, x0 + w, y + 48, 20, C.black, 0.4, '\\blur12')
  fill_rect(x0, y, x0 + w, y + 40, 20, C.panel, 0.88)
  ring_rect(x0, y, x0 + w, y + 40, 20, 1, C.accent, 0.6)
  icon('ffwd', x0 + 12 + 10, cy, 18, C.accent, 1)
  text(x0 + 12 + 20 + 10, cy, 4, 14, C.text, 1, label, true)
  if note then text(x0 + 12 + 20 + 10 + tw + 20, cy, 4, 13, C.sub, 1, fit(note, 13, false, w - (12 + 20 + 10 + tw + 20) - 16)) end
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
  fill_rect(x0, y0 + 16, x0 + w, y0 + h + 16, 18, C.black, 0.55, '\\blur24')
  fill_rect(x0, y0, x0 + w, y0 + h, 18, C.menu, 0.97)
  ring_rect(x0, y0, x0 + w, y0 + h, 18, 1, C.white, 0.1)
  text(x0 + 32, y0 + 28, 7, 18, C.text, 1, L('helpTitle'), true)
  local ry = y0 + 28 + 22 + 20
  for i, r in ipairs(rows) do
    local col = math.floor((i - 1) / per)
    local cx = x0 + 32 + col * (colw + 40)
    local cy = ry + ((i - 1) % per) * 32 + 11
    local kwi = text_width(r[1], 12, false) + 14
    fill_rect(cx, cy - 11, cx + kwi, cy + 11, 6, C.white, 0.06)
    ring_rect(cx, cy - 11, cx + kwi, cy + 11, 6, 1, C.white, 0.2)
    text(cx + kwi / 2, cy, 5, 12, C.body, 1, r[1])
    text(cx + kw + 14, cy, 4, 14, C.sub, 1, fit(r[2], 14, false, dw + 4))
  end
  text(x0 + 32, y0 + h - 22 - 10, 4, 12, C.dim, 1, fit(note, 12, false, w - 64))
end

local function draw_menu(lay)
  local M = lay.menu
  if not M or not ui.menu then return end
  local m = ui.menu
  fill_rect(M.x0, M.y0 + 14, M.x1, M.y1 + 14, 14, C.black, 0.6, '\\blur20')
  fill_rect(M.x0, M.y0, M.x1, M.y1, 14, C.menu, 1)
  ring_rect(M.x0, M.y0, M.x1, M.y1, 14, 1, C.white, 0.1)
  if m.title then
    text(M.x0 + 18, M.y0 + 22, 4, 13, C.text, 1, m.title, true)
    if m.note then text(M.x1 - 18, M.y0 + 22, 6, 12, C.dim, 1, m.note) end
  end
  for _, h in ipairs(lay.hits) do
    if h.id == 'item' then
      local it = h.item
      -- 鼠标停着的、或者键盘移到的那一项
      local hovered = (ui.hover and ui.hover.id == 'item' and ui.hover.index == h.index) or (m.kbd and m.cursor == h.index)
      if it.selected then
        fill_rect(h.x0, h.y0, h.x1, h.y1, 8, C.accent, 0.18)
      elseif hovered then
        fill_rect(h.x0, h.y0, h.x1, h.y1, 8, C.white, 0.07)
      end
      local cy = (h.y0 + h.y1) / 2
      text(h.x0 + 10, cy, 4, 14, it.selected and C.white or 'C9D2DE', 1, fit(it.label, 14, it.selected, h.x1 - h.x0 - 44), it.selected)
      if it.selected then icon('check', h.x1 - 10 - 8, cy, 16, C.accent, 1, 2.4) end
    end
  end
  -- 放不下、要滚着看：右边一条滚动条，看得出上下还有多少
  if M.scroll then
    local n = #m.items
    local ty0, ty1 = M.list_y0, M.list_y0 + m.visible * 38 - 2
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
  local W, H = ui.W, ui.H
  fill_rect(0, H - 3, W, H, 0, C.white, 0.12 * op)
  local ranges = ranges_now()
  if ranges then
    for _, r in ipairs(ranges) do
      fill_rect(clamp(r[1], 0, 1) * W, H - 3, clamp(r[2], 0, 1) * W, H, 0, C.white, 0.3 * op)
    end
  end
  fill_rect(0, H - 3, clamp(position() / media.duration, 0, 1) * W, H, 0, C.accent, op)
  local hp = host_position()
  if hp then
    local hx = clamp(hp / media.duration, 0, 1) * W
    fill_rect(hx - 1, H - 7, hx + 1, H, 0, C.host, op)
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
    set_area('nx-wc', lay.wc_x0, 0, ui.W, 34)
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
  end
  draw_toasts(toast_y)
  if ui.help then draw_help() end

  -- 转圈要一直转：显示着的时候每秒重画 15 次（再快看不出区别，4K 下白费 CPU）
  if spinning and not timers.busy then
    timers.busy = mp.add_periodic_timer(1 / 15, function() request() end)
  elseif not spinning and timers.busy then
    timers.busy:kill()
    timers.busy = nil
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
local function open_menu(kind, keep_offset)
  local m = { anchor = kind, items = {} }
  if kind == 'subs' then
    local any = false
    for _, t in ipairs(media.tracks) do if t.type == 'sub' and t.selected then any = true end end
    m.items[#m.items + 1] = { label = L('subsOff'), selected = not any, run = function() mp.set_property('sid', 'no') end }
    for _, t in ipairs(media.tracks) do
      if t.type == 'sub' then
        local id = t.id
        m.items[#m.items + 1] = { label = track_label(t), selected = t.selected == true, run = function() mp.set_property_number('sid', id) end }
      end
    end
  elseif kind == 'audio' then
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
  if lay.wc and x >= lay.wc_x0 and y < 34 then return true end
  return false
end

local function seek_frac(x)
  local S = ui.layout.seek
  return clamp((x - S.x0) / (S.x1 - S.x0), 0, 1)
end

local function set_volume_at(x)
  local v = ui.layout.vol
  local frac = clamp((x - v.tx0) / (v.tx1 - v.tx0), 0, 1)
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
  check_visibility()
  request()
end

local function on_leave()
  ui.mouse_in = false
  ui.hover = nil
  ui.over = false
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
  elseif ui.pressed then
    local p = ui.pressed
    ui.pressed = nil
    local h = hit_at(x, y)
    if h and h.id == p.id and (h.id ~= 'item' or h.index == p.index) then
      if h.id == 'item' then
        close_menu()
        h.item.run()
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
  if kind == 'subs' and count < 1 then return toast(L('noSubs'), 1500, 'info', 'track') end
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
for d = 1, 8 do
  bind(tostring(d), 'nx-digit-' .. d, function() end)
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
  if volume_seen then volume_toast() end
  volume_seen = true
  request()
end)
observe('mute', 'bool', function(_, v)
  media.mute = v == true
  if mute_seen then volume_toast() end
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
  -- 长按 → 的 2 倍速是我们自己改的，顶部另有一条「2 倍速快进中」
  if ui.hold.active or now() < ui.hold.quiet_until then return end
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
