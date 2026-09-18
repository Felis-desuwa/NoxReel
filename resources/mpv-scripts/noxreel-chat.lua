-- NoxReel：在 mpv 窗口里直接发弹幕。
--
-- 按 Ctrl+Shift+D 调出输入框，回车发送。为什么不是 Ctrl+Enter：PotPlayer 和 MPC-BE
-- 都占了 Ctrl+Enter，三个播放器统一成一个键，用户不用记三套。
--
-- 发送走 script-message：主进程那个 JSON IPC 客户端本身就是 mpv 的一个 client，
-- client-message 事件照样收得到，不用再开第二条管道。
--
-- mp.input 是 mpv 0.38 才有的。用户自己装的旧版 mpv 上这个脚本静默不生效 ——
-- 房间窗口里的聊天输入框始终可用，播放器内输入只是个方便入口，
-- 不该因为版本老就在 OSD 上报一串错。

local mp = require('mp')
local msg = require('mp.msg')

-- 和 lib/chat.js 的 MAX_TEXT、主进程的 MAX_DANMAKU_TEXT 是同一个数。
-- 这里截只是少发点字节，真正把关的那一刀在主进程。
local MAX_TEXT = 200
local MESSAGE_NAME = 'noxreel-chat'
-- mpv 把脚本文件名里的非字母数字换成下划线当脚本名，script-opts 的前缀就是它。
local PROMPT_OPT = 'noxreel_chat-prompt'
local DEFAULT_PROMPT = '弹幕：'
-- 同一个物理组合键（Ctrl+Shift+D）在 mpv 里可能报成三种写法：Shift 保留而字母不变、
-- Shift 保留而字母被提成大写、Shift 被折进字母里只剩 Ctrl+D。三种都注册，
-- 一次按键只会命中其中一条，不会发三遍。Ctrl+D 在 mpv 默认键位里是空的，不抢别人的。
local BINDING_KEYS = { 'Ctrl+Shift+d', 'Ctrl+Shift+D', 'Ctrl+D' }

local ok, input = pcall(require, 'mp.input')
if not ok or type(input) ~= 'table' or type(input.get) ~= 'function' then
  msg.warn('这个 mpv 没有 mp.input（需要 0.38 以上），播放器内发弹幕已停用')
  return
end

-- Lua 的 # 数的是字节，一个汉字三字节。按 UTF-8 首字节数码点，才和聊天那边的上限对得上。
local function truncate(text, limit)
  local count = 0
  local i = 1
  local len = #text
  while i <= len do
    local byte = text:byte(i)
    local size = 1
    if byte >= 240 then
      size = 4
    elseif byte >= 224 then
      size = 3
    elseif byte >= 192 then
      size = 2
    end
    count = count + 1
    if count > limit then return text:sub(1, i - 1) end
    i = i + size
  end
  return text
end

local function submit(text)
  if type(text) ~= 'string' then return end
  text = truncate(text, MAX_TEXT)
  -- 全是空白的就别发了：清洗之后是空消息，房间那边也只会丢掉
  if text:match('^%s*$') then return end
  mp.commandv('script-message', MESSAGE_NAME, text)
end

local function promptText()
  local text = mp.get_opt(PROMPT_OPT)
  if type(text) ~= 'string' or text == '' then return DEFAULT_PROMPT end
  return text
end

local function openInput()
  input.get({
    prompt = promptText(),
    submit = function(text)
      input.terminate()
      submit(text)
    end,
  })
end

for i, key in ipairs(BINDING_KEYS) do
  mp.add_key_binding(key, MESSAGE_NAME .. '-' .. i, openInput)
end
