/**
 * Symphony R2 - PWA Serverless Music Player (Minimalist Edition)
 * Clean Architecture with S3/R2 Storage Adapter, IndexedDB Offline Adapter,
 * Audio Player Controller, Media Session API, and Minimalist UI.
 * Zero-build compatible (ES Modules, ESM CDN).
 */

// Import AWS S3 SDK for Cloudflare R2 (using ?bundle for browser runtime, avoiding unenv fs.readFile)
import { 
  S3Client, 
  GetObjectCommand, 
  PutObjectCommand, 
  DeleteObjectCommand 
} from 'https://esm.sh/@aws-sdk/client-s3@3.600.0?bundle';

import { 
  getSignedUrl 
} from 'https://esm.sh/@aws-sdk/s3-request-presigner@3.600.0?bundle';

/* ==========================================================================
   1. UTILITIES & HELPER FUNCTIONS
   ========================================================================== */

function generateUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function formatDuration(seconds) {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function removeVietnameseAccents(str) {
  if (!str) return '';
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function buildSearchKeys(str) {
  if (!str) return [''];
  const nfc = String(str).normalize('NFC').toLowerCase();
  const withSpaces = nfc.replace(/[_\-+./\\,;:!?'"()[\]{}#@%*&~`^|<>]/g, ' ').replace(/\s+/g, ' ').trim();
  const unaccentedNfc = removeVietnameseAccents(nfc);
  const unaccentedWithSpaces = removeVietnameseAccents(withSpaces);
  return [nfc, withSpaces, unaccentedNfc, unaccentedWithSpaces];
}

function matchesSearch(target, query) {
  if (!query) return true;
  if (!target) return false;

  const q = String(query).normalize('NFC').toLowerCase().trim();
  if (!q) return true;

  const qUnaccented = removeVietnameseAccents(q);
  const qTokens = q
    .replace(/[_\-+./\\,;:!?'"()[\]{}#@%*&~`^|<>]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const qTokensUnaccented = qTokens.map(removeVietnameseAccents);

  const targetKeys = buildSearchKeys(target);

  // Substring match against any target variation
  if (targetKeys.some(k => k.includes(q) || k.includes(qUnaccented))) {
    return true;
  }

  // Token match: every token in search query must appear in target
  if (qTokens.length > 0) {
    const allTokensMatch = qTokens.every((token, idx) => {
      const tokenUnaccented = qTokensUnaccented[idx];
      return targetKeys.some(k => k.includes(token) || k.includes(tokenUnaccented));
    });
    if (allTokensMatch) return true;
  }

  return false;
}

function extractYouTubeVideoId(input) {
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

/* ==========================================================================
   2. STORAGE ADAPTER (CLOUDFLARE R2 VIA S3-COMPATIBLE API)
   ========================================================================== */

class R2StorageAdapter {
  constructor() {
    this.client = null;
    this.config = null;
    this.loadConfig();
  }

  loadConfig() {
    try {
      const stored = localStorage.getItem('r2_storage_config');
      if (stored) {
        this.config = JSON.parse(stored);
        this.initClient();
      }
    } catch (e) {
      console.error('Failed to load R2 config from localStorage', e);
    }
  }

  saveConfig(newConfig) {
    this.config = {
      endpoint: newConfig.endpoint.trim(),
      bucket: newConfig.bucket.trim(),
      accessKeyId: newConfig.accessKeyId.trim(),
      secretAccessKey: newConfig.secretAccessKey.trim(),
      publicDomain: newConfig.publicDomain ? newConfig.publicDomain.trim() : ''
    };
    localStorage.setItem('r2_storage_config', JSON.stringify(this.config));
    this.initClient();
  }

  hasConfig() {
    return !!(
      this.config &&
      this.config.endpoint &&
      this.config.bucket &&
      this.config.accessKeyId &&
      this.config.secretAccessKey
    );
  }

  initClient() {
    if (!this.hasConfig()) {
      this.client = null;
      return;
    }

    try {
      this.client = new S3Client({
        region: 'auto',
        endpoint: this.config.endpoint,
        forcePathStyle: true,
        maxAttempts: 1,
        credentials: {
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey
        }
      });
    } catch (err) {
      console.error('Error initializing S3Client', err);
      this.client = null;
    }
  }

  async fetchLibrary() {
    if (!this.client) {
      throw new Error('Chưa cấu hình Cloudflare R2.');
    }

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 10000);

    try {
      const command = new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: 'library.json',
        ResponseCacheControl: 'no-cache, no-store, must-revalidate'
      });

      const response = await this.client.send(command, {
        abortSignal: abortController.signal
      });
      clearTimeout(timer);

      const bodyString = await response.Body.transformToString();
      const library = JSON.parse(bodyString);

      if (!library.songs || !Array.isArray(library.songs)) {
        library.songs = [];
      }
      return library;
    } catch (error) {
      clearTimeout(timer);
      if (error.name === 'AbortError' || error.name === 'TimeoutError') {
        throw new Error('Hết thời gian chờ kết nối R2 (Timeout 10s). Vui lòng kiểm tra lại Endpoint hoặc kết nối mạng.');
      }
      if (error.name === 'TypeError' && (error.message?.includes('Failed to fetch') || error.message?.includes('Load failed'))) {
        throw new Error('Lỗi CORS hoặc mạng khi tải thư viện R2 (Cần cấu hình AllowedHeaders: ["*"] trên Cloudflare R2).');
      }
      const isNotFound = 
        error.name === 'NoSuchKey' || 
        error.$metadata?.httpStatusCode === 404 || 
        (error.message && error.message.toLowerCase().includes('nosuchkey'));

      if (isNotFound) {
        console.warn('library.json not found on R2. Creating initial library...');
        const initialLibrary = {
          version: 1,
          updatedAt: Date.now(),
          songs: []
        };
        await this.saveLibrary(initialLibrary);
        return initialLibrary;
      }
      throw error;
    }
  }

  async saveLibrary(library) {
    if (!this.client) {
      throw new Error('Chưa cấu hình Cloudflare R2.');
    }

    library.updatedAt = Date.now();
    const payload = JSON.stringify(library, null, 2);
    // Convert string to Uint8Array for full WebKit/Safari WebCrypto SHA256 compatibility
    const bodyData = new TextEncoder().encode(payload);

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 15000);

    try {
      const command = new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: 'library.json',
        Body: bodyData,
        ContentType: 'application/json; charset=utf-8'
      });

      await this.client.send(command, {
        abortSignal: abortController.signal
      });
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        throw new Error('Hết thời gian chờ lưu thư viện lên R2 (Timeout 15s).');
      }
      if (err.name === 'TypeError' && (err.message?.includes('Load failed') || err.message?.includes('Failed to fetch'))) {
        throw new Error('Lỗi CORS trên Cloudflare R2 (Yêu cầu thêm AllowedHeaders: ["*"] trong cài đặt CORS của R2).');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async uploadTrack(fileData, key, contentType) {
    if (!this.client) {
      throw new Error('Chưa cấu hình Cloudflare R2.');
    }

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 120000);

    try {
      const command = new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: fileData,
        ContentType: contentType || 'audio/mpeg'
      });

      return await this.client.send(command, {
        abortSignal: abortController.signal
      });
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        throw new Error('Hết thời gian tải file âm thanh lên R2 (Timeout).');
      }
      if (err.name === 'TypeError' && (err.message?.includes('Load failed') || err.message?.includes('Failed to fetch'))) {
        throw new Error('Lỗi CORS khi tải file lên R2 (Cần AllowedOrigins: ["*"] và AllowedHeaders: ["*"]).');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async deleteTrack(key) {
    if (!this.client) {
      throw new Error('Chưa cấu hình Cloudflare R2.');
    }

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 15000);

    try {
      const command = new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: key
      });

      return await this.client.send(command, {
        abortSignal: abortController.signal
      });
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        throw new Error('Hết thời gian chờ xoá file khỏi R2 (Timeout 15s).');
      }
      if (err.name === 'TypeError' && (err.message?.includes('Load failed') || err.message?.includes('Failed to fetch'))) {
        throw new Error('Lỗi CORS khi xoá file trên R2 (Yêu cầu thêm AllowedMethods: DELETE và AllowedHeaders: ["*"] trong CORS).');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async getPresignedPlaybackUrl(key, expiresIn = 3600) {
    if (!this.client) {
      throw new Error('Chưa cấu hình Cloudflare R2.');
    }

    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: key
    });

    return await getSignedUrl(this.client, command, { expiresIn });
  }

  async downloadTrackBlob(key) {
    if (!this.client) {
      throw new Error('Chưa cấu hình Cloudflare R2.');
    }

    const presignedUrl = await this.getPresignedPlaybackUrl(key, 900);
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 60000);
    try {
      const response = await fetch(presignedUrl, { signal: abortController.signal });
      if (!response.ok) {
        throw new Error(`Tải bài hát thất bại (HTTP ${response.status})`);
      }
      return await response.blob();
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        throw new Error('Hết thời gian tải bài hát (Timeout 60s).');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async testConnection() {
    if (!this.client) {
      throw new Error('Vui lòng điền đầy đủ các thông số kết nối R2.');
    }
    try {
      await this.fetchLibrary();
      return true;
    } catch (e) {
      if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
        return true;
      }
      if (e.name === 'AbortError' || e.name === 'TimeoutError' || (e.message && e.message.includes('Timeout'))) {
        throw new Error('Hết thời gian chờ kết nối (Timeout 6s). Kiểm tra lại Endpoint hoặc kết nối mạng.');
      }
      if (e.name === 'TypeError' && (e.message?.includes('Failed to fetch') || e.message?.includes('Load failed'))) {
        throw new Error('Không thể kết nối tới R2 Endpoint (Kiểm tra lại Endpoint hoặc cấu hình CORS trên Cloudflare R2: cần AllowedHeaders: ["*"]).');
      }
      if (e.$metadata?.httpStatusCode === 403 || e.name === 'AccessDenied') {
        throw new Error('Quyền truy cập bị từ chối (403 AccessDenied). Kiểm tra Access Key ID và Secret Access Key.');
      }
      throw e;
    }
  }
}

/* ==========================================================================
   3. OFFLINE STORAGE ADAPTER (INDEXEDDB: PersonalMusicDB -> audioBlobs)
   ========================================================================== */

class OfflineStoreAdapter {
  constructor() {
    this.dbName = 'PersonalMusicDB';
    this.storeName = 'audioBlobs';
    this.dbVersion = 1;
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'songId' });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this.db);
      };

      request.onerror = (event) => {
        console.error('IndexedDB init error:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  async saveAudio(songId, blob, meta = {}) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.storeName], 'readwrite');
      const store = tx.objectStore(this.storeName);
      const record = {
        songId,
        blob,
        meta,
        size: blob.size,
        type: blob.type,
        cachedAt: Date.now()
      };
      const req = store.put(record);

      req.onsuccess = () => resolve(record);
      req.onerror = () => reject(req.error);
    });
  }

  async getAudio(songId) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.storeName], 'readonly');
      const store = tx.objectStore(this.storeName);
      const req = store.get(songId);

      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async deleteAudio(songId) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.storeName], 'readwrite');
      const store = tx.objectStore(this.storeName);
      const req = store.delete(songId);

      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async getAllCachedIds() {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.storeName], 'readonly');
      const store = tx.objectStore(this.storeName);
      const req = store.getAllKeys();

      req.onsuccess = () => {
        resolve(new Set(req.result || []));
      };
      req.onerror = () => reject(req.error);
    });
  }
}

/* ==========================================================================
   4. YOUTUBE DOWNLOADER ADAPTER (RAPIDAPI YOUTUBE-MP36)
   ========================================================================== */

class YouTubeDownloaderAdapter {
  constructor() {
    this.config = null;
    this.loadConfig();
  }

  loadConfig() {
    try {
      const stored = localStorage.getItem('rapidapi_config');
      if (stored) {
        this.config = JSON.parse(stored);
      } else {
        const r2Stored = localStorage.getItem('r2_storage_config');
        if (r2Stored) {
          const parsed = JSON.parse(r2Stored);
          if (parsed.rapidApiKey) {
            this.config = {
              apiKey: parsed.rapidApiKey,
              apiHost: parsed.rapidApiHost || 'youtube-mp36.p.rapidapi.com'
            };
          }
        }
      }
    } catch (e) {
      console.error('Failed to load RapidAPI config', e);
    }
  }

  saveConfig(newConfig) {
    this.config = {
      apiKey: (newConfig.apiKey || '').trim(),
      apiHost: (newConfig.apiHost || 'youtube-mp36.p.rapidapi.com').trim()
    };
    localStorage.setItem('rapidapi_config', JSON.stringify(this.config));
  }

  hasConfig() {
    return !!(this.config && this.config.apiKey);
  }

  async testConnection(apiKey, apiHost) {
    const key = (apiKey || this.config?.apiKey || '').trim();
    const host = (apiHost || this.config?.apiHost || 'youtube-mp36.p.rapidapi.com').trim();

    if (!key) {
      throw new Error('Vui lòng điền RapidAPI Key.');
    }

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 12000);

