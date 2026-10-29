import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterSongs,
  extractAllTags,
  exportConfigToBase64,
  importConfigFromBase64,
  formatDuration,
  formatFileSize,
  resolveNextPlaybackTrack,
  extractYouTubeVideoId,
  Song,
  R2Config,
} from './logic';

const sampleSongs: Song[] = [
  {
    id: 's-1',
    title: 'Nàng Thơ',
    fileName: 'tracks/s-1.mp3',
    size: 4500000,
    duration: 215,
    tags: ['chill', 'vpop', 'acoustic'],
    createdAt: 1700000000000,
  },
  {
    id: 's-2',
    title: 'Lofi Midnight Coffee',
    fileName: 'tracks/s-2.mp3',
    size: 5200000,
    duration: 180,
    tags: ['chill', 'lofi', 'instrumental'],
    createdAt: 1700000001000,
  },
  {
    id: 's-3',
    title: 'Rock Anthem Energetic',
    fileName: 'tracks/s-3.mp3',
    size: 6100000,
    duration: 240,
    tags: ['rock', 'energetic'],
    createdAt: 1700000002000,
  },
];

test('filterSongs filters by text search in title, filename, tags', () => {
  const result1 = filterSongs(sampleSongs, { search: 'Nàng Thơ' });
  assert.equal(result1.length, 1);
  assert.equal(result1[0].id, 's-1');

  const result2 = filterSongs(sampleSongs, { search: 'lofi' });
  assert.equal(result2.length, 1);
  assert.equal(result2[0].id, 's-2');

  const result3 = filterSongs(sampleSongs, { search: 'nonexistent' });
  assert.equal(result3.length, 0);
});

test('filterSongs handles Vietnamese diacritics and underscores like Khi_mùa_thu_đến', () => {
  const vnSongs: Song[] = [
    {
      id: 'vn-1',
      title: 'Khi_mùa_thu_đến',
      fileName: 'tracks/khi_mua_thu_den.mp3',
      size: 4000000,
      duration: 210,
      tags: ['nhạc trẻ', 'ballad'],
      createdAt: 1700000000000,
    },
    {
      id: 'vn-2',
      title: 'Đường Vào Tim Em',
      fileName: 'tracks/duong_vao_tim_em.mp3',
      size: 4200000,
      duration: 195,
      tags: ['tình cảm', 'vpop'],
      createdAt: 1700000001000,
    },
  ];

  // Searching 'mùa' (with accent) matches 'Khi_mùa_thu_đến'
  const matchMuaWithAccent = filterSongs(vnSongs, { search: 'mùa' });
  assert.equal(matchMuaWithAccent.length, 1);
  assert.equal(matchMuaWithAccent[0].id, 'vn-1');

  // Searching 'mua' (without accent) matches 'Khi_mùa_thu_đến'
  const matchMuaNoAccent = filterSongs(vnSongs, { search: 'mua' });
  assert.equal(matchMuaNoAccent.length, 1);
  assert.equal(matchMuaNoAccent[0].id, 'vn-1');

  // Searching 'MUA' (uppercase) matches
  const matchMuaUpper = filterSongs(vnSongs, { search: 'MUA' });
  assert.equal(matchMuaUpper.length, 1);
  assert.equal(matchMuaUpper[0].id, 'vn-1');

  // Searching phrase 'mùa thu' (with space instead of underscore) matches
  const matchPhrase = filterSongs(vnSongs, { search: 'mùa thu' });
  assert.equal(matchPhrase.length, 1);
  assert.equal(matchPhrase[0].id, 'vn-1');

  // Searching phrase 'mua thu den' without accents matches
  const matchFullUnaccented = filterSongs(vnSongs, { search: 'mua thu den' });
  assert.equal(matchFullUnaccented.length, 1);
  assert.equal(matchFullUnaccented[0].id, 'vn-1');

  // Searching 'duong' matches 'Đường Vào Tim Em' (handling đ -> d)
  const matchDuong = filterSongs(vnSongs, { search: 'duong' });
  assert.equal(matchDuong.length, 1);
  assert.equal(matchDuong[0].id, 'vn-2');

  // Searching tag 'nhac tre' without accent matches
  const matchTagUnaccented = filterSongs(vnSongs, { search: 'nhac tre' });
  assert.equal(matchTagUnaccented.length, 1);
  assert.equal(matchTagUnaccented[0].id, 'vn-1');
});

test('filterSongs filters with OR tag mode', () => {
  const result = filterSongs(sampleSongs, {
    selectedTags: ['acoustic', 'rock'],
    tagMode: 'OR',
  });
  assert.equal(result.length, 2);
  assert.ok(result.some((s) => s.id === 's-1'));
  assert.ok(result.some((s) => s.id === 's-3'));
});

test('filterSongs filters with AND tag mode', () => {
  const resultMatch = filterSongs(sampleSongs, {
    selectedTags: ['chill', 'lofi'],
    tagMode: 'AND',
  });
  assert.equal(resultMatch.length, 1);
  assert.equal(resultMatch[0].id, 's-2');

  const resultNoMatch = filterSongs(sampleSongs, {
    selectedTags: ['chill', 'rock'],
    tagMode: 'AND',
  });
  assert.equal(resultNoMatch.length, 0);
});

test('filterSongs filters offline only', () => {
  const cachedIds = new Set(['s-1', 's-3']);
  const result = filterSongs(sampleSongs, {
    offlineOnly: true,
    cachedSongIds: cachedIds,
  });
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 's-1');
  assert.equal(result[1].id, 's-3');
});

