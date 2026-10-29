export interface Song {
  id: string;
  title: string;
  fileName: string;
  size: number;
  duration: number;
  tags: string[];
  createdAt: number;
}

export interface Library {
  version: number;
  updatedAt: number;
  songs: Song[];
}

export interface R2Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicDomain?: string;
  rapidApiKey?: string;
  rapidApiHost?: string;
}

export interface RapidAPIConfig {
  apiKey: string;
  apiHost?: string;
}

export type TagMatchMode = 'AND' | 'OR';
export type LoopMode = 'all' | 'one' | 'none';

/**
 * Remove Vietnamese accents/diacritics and normalize Unicode.
 */
export function removeVietnameseAccents(str: string): string {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

/**
 * Standardize text into normalized search keys (accented, unaccented, and with punctuation/underscores replaced with spaces).
 */
export function buildSearchKeys(str: string): string[] {
  if (!str) return [''];
  const nfc = str.normalize('NFC').toLowerCase();
  const withSpaces = nfc.replace(/[_\-+./\\,;:!?'"()[\]{}#@%*&~`^|<>]/g, ' ').replace(/\s+/g, ' ').trim();
  const unaccentedNfc = removeVietnameseAccents(nfc);
  const unaccentedWithSpaces = removeVietnameseAccents(withSpaces);

  return [nfc, withSpaces, unaccentedNfc, unaccentedWithSpaces];
}

/**
 * Check if a text (e.g. title, fileName, or tag) matches a search query,
 * supporting Vietnamese diacritic variations ('mùa' vs 'mua') and separators ('Khi_mùa_thu_đến').
 */
export function matchesSearch(target: string, query: string): boolean {
  if (!query) return true;
  if (!target) return false;

  const q = query.normalize('NFC').toLowerCase().trim();
  if (!q) return true;

  const qUnaccented = removeVietnameseAccents(q);
  const qTokens = q
    .replace(/[_\-+./\\,;:!?'"()[\]{}#@%*&~`^|<>]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const qTokensUnaccented = qTokens.map(removeVietnameseAccents);

  const targetKeys = buildSearchKeys(target);

  // 1. Substring match against any target variation
  if (targetKeys.some((k) => k.includes(q) || k.includes(qUnaccented))) {
    return true;
  }

  // 2. Token match: every token in search query must appear in target
  if (qTokens.length > 0) {
    const allTokensMatch = qTokens.every((token, idx) => {
      const tokenUnaccented = qTokensUnaccented[idx];
      return targetKeys.some((k) => k.includes(token) || k.includes(tokenUnaccented));
    });
    if (allTokensMatch) return true;
  }

  return false;
}

/**
 * Filter songs by search term, selected tags, tag match mode, and offline filter.
 */
export function filterSongs(
  songs: Song[],
  options: {
    search?: string;
    selectedTags?: string[];
    tagMode?: TagMatchMode;
    offlineOnly?: boolean;
    cachedSongIds?: Set<string>;
  }
): Song[] {
  const {
    search = '',
    selectedTags = [],
    tagMode = 'OR',
    offlineOnly = false,
    cachedSongIds = new Set<string>(),
  } = options;

  const rawQuery = search.trim();

  return songs.filter((song) => {
    // 1. Offline filter
    if (offlineOnly && !cachedSongIds.has(song.id)) {
      return false;
    }

    // 2. Search term filter (search title, filename, and tags with Vietnamese diacritic & separator support)
    if (rawQuery) {
      const matchTitle = matchesSearch(song.title, rawQuery);
      const matchFile = matchesSearch(song.fileName, rawQuery);
      const matchTag = song.tags && song.tags.some((t) => matchesSearch(t, rawQuery));
      if (!matchTitle && !matchFile && !matchTag) {
        return false;
      }
    }

    // 3. Tags filter
    if (selectedTags.length > 0) {
      const songTagsLower = song.tags.map((t) => t.toLowerCase());
      if (tagMode === 'AND') {
        const matchesAll = selectedTags.every((st) => songTagsLower.includes(st.toLowerCase()));
        if (!matchesAll) return false;
      } else {
        const matchesAny = selectedTags.some((st) => songTagsLower.includes(st.toLowerCase()));
        if (!matchesAny) return false;
      }
    }

    return true;
  });
}

/**
 * Extract unique tags with counts sorted alphabetically or by frequency.
 */
export function extractAllTags(songs: Song[]): { tag: string; count: number }[] {
  const countMap = new Map<string, number>();

  for (const song of songs) {
    for (const rawTag of song.tags) {
      const trimmed = rawTag.trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      countMap.set(lower, (countMap.get(lower) || 0) + 1);
    }
  }

  const result = Array.from(countMap.entries()).map(([tag, count]) => ({
    tag,
    count,
  }));

  // Sort descending by count, then alphabetically
  return result.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * Extract 11-character YouTube video ID from various YouTube URL formats or direct video ID
 */
export function extractYouTubeVideoId(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // 1. Direct 11-char ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  // 2. Parse via URL
  try {
    const urlStr = trimmed.startsWith('http://') || trimmed.startsWith('https://') 
      ? trimmed 
      : `https://${trimmed}`;
    const url = new URL(urlStr);

    if (url.hostname.includes('youtube.com')) {
      if (url.searchParams.has('v')) {
        const v = url.searchParams.get('v');
        if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
      }
      const pathParts = url.pathname.split('/').filter(Boolean);
      if (pathParts.length >= 2 && (pathParts[0] === 'embed' || pathParts[0] === 'shorts' || pathParts[0] === 'v')) {
        const candidate = pathParts[1];
        if (/^[a-zA-Z0-9_-]{11}$/.test(candidate)) return candidate;
      }
    } else if (url.hostname === 'youtu.be' || url.hostname.endsWith('.youtu.be')) {
      const candidate = url.pathname.slice(1).split(/[?#&]/)[0];
      if (/^[a-zA-Z0-9_-]{11}$/.test(candidate)) return candidate;
    }
  } catch {
    // Fallback regex match below
  }

  // 3. Fallback regex match
  const match = trimmed.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

/**
 * Encode R2 and RapidAPI configuration into a safe Base64 string for easy 1-click sync
 */
export function exportConfigToBase64(config: R2Config): string {
  const payload = {
    app: 'symphony-r2',
    v: 1,
    ts: Date.now(),
    config: {
      endpoint: config.endpoint.trim(),
      bucket: config.bucket.trim(),
      accessKeyId: config.accessKeyId.trim(),
      secretAccessKey: config.secretAccessKey.trim(),
      publicDomain: config.publicDomain?.trim() || '',
      rapidApiKey: config.rapidApiKey ? config.rapidApiKey.trim() : undefined,
      rapidApiHost: config.rapidApiHost ? config.rapidApiHost.trim() : undefined,
    },
  };
  const jsonStr = JSON.stringify(payload);
  if (typeof btoa === 'function') {
    return btoa(unescape(encodeURIComponent(jsonStr)));
  }
  return Buffer.from(jsonStr, 'utf-8').toString('base64');
}

/**
 * Decode R2 and RapidAPI configuration from Base64 or raw JSON string
 */
export function importConfigFromBase64(inputStr: string): R2Config {
  const trimmed = inputStr.trim();
  if (!trimmed) {
    throw new Error('Chuỗi cấu hình không được để trống.');
  }

  let jsonStr = trimmed;
  if (!trimmed.startsWith('{')) {
    try {
      if (typeof atob === 'function') {
        jsonStr = decodeURIComponent(escape(atob(trimmed)));
      } else {
        jsonStr = Buffer.from(trimmed, 'base64').toString('utf-8');
      }
    } catch {
      throw new Error('Mã Base64 không hợp lệ.');
    }
  }

  let data: any;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    throw new Error('Dữ liệu JSON không hợp lệ.');
  }

  const cfg = data.config || data;

  if (!cfg.endpoint || !cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) {
    throw new Error('Thiếu các trường bắt buộc: endpoint, bucket, accessKeyId, secretAccessKey.');
  }

  return {
    endpoint: String(cfg.endpoint).trim(),
    bucket: String(cfg.bucket).trim(),
    accessKeyId: String(cfg.accessKeyId).trim(),
    secretAccessKey: String(cfg.secretAccessKey).trim(),
    publicDomain: cfg.publicDomain ? String(cfg.publicDomain).trim() : undefined,
    rapidApiKey: cfg.rapidApiKey ? String(cfg.rapidApiKey).trim() : undefined,
    rapidApiHost: cfg.rapidApiHost ? String(cfg.rapidApiHost).trim() : undefined,
  };
}

/**
 * Format duration in seconds to mm:ss
 */
export function formatDuration(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Format file size in bytes to human-readable string
 */
export function formatFileSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Resolve next song for playback considering loop mode and offline availability.
 */
export function resolveNextPlaybackTrack(
  currentId: string | null,
  songList: Song[],
  options: {
    direction?: 'next' | 'prev';
    loopMode?: LoopMode;
    isShuffle?: boolean;
    isOffline?: boolean;
    cachedSongIds?: Set<string>;
    playedSongIds?: Set<string>;
  } = {}
): Song | null {
  const {
    direction = 'next',
    loopMode = 'all',
    isShuffle = false,
    isOffline = false,
    cachedSongIds = new Set(),
    playedSongIds = new Set(),
  } = options;

  // Filter available songs if offline
  const playableList = isOffline
    ? songList.filter((s) => cachedSongIds.has(s.id))
    : songList;

  if (playableList.length === 0) return null;

  // 1. Loop 1 track repeats current song
  if (loopMode === 'one' && currentId) {
    const cur = playableList.find((s) => s.id === currentId);
    if (cur) return cur;
  }

  // 2. Shuffle mode (independent from loop mode)
  if (isShuffle) {
    if (loopMode === 'none' && playedSongIds.size >= playableList.length) {
      return null;
    }

    const unplayed = playableList.filter(
      (s) => !playedSongIds.has(s.id) && s.id !== currentId
    );
    if (unplayed.length > 0) {
      const randomIndex = Math.floor(Math.random() * unplayed.length);
      return unplayed[randomIndex];
    }

    if (loopMode === 'none') {
      const remainingUnplayed = playableList.filter((s) => !playedSongIds.has(s.id));
      if (remainingUnplayed.length === 0) return null;
      return remainingUnplayed[0];
    }

    // loopMode === 'all'
    const others = playableList.filter((s) => s.id !== currentId);
    if (others.length === 0) return playableList[0];
    const randomIndex = Math.floor(Math.random() * others.length);
    return others[randomIndex];
  }

  // 3. Linear progression
  const currentIndex = playableList.findIndex((s) => s.id === currentId);
  if (currentIndex === -1) {
    return playableList[0];
  }

  if (direction === 'next') {
    if (currentIndex + 1 < playableList.length) {
      return playableList[currentIndex + 1];
    }
    // Reached end of playlist
    if (loopMode === 'all') {
      return playableList[0];
    }
    // loopMode === 'none' (stops)
    return null;
  } else {
    if (currentIndex - 1 >= 0) {
      return playableList[currentIndex - 1];
    }
    // At start of playlist going backwards
    if (loopMode === 'all') {
      return playableList[playableList.length - 1];
    }
    // loopMode === 'none'
    return playableList[0];
  }
}