    try {
      const testVideoId = 'dQw4w9WgXcQ';
      const endpoint = `https://${host}/dl?id=${testVideoId}`;
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'x-rapidapi-key': key,
          'x-rapidapi-host': host
        },
        signal: abortController.signal
      });

      if (response.status === 401 || response.status === 403) {
        throw new Error('RapidAPI Key không hợp lệ hoặc đã hết hạn (HTTP 401/403).');
      }

      if (!response.ok) {
        throw new Error(`RapidAPI trả về mã lỗi HTTP ${response.status}`);
      }

      const data = await response.json();
      if (data.status === 'fail') {
        throw new Error(data.msg || 'Không thể lấy thông tin video từ RapidAPI.');
      }

      return true;
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        throw new Error('Hết thời gian chờ kết nối tới RapidAPI (Timeout 12s).');
      }
      if (err.name === 'TypeError' && err.message && err.message.includes('Failed to fetch')) {
        throw new Error('Không thể kết nối tới RapidAPI. Vui lòng kiểm tra lại mạng hoặc tiện ích chặn quảng cáo.');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchDownloadInfo(videoId) {
    if (!this.hasConfig()) {
      throw new Error('Chưa cấu hình RapidAPI Key cho youtube-mp36.');
    }

    const host = this.config.apiHost || 'youtube-mp36.p.rapidapi.com';
    const key = this.config.apiKey;
    const endpoint = `https://${host}/dl?id=${videoId}`;

    let attempts = 0;
    const maxAttempts = 4;

    while (attempts < maxAttempts) {
      attempts++;
      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), 15000);

      try {
        const response = await fetch(endpoint, {
          method: 'GET',
          headers: {
            'x-rapidapi-key': key,
            'x-rapidapi-host': host
          },
          signal: abortController.signal
        });

        clearTimeout(timer);

        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            throw new Error('RapidAPI Key không hợp lệ hoặc đã hết hạn mức (quota).');
          }
          throw new Error(`RapidAPI youtube-mp36 lỗi (HTTP ${response.status})`);
        }

        const data = await response.json();

        if (data.status === 'ok') {
          return {
            id: videoId,
            title: data.title || `YouTube Audio (${videoId})`,
            link: data.link,
            duration: Math.round(Number(data.duration) || 0),
            msg: data.msg
          };
        }

        if (data.status === 'processing') {
          if (attempts < maxAttempts) {
            await new Promise(r => setTimeout(r, 2500));
            continue;
          } else {
            throw new Error('Video đang được xử lý trên máy chủ RapidAPI. Vui lòng thử lại sau giây lát.');
          }
        }

        throw new Error(data.msg || 'Không thể trích xuất audio từ link YouTube này.');
      } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError' || err.name === 'TimeoutError') {
          throw new Error('Hết thời gian chờ phản hồi từ RapidAPI (Timeout 15s).');
        }
        throw err;
      }
    }
  }

  async downloadAudioBlob(url) {
    // 1. Direct fetch
    try {
      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), 60000);
      const res = await fetch(url, { signal: abortController.signal });
      clearTimeout(timer);
      if (res.ok) {
        return await res.blob();
      }
    } catch (directErr) {
      console.warn('Direct fetch failed, trying proxy fallback...', directErr);
    }

    // 2. Fallback via allorigins proxy
    try {
      const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
      const res = await fetch(proxyUrl);
      if (res.ok) {
        return await res.blob();
      }
    } catch (p1Err) {
      console.warn('Proxy 1 failed, trying proxy 2...', p1Err);
    }

    // 3. Fallback via corsproxy.io
    try {
      const proxy2Url = `https://corsproxy.io/?url=${encodeURIComponent(url)}`;
      const res = await fetch(proxy2Url);
      if (res.ok) {
        return await res.blob();
      }
    } catch (p2Err) {
      console.error('All download methods failed', p2Err);
    }

    throw new Error('Không thể tải file MP3 từ liên kết. Vui lòng kiểm tra lại link hoặc kết nối mạng.');
  }
}

/* ==========================================================================
   5. AUDIO PLAYER CONTROLLER & MEDIA SESSION API
   ========================================================================== */

class AudioPlayerController {
  constructor(options = {}) {
    this.audioElement = options.audioElement;
    this.storageAdapter = options.storageAdapter;
    this.offlineAdapter = options.offlineAdapter;
    this.onStateChange = options.onStateChange || (() => {});
    this.onToast = options.onToast || (() => {});

    this.currentSong = null;
    this.currentObjectURL = null;
    this.activeSource = 'none'; // 'offline' | 'r2-stream' | 'demo'
    this.queue = [];
    this.loopMode = 'all'; // 3 modes: 'all' | 'one' | 'none'
    this.isShuffle = false; // independent toggle for shuffle
    this.playedSongIds = new Set();
    this.isPlaying = false;
    this.currentTime = 0;
    this.duration = 0;

    this.setupAudioListeners();
    this.setupMediaSession();
  }

  setupAudioListeners() {
    const a = this.audioElement;

    a.addEventListener('play', () => {
      this.isPlaying = true;
      this.updateMediaSessionState();
      this.onStateChange();
    });

    a.addEventListener('pause', () => {
      this.isPlaying = false;
      this.updateMediaSessionState();
      this.onStateChange();
    });

    a.addEventListener('timeupdate', () => {
      this.currentTime = a.currentTime || 0;
      this.duration = a.duration || 0;
      this.onStateChange();
    });

    a.addEventListener('loadedmetadata', () => {
      this.duration = a.duration || 0;
      this.onStateChange();
    });

    a.addEventListener('ended', () => {
      this.handleTrackEnded();
    });

    a.addEventListener('error', (e) => {
      console.error('Audio playback error', e, a.error);
      this.isPlaying = false;
      this.onStateChange();
    });
  }

  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;

    try {
      navigator.mediaSession.setActionHandler('play', () => this.play());
      navigator.mediaSession.setActionHandler('pause', () => this.pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => this.playPrevious());
      navigator.mediaSession.setActionHandler('nexttrack', () => this.playNext());
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime && this.audioElement) {
          this.audioElement.currentTime = details.seekTime;
        }
      });
    } catch (e) {
      console.warn('MediaSession error', e);
    }
  }

  updateMediaSessionMetadata() {
    if (!('mediaSession' in navigator) || !this.currentSong) return;

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: this.currentSong.title,
        artist: 'Symphony R2',
        album: (this.currentSong.tags && this.currentSong.tags.join(', ')) || 'Kho Nhạc',
        artwork: [
          { src: './pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: './pwa-512x512.png', sizes: '512x512', type: 'image/png' }
        ]
      });
    } catch (e) {}
  }

  updateMediaSessionState() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = this.isPlaying ? 'playing' : 'paused';
    } catch {}
  }

  async playSong(song) {
    if (!song) return;

    // Revoke previous object URL to avoid memory leak
    if (this.currentObjectURL) {
      URL.revokeObjectURL(this.currentObjectURL);
      this.currentObjectURL = null;
    }

    this.currentSong = song;
    if (song && song.id) {
      this.playedSongIds.add(song.id);
    }
    let playbackUrl = null;

    // 1. Check IndexedDB
    try {
      const offlineRecord = await this.offlineAdapter.getAudio(song.id);
      if (offlineRecord && offlineRecord.blob) {
        playbackUrl = URL.createObjectURL(offlineRecord.blob);
        this.currentObjectURL = playbackUrl;
        this.activeSource = 'offline';
      }
    } catch (err) {
      console.warn('Error reading from IndexedDB', err);
    }

    // 2. Stream online via Cloudflare R2
    if (!playbackUrl) {
      if (!navigator.onLine) {
        this.onToast(
          `Bài "${song.title}" chưa tải offline. Đang chuyển sang bài offline kế tiếp...`,
          'warning'
        );
        this.playNextOfflineTrack();
        return;
      }

      if (song.demoBlob) {
        playbackUrl = URL.createObjectURL(song.demoBlob);
        this.currentObjectURL = playbackUrl;
        this.activeSource = 'demo';
      } else {
        try {
          playbackUrl = await this.storageAdapter.getPresignedPlaybackUrl(song.fileName, 3600);
          this.activeSource = 'r2-stream';
        } catch (err) {
          console.error('Failed to get Presigned URL from R2', err);
          this.onToast(`Không thể stream nhạc từ R2: ${err.message}`, 'error');
          return;
        }
      }
    }

    this.audioElement.src = playbackUrl;
    try {
      await this.audioElement.play();
      this.isPlaying = true;
      this.updateMediaSessionMetadata();
      this.updateMediaSessionState();
      this.onStateChange();
    } catch (err) {
      console.warn('Playback start error (user gesture required):', err);
      this.isPlaying = false;
      this.onStateChange();
    }
  }

  async play() {
    if (!this.audioElement.src && this.currentSong) {
      await this.playSong(this.currentSong);
      return;
    }
    if (!this.audioElement.src && this.queue.length > 0) {
      await this.playSong(this.queue[0]);
      return;
    }
    try {
      await this.audioElement.play();
      this.isPlaying = true;
      this.updateMediaSessionState();
      this.onStateChange();
    } catch (err) {
      console.warn('Playback resume error:', err);
      this.isPlaying = false;
      this.onStateChange();
    }
  }

  pause() {
    try {
      this.audioElement.pause();
    } catch (err) {
      console.warn('Playback pause error:', err);
    }
    this.isPlaying = false;
    this.updateMediaSessionState();
    this.onStateChange();
  }

  togglePlayPause() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  seek(seconds) {
    if (this.audioElement) {
      this.audioElement.currentTime = seconds;
    }
  }

  setVolume(val) {
    if (this.audioElement) {
      this.audioElement.volume = Math.max(0, Math.min(1, val));
      this.onStateChange();
    }
  }

  toggleMute() {
    if (this.audioElement) {
      this.audioElement.muted = !this.audioElement.muted;
      this.onStateChange();
    }
  }

  setLoopMode(mode) {
    this.loopMode = mode;
    this.onStateChange();
  }

  cycleLoopMode() {
    // 3 distinct modes: 'all' -> 'one' -> 'none' -> 'all' (Loop only, never switches to shuffle)
    if (this.loopMode === 'all') {
      this.loopMode = 'one';
      this.onToast('Chế độ lặp: Lặp 1 bài', 'info');
    } else if (this.loopMode === 'one') {
      this.loopMode = 'none';
      this.onToast('Chế độ lặp: Không lặp lại (phát xong là dừng)', 'info');
    } else {
      this.loopMode = 'all';
      this.onToast('Chế độ lặp: Lặp lại toàn bộ danh sách', 'info');
    }
    this.onStateChange();
  }

  toggleShuffle() {
    this.isShuffle = !this.isShuffle;
    this.playedSongIds.clear();
    if (this.currentSong) {
      this.playedSongIds.add(this.currentSong.id);
    }
    this.onToast(
      this.isShuffle ? 'Đã bật phát ngẫu nhiên (Shuffle ON)' : 'Đã tắt phát ngẫu nhiên (Shuffle OFF)',
      'info'
    );
    this.onStateChange();
  }

  setQueue(songs) {
    this.queue = Array.isArray(songs) ? songs : [];
  }

  handleTrackEnded() {
    if (this.loopMode === 'one' && this.currentSong) {
      this.audioElement.currentTime = 0;
      this.audioElement.play().catch(console.warn);
      return;
    }
    this.playNext(false);
  }

  playNext(isManual = false) {
    if (this.queue.length === 0) return;

    // 1. Shuffle mode active (independent from loop)
    if (this.isShuffle) {
      const unplayed = this.queue.filter((s) => !this.playedSongIds.has(s.id) && s.id !== this.currentSong?.id);
      if (unplayed.length > 0) {
        const nextSong = unplayed[Math.floor(Math.random() * unplayed.length)];
        this.playSong(nextSong);
        return;
      }

      // All songs have been played
      if (this.loopMode === 'none' && !isManual) {
        // Stop playback after playlist completes
        this.pause();
        this.audioElement.currentTime = 0;
        return;
      }

      // loopMode === 'all' or manual Next: reset session and pick any other song
      this.playedSongIds.clear();
      if (this.currentSong) this.playedSongIds.add(this.currentSong.id);
      const others = this.queue.filter((s) => s.id !== this.currentSong?.id);
      const target = others.length > 0 
        ? others[Math.floor(Math.random() * others.length)] 
        : this.queue[0];
      this.playSong(target);
      return;
    }

    // 2. Sequential progression
    const currentIndex = this.queue.findIndex((s) => s.id === this.currentSong?.id);
    if (currentIndex === -1) {
      this.playSong(this.queue[0]);
      return;
    }

    const nextIndex = currentIndex + 1;
    if (nextIndex < this.queue.length) {
      this.playSong(this.queue[nextIndex]);
      return;
    }

    // At the end of playlist
    if (this.loopMode === 'all') {
      this.playSong(this.queue[0]);
    } else if (this.loopMode === 'none') {
      if (isManual) {
        this.playSong(this.queue[0]);
      } else {
        // Natural end in non-loop mode: stop playback
        this.pause();
        this.audioElement.currentTime = 0;
      }
    } else {
      this.playSong(this.queue[0]);
    }
  }

  playPrevious() {
    if (this.queue.length === 0) return;

    if (this.audioElement.currentTime > 3) {
      this.audioElement.currentTime = 0;
      return;
    }

    const currentIndex = this.queue.findIndex((s) => s.id === this.currentSong?.id);
    const prevIndex = (currentIndex - 1 + this.queue.length) % this.queue.length;
    this.playSong(this.queue[prevIndex]);
  }

  async playNextOfflineTrack() {
    const cachedIds = await this.offlineAdapter.getAllCachedIds();
    const offlineAvailable = this.queue.filter((s) => cachedIds.has(s.id));

    if (offlineAvailable.length === 0) {
      this.onToast('Không có bài hát nào trong danh sách đã được lưu offline.', 'error');
      this.pause();
      return;
    }

    const currentIndex = offlineAvailable.findIndex((s) => s.id === this.currentSong?.id);
    const nextIndex = (currentIndex + 1) % offlineAvailable.length;
    this.playSong(offlineAvailable[nextIndex]);
  }
}