test('extractAllTags returns sorted frequency list', () => {
  const tags = extractAllTags(sampleSongs);
  assert.ok(tags.length >= 4);
  assert.equal(tags[0].tag, 'chill');
  assert.equal(tags[0].count, 2);
});

test('exportConfigToBase64 and importConfigFromBase64 roundtrip successfully', () => {
  const config: R2Config = {
    endpoint: 'https://myaccount.r2.cloudflarestorage.com',
    bucket: 'music-bucket',
    accessKeyId: 'AKIAEXAMPLE12345678',
    secretAccessKey: 'SECRETKEY987654321',
    publicDomain: 'https://music.example.com',
  };

  const b64 = exportConfigToBase64(config);
  assert.ok(typeof b64 === 'string' && b64.length > 20);

  const parsed = importConfigFromBase64(b64);
  assert.equal(parsed.endpoint, config.endpoint);
  assert.equal(parsed.bucket, config.bucket);
  assert.equal(parsed.accessKeyId, config.accessKeyId);
  assert.equal(parsed.secretAccessKey, config.secretAccessKey);
  assert.equal(parsed.publicDomain, config.publicDomain);

  // Roundtrip with RapidAPI fields
  const fullConfig: R2Config = {
    ...config,
    rapidApiKey: 'TEST_RAPID_KEY_999',
    rapidApiHost: 'youtube-mp36.p.rapidapi.com',
  };
  const fullB64 = exportConfigToBase64(fullConfig);
  const parsedFull = importConfigFromBase64(fullB64);
  assert.equal(parsedFull.rapidApiKey, 'TEST_RAPID_KEY_999');
  assert.equal(parsedFull.rapidApiHost, 'youtube-mp36.p.rapidapi.com');
});

test('extractYouTubeVideoId extracts video ID from various link formats', () => {
  // Direct ID
  assert.equal(extractYouTubeVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');

  // Standard watch URL
  assert.equal(
    extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    'dQw4w9WgXcQ'
  );

  // With extra parameters
  assert.equal(
    extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share&t=10s'),
    'dQw4w9WgXcQ'
  );

  // youtu.be short URL
  assert.equal(extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');

  // youtu.be with timestamp
  assert.equal(extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ?t=45'), 'dQw4w9WgXcQ');

  // Embed URL
  assert.equal(extractYouTubeVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');

  // Shorts URL
  assert.equal(extractYouTubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');

  // Mobile URL
  assert.equal(extractYouTubeVideoId('https://m.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');

  // Invalid strings
  assert.equal(extractYouTubeVideoId(''), null);
  assert.equal(extractYouTubeVideoId('not a valid url or id'), null);
});

test('importConfigFromBase64 rejects invalid config', () => {
  assert.throws(() => importConfigFromBase64(''), /không được để trống/);
  assert.throws(() => importConfigFromBase64('invalid!base64?#'), /không hợp lệ/);
  assert.throws(() => importConfigFromBase64(Buffer.from('{}').toString('base64')), /Thiếu các trường/);
});

test('formatDuration and formatFileSize formatting', () => {
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(65), '01:05');
  assert.equal(formatDuration(215), '03:35');

  assert.equal(formatFileSize(0), '0 B');
  assert.ok(formatFileSize(5242880).includes('5.0 MB'));
});

test('resolveNextPlaybackTrack behaves correctly with 3 loop modes (all, one, none) and independent shuffle', () => {
  // 1. Loop ALL: linear progression & wrap around
  const next1 = resolveNextPlaybackTrack('s-1', sampleSongs, { direction: 'next', loopMode: 'all' });
  assert.equal(next1?.id, 's-2');

  const wrapNext = resolveNextPlaybackTrack('s-3', sampleSongs, { direction: 'next', loopMode: 'all' });
  assert.equal(wrapNext?.id, 's-1');

  // Prev with Loop ALL
  const prev1 = resolveNextPlaybackTrack('s-2', sampleSongs, { direction: 'prev', loopMode: 'all' });
  assert.equal(prev1?.id, 's-1');

  // 2. Loop ONE: repeats current song
  const loopOne = resolveNextPlaybackTrack('s-2', sampleSongs, { direction: 'next', loopMode: 'one' });
  assert.equal(loopOne?.id, 's-2');

  // 3. Loop NONE: stops (returns null) at the end of playlist
  const loopNoneMiddle = resolveNextPlaybackTrack('s-1', sampleSongs, { direction: 'next', loopMode: 'none' });
  assert.equal(loopNoneMiddle?.id, 's-2');

  const loopNoneEnd = resolveNextPlaybackTrack('s-3', sampleSongs, { direction: 'next', loopMode: 'none' });
  assert.equal(loopNoneEnd, null);

  // 4. Shuffle: independent from loop mode
  const shuffleNext = resolveNextPlaybackTrack('s-1', sampleSongs, { isShuffle: true, loopMode: 'all' });
  assert.ok(shuffleNext !== null);
  assert.notEqual(shuffleNext?.id, 's-1');

  // Shuffle with Loop NONE stops when all songs have been played
  const playedAll = new Set(['s-1', 's-2', 's-3']);
  const shuffleStop = resolveNextPlaybackTrack('s-3', sampleSongs, {
    isShuffle: true,
    loopMode: 'none',
    playedSongIds: playedAll,
  });
  assert.equal(shuffleStop, null);

  // 5. Offline constraint
  const offlineNext = resolveNextPlaybackTrack('s-1', sampleSongs, {
    direction: 'next',
    loopMode: 'all',
    isOffline: true,
    cachedSongIds: new Set(['s-1', 's-3']),
  });
  assert.equal(offlineNext?.id, 's-3');
});
