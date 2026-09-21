'use strict';

// NoxReel 邀请跳转页。
//
// 聊天软件（Discord 等）不会把 noxreel:// 变成能点的链接，所以应用发出去的是
// https://felis-desuwa.github.io/NoxReel/#j/<正文>/ 这种形式，这一页把它转回 noxreel://。
//
// 邀请只在 # 后面：浏览器从不把它发给服务器。页面也不把它写进 DOM，只拿来拼链接。
(function () {
  var RELEASES = 'https://github.com/Felis-desuwa/NoxReel/releases/latest';
  var ANDROID_PACKAGE = 'app.noxreel.android';
  // 与应用里的 BODY_CHARS 一致；末尾的 '/' 是结束符（防 Discord 切掉码尾的 '.'）
  var match = /^#([ja])\/([A-Za-z0-9._%-]+)\/?$/i.exec(window.location.hash || '');
  var en = !/^zh\b/i.test(navigator.language || '');

  var TEXT = {
    title: en ? 'Watch together on NoxReel' : '来 NoxReel 一起看',
    joinLead: en ? 'Someone invited you to a screening.' : '有人邀请你一起看片。',
    answerLead: en
      ? 'This is a reply link — open it on the host’s computer to finish connecting.'
      : '这是应答链接 —— 在房主的电脑上打开它，完成连接。',
    open: en ? 'Open in NoxReel' : '用 NoxReel 打开',
    hint: en ? 'If your browser asks whether to open NoxReel, allow it.' : '浏览器问「要打开 NoxReel 吗」时，选允许。',
    download: en ? 'Don’t have it? Download NoxReel' : '还没装？下载 NoxReel',
    copy: en ? 'Copy the invite link' : '复制邀请链接',
    copied: en ? 'Copied. Open NoxReel and paste it into “Join”.' : '已复制，打开 NoxReel 粘贴到「加入放映」里。',
    bad: en ? 'This link is incomplete. Ask for it again.' : '这个链接不完整，请让对方重新发一次。',
    privacy: en
      ? 'This is a static page: the invite stays in your browser and is never sent to any server.'
      : '这是一张静态页：邀请内容只在你的浏览器里，不会发给任何服务器。',
  };

  function el(id) {
    return document.getElementById(id);
  }
  function show(id) {
    el(id).classList.remove('hidden');
  }

  if (en) document.documentElement.lang = 'en';
  document.title = TEXT.title;
  el('title').textContent = TEXT.title;
  el('open').textContent = TEXT.open;
  el('hint').textContent = TEXT.hint;
  el('download').textContent = TEXT.download;
  el('copy').textContent = TEXT.copy;
  el('copied').textContent = TEXT.copied;
  el('privacy').textContent = TEXT.privacy;

  if (!match) {
    document.body.classList.add('bad');
    el('lead').textContent = TEXT.bad;
    return;
  }

  // 复制用的原链接要趁现在记下：下面的自动跳转之后，有的浏览器里 location.href 读到的已经是 noxreel://
  var pageLink = window.location.href;
  var kind = match[1].toLowerCase();
  var body = match[2];
  var deepLink = 'noxreel://' + kind + '/' + body;
  var android = /Android/i.test(navigator.userAgent || '');
  // 安卓 Chrome 对自定义协议要走 intent://，没装时直接落到下载页
  var target = android
    ? 'intent://' + kind + '/' + body + '#Intent;scheme=noxreel;package=' + ANDROID_PACKAGE +
      ';S.browser_fallback_url=' + encodeURIComponent(RELEASES) + ';end'
    : deepLink;

  el('lead').textContent = kind === 'a' ? TEXT.answerLead : TEXT.joinLead;
  el('open').href = target;
  show('open');
  show('hint');
  show('copy');

  el('copy').addEventListener('click', function () {
    // 复制的是 https 原链接：粘进 NoxReel 的「加入放映」里两种都认，发给别人也能点
    var done = function () {
      show('copied');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(pageLink).then(done, done);
  });

  // 先自动试一次；有的浏览器要求用户亲手点一下才肯打开外部程序，那时就靠上面的按钮
  window.setTimeout(function () {
    window.location.href = target;
  }, 350);
})();