/* ==========================================================================
   5. DEMO AUDIO SYNTHESIZER
   ========================================================================== */

async function generateDemoAudioBlob(frequency, durationSec = 30) {
  const sampleRate = 44100;
  const numFrames = sampleRate * durationSec;
  const offlineCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, numFrames, sampleRate);

  const osc1 = offlineCtx.createOscillator();
  const osc2 = offlineCtx.createOscillator();
  const gain = offlineCtx.createGain();

  osc1.type = 'sine';
  osc1.frequency.setValueAtTime(frequency, 0);

  osc2.type = 'triangle';
  osc2.frequency.setValueAtTime(frequency * 1.5, 0);

  gain.gain.setValueAtTime(0.01, 0);
  gain.gain.exponentialRampToValueAtTime(0.18, 1);
  gain.gain.setValueAtTime(0.18, durationSec - 2);
  gain.gain.exponentialRampToValueAtTime(0.001, durationSec);

  osc1.connect(gain);
  osc2.connect(gain);
  gain.connect(offlineCtx.destination);

  osc1.start(0);
  osc2.start(0);
  osc1.stop(durationSec);
  osc2.stop(durationSec);

  const renderedBuffer = await offlineCtx.startRendering();
  return audioBufferToWavBlob(renderedBuffer);
}

function audioBufferToWavBlob(buffer) {
  const numOfChan = buffer.numberOfChannels;
  const length = buffer.length * numOfChan * 2 + 44;
  const out = new DataView(new ArrayBuffer(length));
  const channels = [];
  let sample = 0;
  let offset = 0;
  let pos = 0;

  function setUint16(data) {
    out.setUint16(pos, data, true);
    pos += 2;
  }
  function setUint32(data) {
    out.setUint32(pos, data, true);
    pos += 4;
  }

  setUint32(0x46464952); // "RIFF"
  setUint32(length - 8);
  setUint32(0x45564157); // "WAVE"
  setUint32(0x20746d66); // "fmt "
  setUint32(16);
  setUint16(1);
  setUint16(numOfChan);
  setUint32(buffer.sampleRate);
  setUint32(buffer.sampleRate * 2 * numOfChan);
  setUint16(numOfChan * 2);
  setUint16(16);
  setUint32(0x61746164); // "data"
  setUint32(length - pos - 4);

  for (let i = 0; i < buffer.numberOfChannels; i++) {
    channels.push(buffer.getChannelData(i));
  }

  while (offset < buffer.length) {
    for (let i = 0; i < numOfChan; i++) {
      sample = Math.max(-1, Math.min(1, channels[i][offset]));
      sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0;
      out.setInt16(pos, sample, true);
      pos += 2;
    }
    offset++;
  }

  return new Blob([out], { type: 'audio/wav' });
}

/* ==========================================================================
   6. MAIN APPLICATION COORDINATOR (SymphonyApp)
   ========================================================================== */

class SymphonyApp {
  constructor() {
    this.storageAdapter = new R2StorageAdapter();
    this.offlineAdapter = new OfflineStoreAdapter();
    this.youtubeAdapter = new YouTubeDownloaderAdapter();

    this.uploadSourceMode = 'local';
    this.currentYouTubeInfo = null;

    this.library = { version: 1, updatedAt: Date.now(), songs: [] };
    this.cachedSongIds = new Set();
    this.selectedTags = new Set();
    this.tagMode = 'OR';
    this.offlineOnly = false;
    this.searchQuery = '';

    this.deferredInstallPrompt = null;
    this.stagedUploadFiles = [];
    this.downloadingSongIds = new Set();
    this.songToDelete = null;
    this.songToRemoveOffline = null;

    this.player = new AudioPlayerController({
      audioElement: document.getElementById('native-audio'),
      storageAdapter: this.storageAdapter,
      offlineAdapter: this.offlineAdapter,
      onStateChange: () => {
        this.updatePlayerUI();
        this.updateSongListPlayStates();
      },
      onToast: (msg, type) => this.showToast(msg, type)
    });
  }

  async init() {
    try {
      await this.offlineAdapter.init();
      this.cachedSongIds = await this.offlineAdapter.getAllCachedIds();
    } catch (err) {
      console.error('IndexedDB init failed', err);
    }

    this.loadCachedLibrary();
    this.registerServiceWorker();
    this.bindDOMEvents();
    this.updateOnlineStatusDisplay();

    if (this.storageAdapter.hasConfig() && navigator.onLine) {
      this.syncLibrary(false);
    } else {
      this.render();
    }
  }

  loadCachedLibrary() {
    try {
      const cached = localStorage.getItem('cached_library');
      if (cached) {
        this.library = JSON.parse(cached);
        if (!this.library.songs) this.library.songs = [];
      }
    } catch (e) {}
  }

