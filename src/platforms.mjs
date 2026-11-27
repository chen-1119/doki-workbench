export const platforms = {
  xhs: {
    label: '小红书', kinds: ['images', 'video'],
    editors: {
      images: 'https://creator.xiaohongshu.com/publish/publish?source=official&target=image',
      video: 'https://creator.xiaohongshu.com/publish/publish?source=official&target=video',
    },
    publicHosts: ['xiaohongshu.com', 'xhslink.com'],
  },
  douyin: {
    label: '抖音', kinds: ['images', 'video'], editors: { any: 'https://creator.douyin.com/' },
    publicHosts: ['douyin.com'],
  },
  bilibili: {
    label: 'B 站', kinds: ['video'], editors: { any: 'https://member.bilibili.com/platform/upload/video/frame' },
    publicHosts: ['bilibili.com', 'b23.tv'],
  },
  channels: {
    label: '视频号', kinds: ['video'], editors: { any: 'https://channels.weixin.qq.com/' },
    publicHosts: ['weixin.qq.com', 'weixin110.qq.com'],
    allowManualConfirmation: true,
  },
  youtube: {
    label: 'YouTube', kinds: ['video'], editors: { any: 'https://studio.youtube.com/' },
    publicHosts: ['youtube.com', 'youtu.be'],
  },
};

export const assetTypes = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
};

export const uploadLimits = { image: 25 * 1024 ** 2, video: 2 * 1024 ** 3, count: 18 };

export function publicLink(platform, input) {
  const info = platforms[platform];
  if (!input && info.allowManualConfirmation) return null;
  if (typeof input !== 'string' || input.length > 2048) throw new Error('请输入平台的作品 HTTPS 链接');
  const url = URL.parse(input.trim());
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname === '/') {
    throw new Error('请输入平台的作品 HTTPS 链接');
  }
  if (!info.publicHosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host)) ||
      Object.values(info.editors).some(editor => new URL(editor).hostname === url.hostname && platform !== 'channels')) {
    throw new Error('链接与任务的平台不符，请从已发布作品复制分享链接');
  }
  return url.href;
}

export function checkMedia(bytes, mime) {
  if (mime === 'image/jpeg') return bytes.subarray(0, 3).toString('hex') === 'ffd8ff';
  if (mime === 'image/png') return bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  if (mime === 'image/webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (mime === 'video/webm') return bytes.subarray(0, 4).toString('hex') === '1a45dfa3';
  return ['ftyp', 'moov', 'wide', 'free', 'mdat'].includes(bytes.toString('ascii', 4, 8));
}
