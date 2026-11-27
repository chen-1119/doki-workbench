export async function fillEditor(job) {
  const entries = {
    xhs: {
      host: 'creator.xiaohongshu.com', prefix: '/publish',
      title: ['input[placeholder*="填写标题"]', 'input[placeholder*="标题"]'],
      body: ['.tiptap.ProseMirror[contenteditable="true"]', '[contenteditable="true"][data-placeholder*="正文"]', 'textarea[placeholder*="正文"]'],
    },
    douyin: {
      host: 'creator.douyin.com', prefix: '/',
      title: ['input[placeholder*="标题"]'],
      body: ['[contenteditable="true"][data-placeholder*="文案"]', '[contenteditable="true"][data-placeholder*="描述"]', '.zone-container[contenteditable="true"]', 'textarea[placeholder*="描述"]'],
    },
    bilibili: {
      host: 'member.bilibili.com', prefix: '/platform/upload',
      title: ['input[placeholder*="标题"]'],
      body: ['textarea[placeholder*="简介"]', '[contenteditable="true"][data-placeholder*="简介"]', '.ql-editor[contenteditable="true"]'],
    },
    channels: {
      host: 'channels.weixin.qq.com', prefix: '/',
      title: ['input[placeholder*="短标题"]'],
      body: ['textarea[placeholder*="描述"]', '[contenteditable="true"][data-placeholder*="描述"]', '[contenteditable="true"][data-placeholder*="动态"]'],
    },
    youtube: {
      host: 'studio.youtube.com', prefix: '/',
      title: ['ytcp-social-suggestions-textbox#title-textarea #textbox[contenteditable="true"]'],
      body: ['ytcp-social-suggestions-textbox#description-textarea #textbox[contenteditable="true"]'],
    },
  };
  const entry = entries[job.platform];
  const correctPath = entry && (entry.prefix === '/' || location.pathname === entry.prefix ||
    location.pathname.startsWith(entry.prefix + '/'));
  if (!entry || location.protocol !== 'https:' || location.hostname !== entry.host || !correctPath) {
    return { error: '当前标签页与任务平台不符。请先打开对应的创作者发布页。' };
  }
  if (job.platform === 'xhs') {
    const target = new URLSearchParams(location.search).get('target');
    if (['image', 'video'].includes(target) && target !== (job.kind === 'images' ? 'image' : 'video')) {
      return { error: '请切换到任务对应的图文或视频入口，再填写。' };
    }
  }
  function field(selectors) {
    for (const selector of selectors) {
      const matches = [...document.querySelectorAll(selector)].filter(el =>
        el.getClientRects().length && !el.disabled && !el.readOnly && !el.closest('[aria-hidden="true"]'));
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) return null;
    }
    return null;
  }
  const hasValue = el => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  const normalize = value => value.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trim();
  const read = el => normalize(hasValue(el) ? el.value : el.innerText ?? el.textContent ?? '');
  async function fill(label, selectors, text) {
    if (!text) return label + '为空';
    const el = field(selectors);
    if (!el) return label + '未识别，可手动粘贴';
    const existing = read(el);
    if (existing === normalize(text)) return label + '已一致';
    if (existing) return label + '已有内容，已保留';
    if (hasValue(el) && el.maxLength >= 0 && text.length > el.maxLength) return label + '超过页面上限';
    el.focus();
    if (hasValue(el)) {
      const key = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(key, 'value').set.call(el, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('insertText', false, text);
    }
    await new Promise(resolve => setTimeout(resolve, 120));
    if (!el.isConnected || read(el) !== normalize(text)) return label + '回读未匹配，请核对或手动粘贴';
    return label + '已填写';
  }
  const title = await fill('标题', entry.title, job.title);
  const body = await fill('正文', entry.body, job.body);
  return { title, body };
}