  saveCachedLibrary() {
    try {
      localStorage.setItem('cached_library', JSON.stringify(this.library));
    } catch (e) {}
  }

  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(console.warn);
      });
    }

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredInstallPrompt = e;
      const installBtn = document.getElementById('btn-install-pwa');
      if (installBtn) {
        installBtn.classList.remove('hidden');
        installBtn.classList.add('flex');
      }
    });

    window.addEventListener('appinstalled', () => {
      this.deferredInstallPrompt = null;
      const installBtn = document.getElementById('btn-install-pwa');
      if (installBtn) installBtn.classList.add('hidden');
      this.showToast('Đã cài đặt ứng dụng thành công!', 'success');
    });

    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;

    if (isIOS && !isStandalone) {
      const installBtn = document.getElementById('btn-install-pwa');
      if (installBtn) {
        installBtn.classList.remove('hidden');
        installBtn.classList.add('flex');
      }
    }
  }

  updateOnlineStatusDisplay() {
    const isOnline = navigator.onLine;
    const powerLed = document.getElementById('power-led');
    const storageText = document.getElementById('storage-status-text');

    if (powerLed) {
      powerLed.className = isOnline 
        ? 'absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 ring-2 ring-[#0B0813]'
        : 'absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-400 ring-2 ring-[#0B0813]';
    }

    if (storageText) {
      if (isOnline) {
        storageText.textContent = this.storageAdapter.hasConfig() 
          ? 'Cloudflare R2 (Đã kết nối) + IndexedDB' 
          : 'Chưa cấu hình R2 • Lưu trữ cục bộ';
      } else {
        storageText.textContent = 'Ngoại tuyến (Offline)';
      }
    }
  }

  setSyncingState(isSyncing) {
    const btn = document.getElementById('btn-sync');
    if (!btn) return;
    
    if (isSyncing) {
      btn.setAttribute('disabled', 'true');
      btn.classList.add('opacity-70', 'cursor-wait');
      btn.querySelectorAll('svg, i, [data-lucide]').forEach((el) => {
        el.classList.add('animate-spin');
      });
    } else {
      btn.removeAttribute('disabled');
      btn.classList.remove('opacity-70', 'cursor-wait');
      btn.querySelectorAll('*').forEach((el) => {
        el.classList.remove('animate-spin');
      });
    }
  }

  async syncLibrary(showNotification = true) {
    if (!this.storageAdapter.hasConfig()) {
      if (showNotification) {
        this.showToast('Vui lòng vào Cài đặt để điền thông số Cloudflare R2.', 'warning');
        this.openSettingsModal();
      }
      return;
    }

    if (!navigator.onLine) {
      if (showNotification) {
        this.showToast('Đang ngoại tuyến, hiển thị dữ liệu lưu trong máy.', 'info');
      }
      return;
    }

    this.setSyncingState(true);

    try {
      const remoteLib = await this.storageAdapter.fetchLibrary();
      this.library = remoteLib;
      this.saveCachedLibrary();
      this.cachedSongIds = await this.offlineAdapter.getAllCachedIds();

      this.render();
      if (showNotification) {
        this.showToast(`Đã đồng bộ ${this.library.songs.length} bài hát từ R2.`, 'success');
      }
    } catch (err) {
      console.error('Sync error:', err);
      if (showNotification) {
        this.showToast(`Lỗi đồng bộ: ${err.message}`, 'error');
      }
    } finally {
      this.setSyncingState(false);
      const btn = document.getElementById('btn-sync');
      if (btn) {
        btn.querySelectorAll('*').forEach(el => el.classList.remove('animate-spin'));
      }
    }
  }

  /* ==========================================================================
     DOM EVENT BINDINGS
     ========================================================================== */

  bindDOMEvents() {
    window.addEventListener('online', () => {
      this.updateOnlineStatusDisplay();
      this.showToast('Đã kết nối lại Internet', 'success');
      if (this.storageAdapter.hasConfig()) this.syncLibrary(false);
    });

    window.addEventListener('offline', () => {
      this.updateOnlineStatusDisplay();
      this.showToast('Đã mất kết nối mạng (Chế độ Offline)', 'warning');
    });

    document.getElementById('btn-sync')?.addEventListener('click', () => this.syncLibrary(true));
    document.getElementById('btn-open-upload')?.addEventListener('click', () => this.openUploadModal());
    document.getElementById('btn-open-settings')?.addEventListener('click', () => this.openSettingsModal());
    document.getElementById('btn-install-pwa')?.addEventListener('click', () => this.handleInstallClick());

    const searchInput = document.getElementById('search-input');
    const searchClear = document.getElementById('search-clear');

    searchInput?.addEventListener('input', (e) => {
      this.searchQuery = e.target.value;
      if (searchClear) searchClear.classList.toggle('hidden', !this.searchQuery);
      this.render();
    });

    searchClear?.addEventListener('click', () => {
      this.searchQuery = '';
      if (searchInput) searchInput.value = '';
      searchClear.classList.add('hidden');
      this.render();
    });

    document.getElementById('filter-all')?.addEventListener('click', () => {
      this.offlineOnly = false;
      this.render();
    });

    document.getElementById('filter-offline')?.addEventListener('click', () => {
      this.offlineOnly = true;
      this.render();
    });

    document.getElementById('btn-tag-mode-toggle')?.addEventListener('click', () => {
      this.tagMode = this.tagMode === 'OR' ? 'AND' : 'OR';
      const textSpan = document.getElementById('tag-mode-text');
      if (textSpan) textSpan.textContent = this.tagMode;
      this.render();
    });

    document.getElementById('btn-download-filtered')?.addEventListener('click', () => {
      this.downloadAllFiltered();
    });

    document.getElementById('btn-open-tag-manager')?.addEventListener('click', () => {
      this.openTagManagerModal();
    });

    document.getElementById('btn-empty-demo')?.addEventListener('click', () => this.loadDemoSongs());
    document.getElementById('btn-empty-upload')?.addEventListener('click', () => this.openUploadModal());
    document.getElementById('btn-empty-settings')?.addEventListener('click', () => this.openSettingsModal());

    document.getElementById('btn-player-play-pause')?.addEventListener('click', () => {
      this.player.togglePlayPause();
    });
    document.getElementById('btn-player-next')?.addEventListener('click', () => {
      this.player.playNext(true);
    });
    document.getElementById('btn-player-prev')?.addEventListener('click', () => {
      this.player.playPrevious();
    });
    document.getElementById('btn-player-shuffle')?.addEventListener('click', () => {
      this.player.toggleShuffle();
    });
    document.getElementById('btn-player-loop')?.addEventListener('click', () => {
      this.player.cycleLoopMode();
    });

    const seekSlider = document.getElementById('player-seek-slider');
    seekSlider?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (this.player.duration > 0) {
        this.player.seek((val / 100) * this.player.duration);
      }
    });

    const volSlider = document.getElementById('player-volume-slider');
    volSlider?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      this.player.setVolume(val);
      const volText = document.getElementById('volume-level-text');
      if (volText) volText.textContent = `${Math.round(val * 100)}%`;
    });

    document.getElementById('btn-player-mute')?.addEventListener('click', () => {
      this.player.toggleMute();
    });

    this.setupSettingsModalEvents();
    this.setupUploadModalEvents();
    this.setupEditModalEvents();
    this.setupTagManagerModalEvents();
    this.setupConfirmModalsEvents();
  }

  /* ==========================================================================
     SETTINGS MODAL & 1-CLICK SYNC (3 TABS: ĐỒNG BỘ 1-CHẠM, CLOUDFLARE R2 & RAPIDAPI)
     ========================================================================== */

  switchSettingsTab(tab = 'sync') {
    const tabBtnSync = document.getElementById('tab-btn-sync');
    const tabBtnR2 = document.getElementById('tab-btn-r2');
    const tabBtnRapid = document.getElementById('tab-btn-rapidapi');

    const panelSync = document.getElementById('tab-panel-sync');
    const panelR2 = document.getElementById('tab-panel-r2');
    const panelRapid = document.getElementById('tab-panel-rapidapi');

    const tabs = [
      { id: 'sync', btn: tabBtnSync, panel: panelSync },
      { id: 'r2', btn: tabBtnR2, panel: panelR2 },
      { id: 'rapidapi', btn: tabBtnRapid, panel: panelRapid }
    ];

    tabs.forEach(({ id, btn, panel }) => {
      if (id === tab) {
        btn?.classList.add('border-purple-500', 'text-white', 'font-semibold');
        btn?.classList.remove('border-transparent', 'text-zinc-400', 'font-medium');
        panel?.classList.remove('hidden');
        if (panel) panel.style.display = '';
      } else {
        btn?.classList.add('border-transparent', 'text-zinc-400', 'font-medium');
        btn?.classList.remove('border-purple-500', 'text-white', 'font-semibold');
        panel?.classList.add('hidden');
        if (panel) panel.style.display = 'none';
      }
    });

    if (tab === 'sync') {
      const exportInput = document.getElementById('export-base64-input');
      if (this.storageAdapter.hasConfig()) {
        const b64 = this.exportConfigBase64(this.storageAdapter.config, this.youtubeAdapter.config);
        if (exportInput) exportInput.value = b64;
      } else if (exportInput) {
        exportInput.value = '';
      }
    }
  }

  openSettingsModal(initialTab = 'sync') {
    const modal = document.getElementById('modal-settings');
    if (!modal) return;

    this.switchSettingsTab(initialTab);

    // Populate R2 fields
    const cfg = this.storageAdapter.config || {};
    const r2EndpointInput = document.getElementById('r2-endpoint');
    const r2BucketInput = document.getElementById('r2-bucket');
    const r2AccessKeyInput = document.getElementById('r2-access-key');
    const r2SecretKeyInput = document.getElementById('r2-secret-key');

    if (r2EndpointInput) r2EndpointInput.value = cfg.endpoint || '';
    if (r2BucketInput) r2BucketInput.value = cfg.bucket || '';
    if (r2AccessKeyInput) r2AccessKeyInput.value = cfg.accessKeyId || '';
    if (r2SecretKeyInput) r2SecretKeyInput.value = cfg.secretAccessKey || '';

    // Populate RapidAPI fields
    const rapidCfg = this.youtubeAdapter.config || {};
    const rapKeyInput = document.getElementById('rapidapi-key');
    const rapHostInput = document.getElementById('rapidapi-host');
    if (rapKeyInput) rapKeyInput.value = rapidCfg.apiKey || '';
    if (rapHostInput) rapHostInput.value = rapidCfg.apiHost || 'youtube-mp36.p.rapidapi.com';

    // Populate unified Base64 export
    const exportInput = document.getElementById('export-base64-input');
    if (this.storageAdapter.hasConfig()) {
      const b64 = this.exportConfigBase64(this.storageAdapter.config, this.youtubeAdapter.config);
      if (exportInput) exportInput.value = b64;
    } else if (exportInput) {
      exportInput.value = '';
    }

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    if (window.lucide) window.lucide.createIcons({ root: modal });
  }

  closeSettingsModal() {
    const modal = document.getElementById('modal-settings');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  }

  exportConfigBase64(r2Config, rapidConfig) {
    const payload = {
      app: 'symphony-r2',
      v: 1,
      ts: Date.now(),
      config: {
        endpoint: r2Config.endpoint,
        bucket: r2Config.bucket,
        accessKeyId: r2Config.accessKeyId,
        secretAccessKey: r2Config.secretAccessKey,
        publicDomain: r2Config.publicDomain || '',
        rapidApiKey: rapidConfig?.apiKey || undefined,
        rapidApiHost: rapidConfig?.apiHost || undefined
      }
    };
    return btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  }

  setupSettingsModalEvents() {
    document.getElementById('btn-close-settings')?.addEventListener('click', () => this.closeSettingsModal());

    // Close on backdrop click
    document.getElementById('modal-settings')?.addEventListener('click', (e) => {
      if (e.target === document.getElementById('modal-settings')) {
        this.closeSettingsModal();
      }
    });

    // Close any open modal on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const modals = [
          'modal-settings',
          'modal-upload',
          'modal-edit-song',
          'modal-tag-manager',
          'modal-confirm-delete',
          'modal-confirm-remove-offline',
          'modal-ios-install'
        ];
        modals.forEach(id => {
          const m = document.getElementById(id);
          if (m && !m.classList.contains('hidden')) {
            m.classList.add('hidden');
            m.classList.remove('flex');
          }
        });
      }
    });

    // Tab navigation buttons
    document.getElementById('tab-btn-sync')?.addEventListener('click', () => this.switchSettingsTab('sync'));
    document.getElementById('tab-btn-r2')?.addEventListener('click', () => this.switchSettingsTab('r2'));
    document.getElementById('tab-btn-rapidapi')?.addEventListener('click', () => this.switchSettingsTab('rapidapi'));

    // R2 Settings Form Submit
    document.getElementById('form-r2-settings')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const newConfig = {
        endpoint: document.getElementById('r2-endpoint')?.value || '',
        bucket: document.getElementById('r2-bucket')?.value || '',
        accessKeyId: document.getElementById('r2-access-key')?.value || '',
        secretAccessKey: document.getElementById('r2-secret-key')?.value || ''
      };

      this.storageAdapter.saveConfig(newConfig);
      this.updateOnlineStatusDisplay();
      this.showToast('Đã lưu cấu hình Cloudflare R2!', 'success');
      this.closeSettingsModal();
      this.syncLibrary(true);
    });

    // Test R2 Connection
    document.getElementById('btn-test-r2')?.addEventListener('click', async () => {
      const testConfig = {
        endpoint: document.getElementById('r2-endpoint')?.value || '',
        bucket: document.getElementById('r2-bucket')?.value || '',
        accessKeyId: document.getElementById('r2-access-key')?.value || '',
        secretAccessKey: document.getElementById('r2-secret-key')?.value || ''
      };

      if (!testConfig.endpoint || !testConfig.bucket || !testConfig.accessKeyId || !testConfig.secretAccessKey) {
        this.showToast('Vui lòng điền đủ 4 trường thông số R2.', 'warning');
        return;
      }

      this.storageAdapter.saveConfig(testConfig);
      const testBtn = document.getElementById('btn-test-r2');
      const oldHtml = testBtn.innerHTML;
      testBtn.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i> Đang kiểm tra...';
      if (window.lucide) window.lucide.createIcons({ root: testBtn });

      try {
        await this.storageAdapter.testConnection();
        this.showToast('Kết nối Cloudflare R2 thành công!', 'success');
      } catch (err) {
        this.showToast(`Kết nối thất bại: ${err.message}`, 'error');
      } finally {
        testBtn.innerHTML = oldHtml;
        if (window.lucide) window.lucide.createIcons({ root: testBtn });
      }
    });

    // RapidAPI Settings Form Submit
    document.getElementById('form-rapidapi-settings')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const apiKey = document.getElementById('rapidapi-key')?.value || '';
      const apiHost = document.getElementById('rapidapi-host')?.value || 'youtube-mp36.p.rapidapi.com';

      this.youtubeAdapter.saveConfig({ apiKey, apiHost });
      this.showToast('Đã lưu cấu hình RapidAPI youtube-mp36!', 'success');
      this.closeSettingsModal();
    });

    // Test RapidAPI Connection
    document.getElementById('btn-test-rapidapi')?.addEventListener('click', async () => {
      const key = document.getElementById('rapidapi-key')?.value || '';
      const host = document.getElementById('rapidapi-host')?.value || 'youtube-mp36.p.rapidapi.com';

      if (!key.trim()) {
        this.showToast('Vui lòng điền RapidAPI Key trước khi kiểm tra.', 'warning');
        return;
      }

      const testBtn = document.getElementById('btn-test-rapidapi');
      const oldHtml = testBtn.innerHTML;
      testBtn.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i> Đang kiểm tra...';
      if (window.lucide) window.lucide.createIcons({ root: testBtn });

      try {
        await this.youtubeAdapter.testConnection(key, host);
        this.youtubeAdapter.saveConfig({ apiKey: key, apiHost: host });
        this.showToast('Kết nối RapidAPI youtube-mp36 thành công!', 'success');
      } catch (err) {
        this.showToast(`Kết nối thất bại: ${err.message}`, 'error');
      } finally {
        testBtn.innerHTML = oldHtml;
        if (window.lucide) window.lucide.createIcons({ root: testBtn });
      }
    });

    // Click to select all for Export Input
    document.getElementById('export-base64-input')?.addEventListener('click', (e) => {
      e.target.select();
    });

    // Copy Base64 Export (with fallback for mobile/non-HTTPS environments)
    document.getElementById('btn-copy-export')?.addEventListener('click', () => {
      const input = document.getElementById('export-base64-input');
      if (!input || !input.value) {
        this.showToast('Chưa có cấu hình R2 để sao chép. Vui lòng cài đặt R2 trước.', 'warning');
        return;
      }

      const copyViaExecCommand = () => {
        input.select();
        try {
          document.execCommand('copy');
          this.showToast('Đã sao chép mã cấu hình (R2 + RapidAPI)!', 'success');
        } catch {
          this.showToast('Không thể sao chép tự động, vui lòng chọn và chép thủ công.', 'warning');
        }
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(input.value)
          .then(() => {
            this.showToast('Đã sao chép mã cấu hình (R2 + RapidAPI)!', 'success');
          })
          .catch(() => copyViaExecCommand());
      } else {
        copyViaExecCommand();
      }
    });

    // Enter key support for Import Input
    document.getElementById('import-base64-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('btn-apply-import')?.click();
      }
    });

    // Apply Base64 Import
    document.getElementById('btn-apply-import')?.addEventListener('click', () => {
      const input = document.getElementById('import-base64-input');
      const val = input ? input.value.trim() : '';
      if (!val) {
        this.showToast('Vui lòng dán chuỗi Base64 trước.', 'warning');
        return;
      }

      try {
        let jsonStr = val;
        if (!val.startsWith('{')) {
          // Remove potential spaces or line breaks introduced during copy/paste on mobile
          const cleanVal = val.replace(/\s+/g, '');
          jsonStr = decodeURIComponent(escape(atob(cleanVal)));
        }
        const data = JSON.parse(jsonStr);
        const cfg = data.config || data;

        if (!cfg.endpoint || !cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) {
          throw new Error('Thiếu thông số Cloudflare R2 bắt buộc.');
        }

        this.storageAdapter.saveConfig(cfg);
        if (cfg.rapidApiKey) {
          this.youtubeAdapter.saveConfig({
            apiKey: cfg.rapidApiKey,
            apiHost: cfg.rapidApiHost || 'youtube-mp36.p.rapidapi.com'
          });
        }

        input.value = '';
        this.updateOnlineStatusDisplay();
        this.showToast('Đã nhập cấu hình thành công (R2 & RapidAPI)!', 'success');
        this.closeSettingsModal();
        this.syncLibrary(true);
      } catch (err) {
        this.showToast(`Mã cấu hình không hợp lệ: ${err.message}`, 'error');
      }
    });
  }

  /* ==========================================================================
     UPLOAD MODAL & TRACK PROBING
     ========================================================================== */

  openUploadModal() {
    if (!this.storageAdapter.hasConfig()) {
      this.showToast('Vui lòng cài đặt Cloudflare R2 trước khi tải nhạc.', 'warning');
      this.openSettingsModal();
      return;
    }

    const modal = document.getElementById('modal-upload');
    if (!modal) return;

    // Reset local upload state
    this.stagedUploadFiles = [];
    this.renderStagedFiles();
    this.renderUploadTagSuggestions();

    // Reset YouTube upload state
    this.currentYouTubeInfo = null;
    const ytUrlInput = document.getElementById('youtube-url-input');
    if (ytUrlInput) ytUrlInput.value = '';
    const ytPreviewCard = document.getElementById('youtube-preview-card');
    if (ytPreviewCard) ytPreviewCard.classList.add('hidden');

    const sourceSelect = document.getElementById('upload-source-select');
    if (sourceSelect) {
      sourceSelect.value = this.uploadSourceMode || 'local';
    }
    this.switchUploadSource(this.uploadSourceMode || 'local');

    const tagsInput = document.getElementById('upload-tags-input');
    if (tagsInput) tagsInput.value = '';

    const progressWrapper = document.getElementById('upload-progress-wrapper');
    if (progressWrapper) progressWrapper.classList.add('hidden');

    const submitBtn = document.getElementById('btn-start-upload');
    if (submitBtn) {
      submitBtn.disabled = this.uploadSourceMode === 'youtube'
        ? !this.currentYouTubeInfo
        : this.stagedUploadFiles.length === 0;
    }

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    if (window.lucide) window.lucide.createIcons({ root: modal });
  }

  switchUploadSource(mode) {
    this.uploadSourceMode = mode;
    const secLocal = document.getElementById('section-upload-local');
    const secYouTube = document.getElementById('section-upload-youtube');
    const submitBtn = document.getElementById('btn-start-upload');
    const ytAlert = document.getElementById('youtube-rapidapi-alert');

    if (mode === 'youtube') {
      secLocal?.classList.add('hidden');
      secYouTube?.classList.remove('hidden');

      const hasRapid = this.youtubeAdapter.hasConfig();
      if (ytAlert) {
        if (hasRapid) {
          ytAlert.classList.add('hidden');
        } else {
          ytAlert.classList.remove('hidden');
          ytAlert.classList.add('flex');
        }
      }

      if (submitBtn) {
        submitBtn.disabled = !this.currentYouTubeInfo;
      }
    } else {
      secLocal?.classList.remove('hidden');
      secYouTube?.classList.add('hidden');
      if (submitBtn) {
        submitBtn.disabled = this.stagedUploadFiles.length === 0;
      }
    }
  }

  closeUploadModal() {
    const modal = document.getElementById('modal-upload');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  }

  renderUploadTagSuggestions() {
    const wrapper = document.getElementById('upload-tag-suggestions');
    if (!wrapper) return;

    const allTags = this.extractAllTags();
    if (allTags.length === 0) {
      wrapper.innerHTML = '';
      return;
    }

    wrapper.innerHTML = allTags.slice(0, 8).map(t => `
      <button type="button" class="upload-tag-chip px-2 py-0.5 rounded bg-purple-900/60 hover:bg-purple-800 text-[11px] text-purple-200 border border-purple-700/50 transition" data-tag="${escapeHTML(t.tag)}">
        + ${escapeHTML(t.tag)}
      </button>
    `).join('');

    wrapper.querySelectorAll('.upload-tag-chip').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tag = e.currentTarget.getAttribute('data-tag');
        const input = document.getElementById('upload-tags-input');
        if (input) {
          const current = input.value.split(',').map(s => s.trim()).filter(Boolean);
          if (!current.includes(tag)) {
            current.push(tag);
            input.value = current.join(', ');
          }
        }
      });
    });
  }

  async probeAudioDuration(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const tempAudio = new Audio();
      tempAudio.preload = 'metadata';

      tempAudio.onloadedmetadata = () => {
        const dur = Math.round(tempAudio.duration) || 0;
        URL.revokeObjectURL(url);
        resolve(dur);
      };

      tempAudio.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(0);
      };

      tempAudio.src = url;
    });
  }

  async stageFiles(fileList) {
    for (const file of Array.from(fileList)) {
      const duration = await this.probeAudioDuration(file);
      const nameWithoutExt = file.name.replace(/\.[^/.]+$/, '');

      this.stagedUploadFiles.push({
        id: generateUUID(),
        file: file,
        title: nameWithoutExt,
        duration: duration,
        size: file.size,
        type: file.type || 'audio/mpeg'
      });
    }

    this.renderStagedFiles();
    const submitBtn = document.getElementById('btn-start-upload');
    if (submitBtn) submitBtn.disabled = this.stagedUploadFiles.length === 0;
  }

  renderStagedFiles() {
    const container = document.getElementById('staged-files-container');
    if (!container) return;

    if (this.stagedUploadFiles.length === 0) {
      container.classList.add('hidden');
      container.innerHTML = '';
      return;
    }

    container.classList.remove('hidden');
    container.innerHTML = this.stagedUploadFiles.map((item, idx) => `
      <div class="flex items-center justify-between gap-2 p-2 rounded-lg bg-[#0B0813] border border-purple-900/60 text-xs">
        <div class="min-w-0 flex-1">
          <input 
            type="text" 
            value="${escapeHTML(item.title)}" 
            data-index="${idx}"
            class="staged-file-title-input w-full bg-transparent text-white font-medium focus:outline-none border-b border-purple-800 focus:border-purple-400 pb-0.5"
            placeholder="Tên bài hát"
          />
          <div class="text-[10px] text-purple-400/60 mt-1 flex items-center gap-1.5 font-mono">
            <span>${formatDuration(item.duration)}</span>
            <span>•</span>
            <span>${formatFileSize(item.size)}</span>
          </div>
        </div>
        <button type="button" class="btn-remove-staged text-purple-400/60 hover:text-red-400 p-1" data-index="${idx}">
          <i data-lucide="trash" class="w-3.5 h-3.5"></i>
        </button>
      </div>
    `).join('');

    container.querySelectorAll('.staged-file-title-input').forEach(input => {
      input.addEventListener('input', (e) => {
        const idx = parseInt(e.target.getAttribute('data-index'), 10);
        if (this.stagedUploadFiles[idx]) {
          this.stagedUploadFiles[idx].title = e.target.value.trim() || this.stagedUploadFiles[idx].file.name;
        }
      });
    });

    container.querySelectorAll('.btn-remove-staged').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.getAttribute('data-index'), 10);
        this.stagedUploadFiles.splice(idx, 1);
        this.renderStagedFiles();
        const submitBtn = document.getElementById('btn-start-upload');
        if (submitBtn) submitBtn.disabled = this.stagedUploadFiles.length === 0;
      });
    });

    if (window.lucide) window.lucide.createIcons({ root: container });
  }

  setupUploadModalEvents() {
    const dropzone = document.getElementById('upload-dropzone');
    const fileInput = document.getElementById('upload-file-input');

    // Source selector change (Local file vs YouTube)
    document.getElementById('upload-source-select')?.addEventListener('change', (e) => {
      this.switchUploadSource(e.target.value);
    });

    // Go to RapidAPI Settings button from warning alert
    document.getElementById('btn-goto-rapidapi-settings')?.addEventListener('click', () => {
      this.closeUploadModal();
      this.openSettingsModal('rapidapi');
    });

    // Fetch YouTube Info via RapidAPI
    document.getElementById('btn-fetch-youtube-info')?.addEventListener('click', async () => {
      const input = document.getElementById('youtube-url-input');
      const rawVal = input ? input.value.trim() : '';

      if (!rawVal) {
        this.showToast('Vui lòng nhập link hoặc mã video YouTube.', 'warning');
        return;
      }

      const videoId = extractYouTubeVideoId(rawVal);
      if (!videoId) {
        this.showToast('Link YouTube không hợp lệ. Vui lòng kiểm tra lại.', 'error');
        return;
      }

      if (!this.youtubeAdapter.hasConfig()) {
        this.showToast('Chưa cấu hình RapidAPI Key. Vui lòng cài đặt trước.', 'warning');
        this.closeUploadModal();
        this.openSettingsModal('rapidapi');
        return;
      }

      const fetchBtn = document.getElementById('btn-fetch-youtube-info');
      const oldHtml = fetchBtn.innerHTML;
      fetchBtn.disabled = true;
      fetchBtn.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i> Đang lấy...';
      if (window.lucide) window.lucide.createIcons({ root: fetchBtn });

      try {
        const info = await this.youtubeAdapter.fetchDownloadInfo(videoId);
        this.currentYouTubeInfo = info;

        const titleInput = document.getElementById('youtube-track-title');
        const durSpan = document.getElementById('youtube-track-duration');
        const previewCard = document.getElementById('youtube-preview-card');
        const submitBtn = document.getElementById('btn-start-upload');

        if (titleInput) titleInput.value = info.title;
        if (durSpan) durSpan.textContent = `Thời lượng: ${formatDuration(info.duration)}`;
        if (previewCard) previewCard.classList.remove('hidden');
        if (submitBtn) submitBtn.disabled = false;

        this.showToast(`Đã lấy thông tin: "${info.title}"`, 'success');
      } catch (err) {
        console.error('Fetch YouTube info error:', err);
        this.showToast(`Lỗi RapidAPI: ${err.message}`, 'error');
      } finally {
        fetchBtn.disabled = false;
        fetchBtn.innerHTML = oldHtml;
        if (window.lucide) window.lucide.createIcons({ root: fetchBtn });
      }
    });

    dropzone?.addEventListener('click', () => fileInput?.click());

    fileInput?.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        this.stageFiles(e.target.files);
      }
    });

    dropzone?.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('border-purple-400', 'bg-purple-950/70');
    });

    dropzone?.addEventListener('dragleave', () => {
      dropzone.classList.remove('border-purple-400', 'bg-purple-950/70');
    });

    dropzone?.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('border-purple-400', 'bg-purple-950/70');
      if (e.dataTransfer && e.dataTransfer.files) {
        this.stageFiles(e.dataTransfer.files);
      }
    });

    document.getElementById('btn-close-upload')?.addEventListener('click', () => this.closeUploadModal());
    document.getElementById('btn-cancel-upload')?.addEventListener('click', () => this.closeUploadModal());
    document.getElementById('modal-upload')?.addEventListener('click', (e) => {
      if (e.target === document.getElementById('modal-upload')) {
        this.closeUploadModal();
      }
    });

    document.getElementById('form-upload-track')?.addEventListener('submit', async (e) => {
      e.preventDefault();

      // Case 1: Upload from YouTube via RapidAPI
      if (this.uploadSourceMode === 'youtube') {
        if (!this.currentYouTubeInfo) {
          this.showToast('Vui lòng lấy thông tin video YouTube trước khi tải lên.', 'warning');
          return;
        }

        const titleInput = document.getElementById('youtube-track-title');
        const trackTitle = titleInput ? titleInput.value.trim() || this.currentYouTubeInfo.title : this.currentYouTubeInfo.title;

        const tagsInput = document.getElementById('upload-tags-input');
        const sharedTags = tagsInput 
          ? tagsInput.value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
          : [];

        const saveOffline = document.getElementById('youtube-save-offline-checkbox')?.checked ?? true;

        const progressWrapper = document.getElementById('upload-progress-wrapper');
        const progressBar = document.getElementById('upload-progress-bar');
        const statusLabel = document.getElementById('upload-status-label');
        const percentageLabel = document.getElementById('upload-percentage');
        const submitBtn = document.getElementById('btn-start-upload');

        if (progressWrapper) progressWrapper.classList.remove('hidden');
        if (submitBtn) submitBtn.disabled = true;

        try {
          if (statusLabel) statusLabel.textContent = `Đang tải âm thanh MP3 từ YouTube (${this.currentYouTubeInfo.id})...`;
          if (progressBar) progressBar.style.width = '30%';
          if (percentageLabel) percentageLabel.textContent = '30%';

          const audioBlob = await this.youtubeAdapter.downloadAudioBlob(this.currentYouTubeInfo.link);

          if (statusLabel) statusLabel.textContent = 'Đang tải lên Cloudflare R2...';
          if (progressBar) progressBar.style.width = '70%';
          if (percentageLabel) percentageLabel.textContent = '70%';

          const songId = generateUUID();
          const fileKey = `tracks/${songId}.mp3`;
          const arrayBuffer = await audioBlob.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);

          await this.storageAdapter.uploadTrack(uint8Array, fileKey, 'audio/mpeg');

          const newSong = {
            id: songId,
            title: trackTitle,
            fileName: fileKey,
            size: audioBlob.size,
            duration: this.currentYouTubeInfo.duration || 0,
            tags: sharedTags.length > 0 ? [...sharedTags] : ['youtube'],
            createdAt: Date.now()
          };

          this.library.songs.unshift(newSong);

          if (saveOffline) {
            if (statusLabel) statusLabel.textContent = 'Đang lưu bản Offline vào máy...';
            await this.offlineAdapter.saveAudio(songId, audioBlob, {
              title: trackTitle,
              duration: newSong.duration
            });
            this.cachedSongIds.add(songId);
          }

          if (statusLabel) statusLabel.textContent = 'Đang cập nhật library.json lên R2...';
          if (progressBar) progressBar.style.width = '95%';
          if (percentageLabel) percentageLabel.textContent = '95%';

          await this.storageAdapter.saveLibrary(this.library);
          this.saveCachedLibrary();

          if (progressBar) progressBar.style.width = '100%';
          if (percentageLabel) percentageLabel.textContent = '100%';

          this.showToast(`Đã tải thành công bài hát "${trackTitle}" lên R2!`, 'success');
          this.closeUploadModal();
          this.render();
        } catch (err) {
          console.error('YouTube upload error:', err);
          this.showToast(`Lỗi khi tải bài từ YouTube: ${err.message}`, 'error');
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
        return;
      }

      // Case 2: Upload local files
      if (this.stagedUploadFiles.length === 0) return;

      const tagsInput = document.getElementById('upload-tags-input');
      const sharedTags = tagsInput 
        ? tagsInput.value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
        : [];

      const progressWrapper = document.getElementById('upload-progress-wrapper');
      const progressBar = document.getElementById('upload-progress-bar');
      const statusLabel = document.getElementById('upload-status-label');
      const percentageLabel = document.getElementById('upload-percentage');
      const submitBtn = document.getElementById('btn-start-upload');

      if (progressWrapper) progressWrapper.classList.remove('hidden');
      if (submitBtn) submitBtn.disabled = true;

      const totalFiles = this.stagedUploadFiles.length;
      let completed = 0;

      for (const item of this.stagedUploadFiles) {
        if (statusLabel) statusLabel.textContent = `Đang tải: ${item.title} (${completed + 1}/${totalFiles})...`;

        const ext = item.file.name.split('.').pop() || 'mp3';
        const fileKey = `tracks/${item.id}.${ext}`;

        try {
          const arrayBuffer = await item.file.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);

          await this.storageAdapter.uploadTrack(uint8Array, fileKey, item.type);

          const newSong = {
            id: item.id,
            title: item.title,
            fileName: fileKey,
            size: item.size,
            duration: item.duration,
            tags: sharedTags.length > 0 ? [...sharedTags] : ['nhạc'],
            createdAt: Date.now()
          };

          this.library.songs.unshift(newSong);
          completed++;

          const percent = Math.round((completed / totalFiles) * 100);
          if (progressBar) progressBar.style.width = `${percent}%`;
          if (percentageLabel) percentageLabel.textContent = `${percent}%`;
        } catch (err) {
          console.error('Upload error:', item.title, err);
          this.showToast(`Lỗi bài "${item.title}": ${err.message}`, 'error');
        }
      }

      if (statusLabel) statusLabel.textContent = 'Đang lưu library.json...';
      try {
        await this.storageAdapter.saveLibrary(this.library);
        this.saveCachedLibrary();
        this.showToast(`Đã tải lên ${completed}/${totalFiles} bài hát!`, 'success');
        this.closeUploadModal();
        this.render();
      } catch (err) {
        this.showToast(`Lỗi lưu thư viện: ${err.message}`, 'error');
      }
    });
  }

  /* ==========================================================================
     EDIT SONG & TAGS MODAL
     ========================================================================== */

  openEditSongModal(songId) {
    const song = this.library.songs.find(s => s.id === songId);
    if (!song) return;

    const modal = document.getElementById('modal-edit-song');
    if (!modal) return;

    document.getElementById('edit-song-id').value = song.id;
    document.getElementById('edit-song-title').value = song.title;

    this.currentEditingTags = [...(song.tags || [])];
    this.renderEditCurrentTags();
    this.renderEditLibraryTagsList();

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    if (window.lucide) window.lucide.createIcons({ root: modal });
  }

  closeEditSongModal() {
    const modal = document.getElementById('modal-edit-song');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  }

  renderEditCurrentTags() {
    const wrapper = document.getElementById('edit-current-tags');
    if (!wrapper) return;

    if (this.currentEditingTags.length === 0) {
      wrapper.innerHTML = '<span class="text-xs text-purple-400/40">Chưa có tag nào</span>';
      return;
    }

    wrapper.innerHTML = this.currentEditingTags.map((tag, idx) => `
      <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-purple-900/70 text-purple-200 text-xs font-medium border border-purple-700/60">
        <span>${escapeHTML(tag)}</span>
        <button type="button" class="btn-remove-editing-tag text-purple-400 hover:text-white" data-index="${idx}">
          <i data-lucide="x" class="w-3 h-3"></i>
        </button>
      </span>
    `).join('');

    wrapper.querySelectorAll('.btn-remove-editing-tag').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.getAttribute('data-index'), 10);
        this.currentEditingTags.splice(idx, 1);
        this.renderEditCurrentTags();
      });
    });

    if (window.lucide) window.lucide.createIcons({ root: wrapper });
  }

  renderEditLibraryTagsList() {
    const container = document.getElementById('edit-library-tags-list');
    if (!container) return;

    const allTags = this.extractAllTags();
    container.innerHTML = allTags.map(t => `
      <button type="button" class="btn-quick-add-tag px-2 py-0.5 rounded bg-purple-950/70 hover:bg-purple-900 text-[11px] text-purple-300 border border-purple-800/40 transition" data-tag="${escapeHTML(t.tag)}">
        + ${escapeHTML(t.tag)}
      </button>
    `).join('');

    container.querySelectorAll('.btn-quick-add-tag').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tag = e.currentTarget.getAttribute('data-tag');
        if (!this.currentEditingTags.includes(tag)) {
          this.currentEditingTags.push(tag);
          this.renderEditCurrentTags();
        }
      });
    });
  }

  setupEditModalEvents() {
    document.getElementById('btn-close-edit')?.addEventListener('click', () => this.closeEditSongModal());
    document.getElementById('btn-cancel-edit')?.addEventListener('click', () => this.closeEditSongModal());
    document.getElementById('modal-edit-song')?.addEventListener('click', (e) => {
      if (e.target === document.getElementById('modal-edit-song')) {
        this.closeEditSongModal();
      }
    });

    document.getElementById('btn-add-edit-tag')?.addEventListener('click', () => {
      const input = document.getElementById('edit-new-tag-input');
      const val = input ? input.value.trim().toLowerCase() : '';
      if (val && !this.currentEditingTags.includes(val)) {
        this.currentEditingTags.push(val);
        input.value = '';
        this.renderEditCurrentTags();
      }
    });

    document.getElementById('form-edit-song')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const songId = document.getElementById('edit-song-id').value;
      const newTitle = document.getElementById('edit-song-title').value.trim();

      const song = this.library.songs.find(s => s.id === songId);
      if (!song) return;

      song.title = newTitle || song.title;
      song.tags = [...this.currentEditingTags];

      this.closeEditSongModal();
      this.render();

      try {
        if (this.storageAdapter.hasConfig() && navigator.onLine) {
          await this.storageAdapter.saveLibrary(this.library);
          this.saveCachedLibrary();
          this.showToast('Đã lưu bài hát lên R2!', 'success');
        } else {
          this.saveCachedLibrary();
          this.showToast('Đã lưu vào bộ nhớ máy.', 'info');
        }
      } catch (err) {
        this.showToast(`Lỗi khi lưu lên R2: ${err.message}`, 'error');
      }
    });
  }

  /* ==========================================================================
     TAG MANAGER MODAL
     ========================================================================== */

  openTagManagerModal() {
    const modal = document.getElementById('modal-tag-manager');
    if (!modal) return;

    this.renderTagManagerList();

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    if (window.lucide) window.lucide.createIcons({ root: modal });
  }

  closeTagManagerModal() {
    const modal = document.getElementById('modal-tag-manager');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  }

  renderTagManagerList() {
    const container = document.getElementById('tag-manager-list');
    if (!container) return;

    const allTags = this.extractAllTags();
    if (allTags.length === 0) {
      container.innerHTML = '<p class="text-xs text-purple-400/40 py-3 text-center">Chưa có tag nào trong thư viện.</p>';
      return;
    }

    container.innerHTML = allTags.map(item => `
      <div class="flex items-center justify-between gap-2 p-2 rounded-lg bg-[#181130] border border-purple-800/40 text-xs">
        <div class="flex items-center gap-1.5">
          <span class="font-medium text-white">${escapeHTML(item.tag)}</span>
          <span class="text-[10px] text-purple-400">(${item.count})</span>
        </div>
        <div class="flex items-center gap-1">
          <button class="btn-rename-tag px-2 py-0.5 rounded bg-purple-900/60 hover:bg-purple-800 text-purple-200 border border-purple-700/50 text-[11px] font-medium" data-tag="${escapeHTML(item.tag)}">
            Đổi tên
          </button>
          <button class="btn-delete-tag p-1 text-purple-400/60 hover:text-red-400" data-tag="${escapeHTML(item.tag)}" title="Xoá tag này">
            <i data-lucide="trash" class="w-3.5 h-3.5"></i>
          </button>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.btn-rename-tag').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const oldTag = e.currentTarget.getAttribute('data-tag');
        const newTag = prompt(`Nhập tên mới cho tag "${oldTag}":`, oldTag);
        if (newTag && newTag.trim() && newTag.trim().toLowerCase() !== oldTag.toLowerCase()) {
          this.renameTagGlobally(oldTag, newTag.trim().toLowerCase());
        }
      });
    });

    container.querySelectorAll('.btn-delete-tag').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const tag = e.currentTarget.getAttribute('data-tag');
        if (confirm(`Bạn có chắc muốn xoá tag "${tag}" khỏi tất cả bài hát?`)) {
          this.deleteTagGlobally(tag);
        }
      });
    });

    if (window.lucide) window.lucide.createIcons({ root: container });
  }

  async renameTagGlobally(oldTag, newTag) {
    let changed = 0;
    this.library.songs.forEach(song => {
      const idx = song.tags.findIndex(t => t.toLowerCase() === oldTag.toLowerCase());
      if (idx !== -1) {
        song.tags[idx] = newTag;
        changed++;
      }
    });

    this.renderTagManagerList();
    this.render();

    if (this.storageAdapter.hasConfig() && navigator.onLine) {
      await this.storageAdapter.saveLibrary(this.library);
      this.saveCachedLibrary();
    }
    this.showToast(`Đã đổi tên tag thành "${newTag}".`, 'success');
  }

  async deleteTagGlobally(tagToDelete) {
    let changed = 0;
    this.library.songs.forEach(song => {
      const prevLen = song.tags.length;
      song.tags = song.tags.filter(t => t.toLowerCase() !== tagToDelete.toLowerCase());
      if (song.tags.length < prevLen) changed++;
    });

    this.selectedTags.delete(tagToDelete.toLowerCase());
    this.renderTagManagerList();
    this.render();

    if (this.storageAdapter.hasConfig() && navigator.onLine) {
      await this.storageAdapter.saveLibrary(this.library);
      this.saveCachedLibrary();
    }
    this.showToast(`Đã xoá tag "${tagToDelete}".`, 'success');
  }

  setupTagManagerModalEvents() {
    document.getElementById('btn-close-tag-manager')?.addEventListener('click', () => this.closeTagManagerModal());
    document.getElementById('modal-tag-manager')?.addEventListener('click', (e) => {
      if (e.target === document.getElementById('modal-tag-manager')) {
        this.closeTagManagerModal();
      }
    });
  }

  /* ==========================================================================
     CONFIRMATION MODALS
     ========================================================================== */

  setupConfirmModalsEvents() {
    const hideDelete = () => {
      const m = document.getElementById('modal-confirm-delete');
      if (m) {
        m.classList.add('hidden');
        m.classList.remove('flex');
      }
      this.songToDelete = null;
    };
    document.getElementById('btn-cancel-delete')?.addEventListener('click', hideDelete);
    document.getElementById('modal-confirm-delete')?.addEventListener('click', (e) => {
      if (e.target === document.getElementById('modal-confirm-delete')) hideDelete();
    });

    document.getElementById('btn-execute-delete')?.addEventListener('click', async () => {
      if (!this.songToDelete) return;
      const song = this.songToDelete;
      hideDelete();

      try {
        if (this.storageAdapter.hasConfig() && navigator.onLine && !song.isDemo) {
          await this.storageAdapter.deleteTrack(song.fileName);
        }

        await this.offlineAdapter.deleteAudio(song.id);
        this.cachedSongIds.delete(song.id);
        this.library.songs = this.library.songs.filter(s => s.id !== song.id);

        if (this.storageAdapter.hasConfig() && navigator.onLine && !song.isDemo) {
          await this.storageAdapter.saveLibrary(this.library);
        }
        this.saveCachedLibrary();

        if (this.player.currentSong?.id === song.id) {
          this.player.pause();
          this.player.currentSong = null;
        }

        this.showToast(`Đã xoá bài hát "${song.title}".`, 'success');
        this.render();
      } catch (err) {
        this.showToast(`Lỗi khi xoá: ${err.message}`, 'error');
      } finally {
        this.songToDelete = null;
      }
    });

    const hideRemoveOffline = () => {
      const m = document.getElementById('modal-confirm-remove-offline');
      if (m) {
        m.classList.add('hidden');
        m.classList.remove('flex');
      }
      this.songToRemoveOffline = null;
    };
    document.getElementById('btn-cancel-remove-offline')?.addEventListener('click', hideRemoveOffline);
    document.getElementById('modal-confirm-remove-offline')?.addEventListener('click', (e) => {
      if (e.target === document.getElementById('modal-confirm-remove-offline')) hideRemoveOffline();
    });

    document.getElementById('btn-execute-remove-offline')?.addEventListener('click', async () => {
      if (!this.songToRemoveOffline) return;
      const song = this.songToRemoveOffline;
      hideRemoveOffline();

      try {
        await this.offlineAdapter.deleteAudio(song.id);
        this.cachedSongIds.delete(song.id);
        this.showToast(`Đã xoá bản offline của "${song.title}".`, 'info');
        this.render();
      } catch (err) {
        this.showToast(`Lỗi khi xoá offline: ${err.message}`, 'error');
      } finally {
        this.songToRemoveOffline = null;
      }
    });

    const hideIosInstall = () => {
      const m = document.getElementById('modal-ios-install');
      if (m) {
        m.classList.add('hidden');
        m.classList.remove('flex');
      }
    };
    document.getElementById('btn-close-ios-install')?.addEventListener('click', hideIosInstall);
    document.getElementById('btn-confirm-ios-install')?.addEventListener('click', hideIosInstall);
    document.getElementById('modal-ios-install')?.addEventListener('click', (e) => {
      if (e.target === document.getElementById('modal-ios-install')) hideIosInstall();
    });
  }

  handleInstallClick() {
    if (this.deferredInstallPrompt) {
      this.deferredInstallPrompt.prompt();
      this.deferredInstallPrompt.userChoice.then((choice) => {
        if (choice.outcome === 'accepted') {
          this.showToast('Cảm ơn bạn đã cài đặt ứng dụng!', 'success');
        }
        this.deferredInstallPrompt = null;
      });
      return;
    }

    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isIOS) {
      const modal = document.getElementById('modal-ios-install');
      if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        if (window.lucide) window.lucide.createIcons({ root: modal });
      }
    } else {
      this.showToast('Bấm Menu trình duyệt -> Chọn "Cài đặt ứng dụng".', 'info');
    }
  }

  /* ==========================================================================
     OFFLINE DOWNLOAD ACTIONS
     ========================================================================== */

  async downloadSongOffline(song) {
    if (this.cachedSongIds.has(song.id)) {
      this.songToRemoveOffline = song;
      const modal = document.getElementById('modal-confirm-remove-offline');
      if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        if (window.lucide) window.lucide.createIcons({ root: modal });
      }
      return;
    }

    if (this.downloadingSongIds.has(song.id)) return;

    if (!navigator.onLine && !song.demoBlob) {
      this.showToast('Không có kết nối mạng để tải file.', 'warning');
      return;
    }

    this.downloadingSongIds.add(song.id);
    this.render();

    try {
      let blob = null;
      if (song.demoBlob) {
        blob = song.demoBlob;
      } else {
        blob = await this.storageAdapter.downloadTrackBlob(song.fileName);
      }

      await this.offlineAdapter.saveAudio(song.id, blob, {
        title: song.title,
        duration: song.duration
      });

      this.cachedSongIds.add(song.id);
      this.showToast(`Đã tải offline "${song.title}"!`, 'success');
    } catch (err) {
      console.error('Download offline error:', song.title, err);
      this.showToast(`Tải bài "${song.title}" thất bại: ${err.message}`, 'error');
    } finally {
      this.downloadingSongIds.delete(song.id);
      this.render();
    }
  }

  async downloadAllFiltered() {
    const filtered = this.getFilteredSongs();
    const needDownload = filtered.filter(s => !this.cachedSongIds.has(s.id));

    if (needDownload.length === 0) {
      this.showToast('Tất cả bài trong danh sách đã được lưu offline.', 'info');
      return;
    }

    if (!navigator.onLine && !needDownload.some(s => s.demoBlob)) {
      this.showToast('Không có mạng để tải nhạc.', 'warning');
      return;
    }

    this.showToast(`Bắt đầu tải ${needDownload.length} bài hát...`, 'info');

    let successCount = 0;
    for (const song of needDownload) {
      this.downloadingSongIds.add(song.id);
      this.render();

      try {
        let blob = song.demoBlob || await this.storageAdapter.downloadTrackBlob(song.fileName);
        await this.offlineAdapter.saveAudio(song.id, blob, {
          title: song.title,
          duration: song.duration
        });
        this.cachedSongIds.add(song.id);
        successCount++;
      } catch (err) {
        console.error('Batch download item error:', song.title, err);
      } finally {
        this.downloadingSongIds.delete(song.id);
        this.render();
      }
    }

    this.showToast(`Đã tải xong ${successCount}/${needDownload.length} bài hát!`, 'success');
  }

  /* ==========================================================================
     DEMO SONGS GENERATOR
     ========================================================================== */

  async loadDemoSongs() {
    this.showToast('Đang tạo 3 bài hát mẫu...', 'info');

    try {
      const demo1Blob = await generateDemoAudioBlob(261.63, 25);
      const demo2Blob = await generateDemoAudioBlob(329.63, 28);
      const demo3Blob = await generateDemoAudioBlob(392.00, 32);

      const demoSongs = [
        {
          id: 'demo-1-' + generateUUID(),
          title: 'Nàng Thơ (Acoustic Demo)',
          fileName: 'tracks/demo-1.wav',
          size: demo1Blob.size,
          duration: 25,
          tags: ['chill', 'acoustic', 'vietnam'],
          createdAt: Date.now() - 30000,
          demoBlob: demo1Blob,
          isDemo: true
        },
        {
          id: 'demo-2-' + generateUUID(),
          title: 'Lofi Midnight Coffee',
          fileName: 'tracks/demo-2.wav',
          size: demo2Blob.size,
          duration: 28,
          tags: ['chill', 'lofi', 'instrumental'],
          createdAt: Date.now() - 20000,
          demoBlob: demo2Blob,
          isDemo: true
        },
        {
          id: 'demo-3-' + generateUUID(),
          title: 'Vintage Vinyl Chillhop',
          fileName: 'tracks/demo-3.wav',
          size: demo3Blob.size,
          duration: 32,
          tags: ['lofi', 'vinyl', 'retro'],
          createdAt: Date.now() - 10000,
          demoBlob: demo3Blob,
          isDemo: true
        }
      ];

      this.library.songs = [...demoSongs, ...this.library.songs];
      this.saveCachedLibrary();
      this.render();
      this.showToast('Đã thêm 3 bài hát mẫu vào danh sách!', 'success');
    } catch (err) {
      console.error('Failed generating demo songs', err);
      this.showToast('Không thể tạo bài hát demo: ' + err.message, 'error');
    }
  }

  /* ==========================================================================
     FILTER ENGINE & TAG CALCULATIONS
     ========================================================================== */

  extractAllTags() {
    const countMap = new Map();
    for (const song of this.library.songs) {
      if (Array.isArray(song.tags)) {
        for (const rawTag of song.tags) {
          const trimmed = rawTag.trim();
          if (!trimmed) continue;
          const lower = trimmed.toLowerCase();
          countMap.set(lower, (countMap.get(lower) || 0) + 1);
        }
      }
    }
    return Array.from(countMap.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  getFilteredSongs() {
    const rawQuery = this.searchQuery.trim();
    const selectedTagsList = Array.from(this.selectedTags);

    return this.library.songs.filter(song => {
      if (this.offlineOnly && !this.cachedSongIds.has(song.id)) {
        return false;
      }

      if (rawQuery) {
        const matchTitle = matchesSearch(song.title, rawQuery);
        const matchFile = matchesSearch(song.fileName, rawQuery);
        const matchTag = song.tags && song.tags.some(t => matchesSearch(t, rawQuery));
        if (!matchTitle && !matchFile && !matchTag) {
          return false;
        }
      }

      if (selectedTagsList.length > 0) {
        const songTagsLower = (song.tags || []).map(t => t.toLowerCase());
        if (this.tagMode === 'AND') {
          const matchesAll = selectedTagsList.every(st => songTagsLower.includes(st));
          if (!matchesAll) return false;
        } else {
          const matchesAny = selectedTagsList.some(st => songTagsLower.includes(st));
          if (!matchesAny) return false;
        }
      }

      return true;
    });
  }

  /* ==========================================================================
     UI RENDERING
     ========================================================================== */

  render() {
    this.renderTagChips();
    this.renderSongsList();
    this.updateFilterButtonsUI();
    this.updatePlayerUI();
    this.updateSongListPlayStates();
  }

  updateFilterButtonsUI() {
    const btnAll = document.getElementById('filter-all');
    const btnOffline = document.getElementById('filter-offline');
    const badgeAll = document.getElementById('badge-all-count');
    const badgeOffline = document.getElementById('badge-offline-count');

    if (badgeAll) {
      badgeAll.textContent = this.library.songs.length;
      badgeAll.className = `px-1.5 py-0.2 rounded-full ${this.offlineOnly ? 'bg-purple-950/80 text-purple-300 border border-purple-800/50' : 'bg-purple-950 text-white border border-purple-700/60'} text-[11px]`;
    }
    if (badgeOffline) {
      badgeOffline.textContent = this.cachedSongIds.size;
      badgeOffline.className = `px-1.5 py-0.2 rounded-full ${this.offlineOnly ? 'bg-purple-950 text-white border border-purple-700/60' : 'bg-[#241A45] text-zinc-300 border border-purple-800/40'} text-[11px]`;
    }

    if (this.offlineOnly) {
      if (btnAll) btnAll.className = 'flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#18132A] text-zinc-300 hover:text-white hover:bg-[#221A3B] font-medium text-xs border border-purple-800/40 transition shadow-sm';
      if (btnOffline) btnOffline.className = 'flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-600 text-white font-medium text-xs transition shadow-md shadow-purple-900/40';
    } else {
      if (btnAll) btnAll.className = 'flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-600 text-white font-medium text-xs transition shadow-md shadow-purple-900/40';
      if (btnOffline) btnOffline.className = 'flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#18132A] text-zinc-300 hover:text-white hover:bg-[#221A3B] font-medium text-xs border border-purple-800/40 transition shadow-sm';
    }
  }

  renderTagChips() {
    const wrapper = document.getElementById('tag-chips-wrapper');
    if (!wrapper) return;

    const allTags = this.extractAllTags();
    if (allTags.length === 0) {
      wrapper.innerHTML = '<span class="text-xs text-zinc-500">Chưa có tag nào</span>';
      return;
    }

    wrapper.innerHTML = allTags.map(item => {
      const isSelected = this.selectedTags.has(item.tag);
      const activeClass = isSelected 
        ? 'bg-purple-600 text-white font-medium shadow-md shadow-purple-900/40' 
        : 'bg-[#18132A] text-zinc-300 hover:text-white hover:bg-[#221A3B] border border-purple-800/40 transition shadow-sm';

      return `
        <button 
          class="tag-filter-chip px-2.5 py-1 rounded-md text-xs transition flex items-center gap-1.5 ${activeClass}" 
          data-tag="${escapeHTML(item.tag)}"
        >
          <span>${escapeHTML(item.tag)}</span>
          <span class="text-[10px] opacity-75">(${item.count})</span>
        </button>
      `;
    }).join('');

    wrapper.querySelectorAll('.tag-filter-chip').forEach(chip => {
      chip.addEventListener('click', (e) => {
        const tag = e.currentTarget.getAttribute('data-tag');
        if (this.selectedTags.has(tag)) {
          this.selectedTags.delete(tag);
        } else {
          this.selectedTags.add(tag);
        }
        this.render();
      });
    });
  }

  renderSongsList() {
    const container = document.getElementById('songs-list-container');
    const emptyState = document.getElementById('songs-empty-state');
    const filteredCountBadge = document.getElementById('filtered-songs-count');
    if (!container) return;

    const filtered = this.getFilteredSongs();
    if (filteredCountBadge) {
      filteredCountBadge.textContent = `(${filtered.length} bài)`;
    }

    this.player.setQueue(filtered);

    if (filtered.length === 0) {
      container.innerHTML = '';
      if (emptyState) {
        emptyState.classList.remove('hidden');
        const emptyTitle = document.getElementById('empty-title');
        const emptyDesc = document.getElementById('empty-desc');

        if (this.library.songs.length === 0) {
          if (emptyTitle) emptyTitle.textContent = 'Chưa có bài hát nào trong thư viện';
          if (emptyDesc) emptyDesc.textContent = 'Kết nối tới Cloudflare R2 để tải nhạc hoặc nghe thử các bài hát mẫu.';
        } else {
          if (emptyTitle) emptyTitle.textContent = 'Không tìm thấy bài hát';
          if (emptyDesc) emptyDesc.textContent = 'Thử xoá từ khoá tìm kiếm hoặc bỏ chọn bớt các tag.';
        }
      }
      return;
    }

    if (emptyState) emptyState.classList.add('hidden');

    container.innerHTML = filtered.map((song, index) => {
      const isCurrentlyPlaying = this.player.isPlaying && this.player.currentSong?.id === song.id;
      const isCurrentSong = this.player.currentSong?.id === song.id;
      const isCached = this.cachedSongIds.has(song.id);
      const isDownloading = this.downloadingSongIds.has(song.id);

      let offlineBtnHtml = '';
      if (isDownloading) {
        offlineBtnHtml = `
          <button class="p-1.5 rounded-md text-purple-400 cursor-wait" title="Đang tải về máy...">
            <i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i>
          </button>
        `;
      } else if (isCached) {
        offlineBtnHtml = `
          <button class="btn-toggle-offline p-1.5 rounded-md text-emerald-400 hover:text-red-400 hover:bg-purple-900/40 transition group" data-song-id="${song.id}" title="Đã lưu offline (Bấm để xoá giải phóng bộ nhớ)">
            <i data-lucide="check" class="w-4 h-4 group-hover:hidden"></i>
            <i data-lucide="trash" class="w-4 h-4 hidden group-hover:block"></i>
          </button>
        `;
      } else {
        offlineBtnHtml = `
          <button class="btn-toggle-offline p-1.5 rounded-md text-purple-400/60 hover:text-purple-200 hover:bg-purple-900/40 transition" data-song-id="${song.id}" title="Tải về máy để nghe Offline">
            <i data-lucide="arrow-down-to-line" class="w-4 h-4"></i>
          </button>
        `;
      }

      const activeBgClass = isCurrentSong 
        ? 'bg-purple-950/80 border-2 border-purple-400 shadow-xl shadow-purple-950/80 ring-1 ring-purple-400/40 relative overflow-hidden before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1.5 before:bg-purple-400' 
        : 'bg-[#130E24] hover:bg-[#1A1333] border border-purple-950/60 shadow-sm';

      const initialPlayState = isCurrentlyPlaying ? 'playing' : (isCurrentSong ? 'paused' : 'idle');
      let playBtnClass = 'bg-[#20183B] text-zinc-400 hover:text-white hover:bg-purple-600';
      let playBtnTitle = 'Phát bài này';
      let playIconHtml = '<i data-lucide="play" class="w-3.5 h-3.5 ml-0.5"></i>';

      if (initialPlayState === 'playing') {
        playBtnClass = 'bg-purple-600 text-white shadow-lg shadow-purple-600/60 ring-2 ring-purple-400';
        playBtnTitle = 'Tạm dừng';
        playIconHtml = '<i data-lucide="pause" class="w-3.5 h-3.5 fill-white"></i>';
      } else if (initialPlayState === 'paused') {
        playBtnClass = 'bg-purple-800 text-white hover:bg-purple-700 ring-1 ring-purple-400';
        playBtnTitle = 'Tiếp tục phát';
        playIconHtml = '<i data-lucide="play" class="w-3.5 h-3.5 fill-white ml-0.5"></i>';
      }

      const titleColorClass = isCurrentSong ? 'text-white font-bold text-sm' : 'text-zinc-100 font-medium text-xs sm:text-sm';
      const badgeHtml = isCurrentSong 
        ? `<span class="active-playing-badge px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase shrink-0 ${isCurrentlyPlaying ? 'bg-purple-500 text-white animate-pulse' : 'bg-purple-800 text-purple-200'}">${isCurrentlyPlaying ? 'Đang phát' : 'Tạm dừng'}</span>`
        : '';

      return `
        <div class="song-row flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl border transition ${activeBgClass}" data-song-id="${song.id}">
          
          <!-- Left: Play/Pause & Song Info -->
          <div class="flex items-center gap-3 min-w-0 flex-1">
            <button class="btn-play-song w-8 h-8 rounded-full ${playBtnClass} flex items-center justify-center flex-shrink-0 transition active:scale-95" data-song-id="${song.id}" data-playing-state="${initialPlayState}" title="${playBtnTitle}">
              ${playIconHtml}
            </button>

            <div class="min-w-0 flex-1">
              <div class="song-title-wrapper flex items-center gap-2 flex-wrap">
                <span class="text-xs font-mono text-zinc-500">${String(index + 1).padStart(2, '0')}</span>
                <h4 class="${titleColorClass} truncate">${escapeHTML(song.title)}</h4>
                ${badgeHtml}
              </div>

              <div class="flex items-center gap-2 mt-0.5 flex-wrap">
                <span class="text-[11px] font-mono text-zinc-400">${formatDuration(song.duration)}</span>
                <span class="text-purple-900">•</span>
                <span class="text-[11px] font-mono text-zinc-400">${formatFileSize(song.size)}</span>
                
                ${(song.tags || []).map(t => `
                  <span class="inline-block px-1.5 py-0.2 rounded text-[10px] bg-purple-950/70 text-purple-300 border border-purple-800/40 font-medium">
                    #${escapeHTML(t)}
                  </span>
                `).join('')}
              </div>
            </div>
          </div>

          <!-- Right: Actions -->
          <div class="flex items-center gap-1 flex-shrink-0">
            ${offlineBtnHtml}

            <button class="btn-edit-song p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-purple-900/40 transition" data-song-id="${song.id}" title="Sửa tên và tags">
              <i data-lucide="edit-2" class="w-3.5 h-3.5"></i>
            </button>

            <button class="btn-delete-song p-1.5 rounded-md text-zinc-400 hover:text-red-400 hover:bg-purple-900/40 transition" data-song-id="${song.id}" title="Xoá bài hát">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
          </div>

        </div>
      `;
    }).join('');

    container.querySelectorAll('.btn-play-song').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const songId = e.currentTarget.getAttribute('data-song-id');
        const song = this.library.songs.find(s => s.id === songId);
        if (song) {
          if (this.player.currentSong?.id === song.id) {
            this.player.togglePlayPause();
          } else {
            this.player.playSong(song);
          }
        }
      });
    });

    container.querySelectorAll('.btn-toggle-offline').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const songId = e.currentTarget.getAttribute('data-song-id');
        const song = this.library.songs.find(s => s.id === songId);
        if (song) this.downloadSongOffline(song);
      });
    });

    container.querySelectorAll('.btn-edit-song').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const songId = e.currentTarget.getAttribute('data-song-id');
        this.openEditSongModal(songId);
      });
    });

    container.querySelectorAll('.btn-delete-song').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const songId = e.currentTarget.getAttribute('data-song-id');
        const song = this.library.songs.find(s => s.id === songId);
        if (song) {
          this.songToDelete = song;
          const modal = document.getElementById('modal-confirm-delete');
          const msg = document.getElementById('confirm-delete-message');
          if (msg) msg.textContent = `Bài hát "${song.title}" sẽ bị xoá khỏi Cloudflare R2 và máy.`;
          if (modal) {
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            if (window.lucide) window.lucide.createIcons({ root: modal });
          }
        }
      });
    });

    if (window.lucide) window.lucide.createIcons({ root: container });
  }

  updatePlayerUI() {
    const song = this.player.currentSong;
    const isPlaying = this.player.isPlaying;

    const trackTitleEl = document.getElementById('player-track-title');
    const trackTagsEl = document.getElementById('player-track-tags');

    if (trackTitleEl) trackTitleEl.textContent = song ? song.title : 'Chưa chọn bài hát';
    if (trackTagsEl) trackTagsEl.textContent = song && song.tags ? song.tags.join(', ') : '';

    const playerSource = document.getElementById('player-source-indicator');
    let sourceLabel = 'CHỜ PHÁT';
    let sourceColorClass = 'bg-[#18132A] text-purple-400 border-purple-800/40';

    if (this.player.activeSource === 'offline') {
      sourceLabel = 'OFFLINE';
      sourceColorClass = 'bg-emerald-950/80 text-emerald-400 border-emerald-800/50';
    } else if (this.player.activeSource === 'r2-stream') {
      sourceLabel = 'R2 STREAM';
      sourceColorClass = 'bg-purple-950/80 text-purple-300 border-purple-700/50';
    } else if (this.player.activeSource === 'demo') {
      sourceLabel = 'DEMO';
      sourceColorClass = 'bg-amber-950/80 text-amber-400 border-amber-800/50';
    }

    if (playerSource) {
      playerSource.textContent = sourceLabel;
      playerSource.className = `px-1.5 py-0.2 rounded text-[9px] font-mono border ${sourceColorClass}`;
    }

    const playPauseBtn = document.getElementById('btn-player-play-pause');
    if (playPauseBtn) {
      const targetState = isPlaying ? 'playing' : 'paused';
      if (playPauseBtn.dataset.playingState !== targetState) {
        playPauseBtn.dataset.playingState = targetState;
        playPauseBtn.setAttribute('title', isPlaying ? 'Tạm dừng' : 'Phát');
        playPauseBtn.setAttribute('aria-label', isPlaying ? 'Tạm dừng' : 'Phát');
        if (isPlaying) {
          playPauseBtn.innerHTML = '<i data-lucide="pause" class="w-4 h-4 sm:w-5 sm:h-5 fill-white"></i>';
        } else {
          playPauseBtn.innerHTML = '<i data-lucide="play" class="w-4 h-4 sm:w-5 sm:h-5 fill-white ml-0.5"></i>';
        }
        if (window.lucide) {
          window.lucide.createIcons({ root: playPauseBtn });
        }
      }
    }

    const curTimeEl = document.getElementById('player-current-time');
    const totalDurEl = document.getElementById('player-total-duration');
    const seekSlider = document.getElementById('player-seek-slider');

    if (curTimeEl) curTimeEl.textContent = formatDuration(this.player.currentTime);
    if (totalDurEl) totalDurEl.textContent = formatDuration(this.player.duration);

    if (seekSlider && this.player.duration > 0) {
      seekSlider.value = ((this.player.currentTime / this.player.duration) * 100).toFixed(1);
    }

    const shuffleBtn = document.getElementById('btn-player-shuffle');
    const loopBtn = document.getElementById('btn-player-loop');
    const loopBadge = document.getElementById('player-loop-badge');

    // 1. Shuffle button state (independent toggle)
    if (shuffleBtn) {
      if (this.player.isShuffle) {
        shuffleBtn.className = 'p-1.5 rounded-md text-purple-200 bg-purple-900/60 border border-purple-600/60 shadow-sm transition';
        shuffleBtn.title = 'Tắt phát ngẫu nhiên (Đang bật)';
        shuffleBtn.setAttribute('aria-pressed', 'true');
      } else {
        shuffleBtn.className = 'p-1.5 rounded-md text-purple-400/60 hover:text-purple-200 hover:bg-purple-900/30 transition';
        shuffleBtn.title = 'Bật phát ngẫu nhiên (Đang tắt)';
        shuffleBtn.setAttribute('aria-pressed', 'false');
      }
    }

    // 2. Loop button state (3 distinct modes: all, one, none)
    if (loopBtn) {
      if (this.player.loopMode === 'one') {
        loopBtn.className = 'p-1.5 rounded-md text-purple-200 bg-purple-900/60 border border-purple-600/60 transition relative shadow-sm';
        loopBtn.title = 'Chế độ lặp: Lặp 1 bài (Bấm để tắt lặp)';
        loopBtn.setAttribute('aria-label', 'Lặp 1 bài');
        if (loopBadge) {
          loopBadge.textContent = '1';
          loopBadge.className = 'absolute -top-1 -right-1 text-[9px] font-mono font-bold text-white bg-purple-600 px-1 rounded-full leading-none';
        }
      } else if (this.player.loopMode === 'none') {
        loopBtn.className = 'p-1.5 rounded-md text-purple-400/60 hover:text-purple-200 hover:bg-purple-900/30 transition relative';
        loopBtn.title = 'Chế độ lặp: Không lặp lại (Dừng khi phát xong. Bấm để lặp danh sách)';
        loopBtn.setAttribute('aria-label', 'Không lặp lại');
        if (loopBadge) {
          loopBadge.textContent = '—';
          loopBadge.className = 'absolute -top-1 -right-1 text-[9px] font-mono font-semibold text-purple-400/40';
        }
      } else {
        // loopMode === 'all'
        loopBtn.className = 'p-1.5 rounded-md text-purple-300 hover:text-white bg-purple-950/60 hover:bg-purple-900/60 border border-purple-800/40 transition relative';
        loopBtn.title = 'Chế độ lặp: Toàn bộ danh sách (Bấm để lặp 1 bài)';
        loopBtn.setAttribute('aria-label', 'Lặp toàn bộ danh sách');
        if (loopBadge) {
          loopBadge.textContent = 'A';
          loopBadge.className = 'absolute -top-1 -right-1 text-[9px] font-mono font-bold text-purple-300';
        }
      }
    }
  }

  updateSongListPlayStates() {
    const currentSongId = this.player.currentSong?.id || null;
    const isPlaying = this.player.isPlaying;

    const rows = document.querySelectorAll('#songs-list-container .song-row');
    rows.forEach(row => {
      const songId = row.getAttribute('data-song-id');
      const isCurrent = (songId === currentSongId);
      const isRowPlaying = isCurrent && isPlaying;
      const targetState = isRowPlaying ? 'playing' : (isCurrent ? 'paused' : 'idle');

      // Update row active border/background styling
      const activeClasses = ['bg-purple-950/80', 'border-2', 'border-purple-400', 'shadow-xl', 'shadow-purple-950/80', 'ring-1', 'ring-purple-400/40', 'relative', 'overflow-hidden', 'before:absolute', 'before:left-0', 'before:top-0', 'before:bottom-0', 'before:w-1.5', 'before:bg-purple-400'];
      const inactiveClasses = ['bg-[#130E24]', 'hover:bg-[#1A1333]', 'border', 'border-purple-950/60', 'shadow-sm'];

      if (isCurrent) {
        row.classList.remove('bg-[#130E24]', 'hover:bg-[#1A1333]', 'border', 'border-purple-950/60', 'shadow-sm', 'bg-[#140F27]/80', 'border-purple-900/30', 'bg-[#241747]/90', 'border-purple-500/60');
        row.classList.add(...activeClasses);
      } else {
        row.classList.remove(...activeClasses);
        row.classList.remove('bg-[#241747]/90', 'border-purple-500/60', 'shadow-lg', 'shadow-purple-950/60');
        row.classList.add(...inactiveClasses);
      }

      // Update active badge
      let badge = row.querySelector('.active-playing-badge');
      if (isCurrent) {
        if (!badge) {
          badge = document.createElement('span');
          const titleContainer = row.querySelector('.song-title-wrapper') || row.querySelector('.min-w-0.flex-1 > div');
          if (titleContainer) titleContainer.appendChild(badge);
        }
        if (isRowPlaying) {
          badge.className = 'active-playing-badge px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-500 text-white tracking-wider uppercase animate-pulse shrink-0';
          badge.textContent = 'Đang phát';
        } else {
          badge.className = 'active-playing-badge px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-800 text-purple-200 tracking-wider uppercase shrink-0';
          badge.textContent = 'Tạm dừng';
        }
      } else if (badge) {
        badge.remove();
      }

      // Update song title highlight
      const titleEl = row.querySelector('h4');
      if (titleEl) {
        titleEl.className = isCurrent 
          ? 'text-xs sm:text-sm font-bold truncate text-white' 
          : 'text-xs sm:text-sm font-medium truncate text-zinc-100';
      }

      // Update play button state and icon
      const btn = row.querySelector('.btn-play-song');
      if (btn && btn.dataset.playingState !== targetState) {
        btn.dataset.playingState = targetState;
        if (targetState === 'playing') {
          btn.className = 'btn-play-song w-8 h-8 rounded-full bg-purple-600 text-white flex items-center justify-center flex-shrink-0 transition active:scale-95 shadow-lg shadow-purple-600/60 ring-2 ring-purple-400';
          btn.setAttribute('title', 'Tạm dừng');
          btn.innerHTML = '<i data-lucide="pause" class="w-3.5 h-3.5 fill-white"></i>';
        } else if (targetState === 'paused') {
          btn.className = 'btn-play-song w-8 h-8 rounded-full bg-purple-800 text-white hover:bg-purple-700 ring-1 ring-purple-400 flex items-center justify-center flex-shrink-0 transition active:scale-95';
          btn.setAttribute('title', 'Tiếp tục phát');
          btn.innerHTML = '<i data-lucide="play" class="w-3.5 h-3.5 fill-white ml-0.5"></i>';
        } else {
          btn.className = 'btn-play-song w-8 h-8 rounded-full bg-[#20183B] text-zinc-400 hover:text-white hover:bg-purple-600 flex items-center justify-center flex-shrink-0 transition active:scale-95';
          btn.setAttribute('title', 'Phát bài này');
          btn.innerHTML = '<i data-lucide="play" class="w-3.5 h-3.5 ml-0.5"></i>';
        }
        if (window.lucide) {
          window.lucide.createIcons({ root: btn });
        }
      }
    });
  }

  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'pointer-events-auto flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl border shadow-2xl backdrop-blur-xl transition-all duration-300 transform translate-x-full text-xs font-normal';

    let iconName = 'info';
    let styleClass = 'bg-[#18132A]/95 border-purple-700/50 text-white';

    if (type === 'success') {
      iconName = 'check';
      styleClass = 'bg-[#121B2A]/95 border-emerald-500/50 text-emerald-200';
    } else if (type === 'warning') {
      iconName = 'alert-triangle';
      styleClass = 'bg-[#241712]/95 border-amber-500/50 text-amber-200';
    } else if (type === 'error') {
      iconName = 'alert-circle';
      styleClass = 'bg-[#281119]/95 border-red-500/50 text-red-200';
    }

    toast.className += ` ${styleClass}`;
    toast.innerHTML = `
      <i data-lucide="${iconName}" class="w-4 h-4 flex-shrink-0"></i>
      <span class="flex-1 leading-snug">${escapeHTML(message)}</span>
      <button class="toast-close text-purple-400/60 hover:text-white p-0.5">
        <i data-lucide="x" class="w-3.5 h-3.5"></i>
      </button>
    `;

    container.appendChild(toast);
    if (window.lucide) window.lucide.createIcons({ root: toast });

    container.appendChild(toast);
    if (window.lucide) window.lucide.createIcons({ root: toast });

    setTimeout(() => {
      toast.classList.remove('translate-x-full');
    }, 10);

    const removeToast = () => {
      toast.classList.add('translate-x-full', 'opacity-0');
      setTimeout(() => toast.remove(), 300);
    };

    toast.querySelector('.toast-close')?.addEventListener('click', removeToast);
    setTimeout(removeToast, 4000);
  }
}

function bootSymphony() {
  if (window.lucide) window.lucide.createIcons();
  const app = new SymphonyApp();
  window.symphonyApp = app;
  app.init().catch(console.error);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootSymphony);
} else {
  bootSymphony();
}
