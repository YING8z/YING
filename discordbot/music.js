const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus
} = require('@discordjs/voice');

const { EmbedBuilder } = require('discord.js');
const { spawn } = require('child_process');

const _fetch = typeof fetch !== 'undefined' ? fetch : require('node-fetch');
const { getData, getTracks } = require('spotify-url-info')(_fetch);

const queues = new Map();

// ============================================================
// STEP 1 — RESOLVE SPOTIFY METADATA
// ============================================================
async function resolveSpotifyTrack(url) {
  const data = await getData(url);
  if (!data?.name) throw new Error('Không lấy được metadata từ Spotify');

  return {
    title: data.name,
    artist: (data.artists || []).map(a => a.name).join(', '),
    album: data.album?.name || '',
    duration: Math.round((data.duration_ms || 0) / 1000), // giây
    isrc: data.external_ids?.isrc || null,
    url: data.external_urls?.spotify || url
  };
}

async function resolveSpotifyPlaylist(url) {
  // getData cho full object có duration_ms; getTracks nhanh hơn nhưng thiếu field
  let tracks = [];

  try {
    const data = await getData(url);
    const raw = extractTracks(data);
    if (raw.length) {
      tracks = raw.filter(t => t?.name).map(t => ({
        title: t.name,
        artist: (t.artists || []).map(a => a.name).join(', '),
        album: t.album?.name || '',
        duration: Math.round((t.duration_ms || 0) / 1000),
        isrc: t.external_ids?.isrc || null
      }));
    }
  } catch { }

  // Fallback getTracks nếu getData không lấy được
  if (!tracks.length && typeof getTracks === 'function') {
    try {
      const raw = await getTracks(url);
      tracks = (raw || []).filter(t => t?.name).map(t => ({
        title: t.name,
        artist: (t.artists || []).map(a => a.name).join(', '),
        album: t.album?.name || '',
        duration: Math.round((t.duration_ms || 0) / 1000),
        isrc: t.external_ids?.isrc || null
      }));
    } catch { }
  }

  return tracks;
}

async function resolveSpotifyAlbum(url) {
  const data = await getData(url);
  const tracks = extractTracks(data);
  return tracks.filter(t => t?.name).map(t => ({
    title: t.name,
    artist: (t.artists || []).map(a => a.name).join(', '),
    album: data.name || '',
    duration: Math.round((t.duration_ms || 0) / 1000),
    isrc: t.external_ids?.isrc || null
  }));
}

function extractTracks(data) {
  if (Array.isArray(data?.tracks?.items)) return data.tracks.items.map(i => i?.track || i).filter(Boolean);
  if (Array.isArray(data?.tracks)) return data.tracks.filter(Boolean);
  if (Array.isArray(data?.items)) return data.items.map(i => i?.track || i).filter(Boolean);
  return [];
}

// ============================================================
// STEP 2 — NORMALIZE METADATA
// ============================================================
const NOISE_WORDS = [
  /\bofficial\b/gi, /\bvideo\b/gi, /\baudio\b/gi,
  /\bmv\b/gi, /\blyric(s)?\b/gi, /\b4k\b/gi,
  /\bhd\b/gi, /\bfull\b/gi, /\boriginal\b/gi,
  /\bvisualizer\b/gi
];

function normalizeTitle(raw) {
  if (!raw) return '';
  let s = raw
    .replace(/\(feat\.?[^)]*\)/gi, '')
    .replace(/\[feat\.?[^\]]*\]/gi, '')
    .replace(/feat\..*/gi, '');

  for (const re of NOISE_WORDS) s = s.replace(re, '');
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

// ============================================================
// STEP 3 — GENERATE SEARCH QUERIES
// ============================================================
function generateQueries(meta) {
  const t = normalizeTitle(meta.title);
  const a = meta.artist.toLowerCase();
  const queries = [
    `${t} ${a}`,
    `${t} ${a} official audio`,
    `${a} ${t}`,
    `${t} ${a} topic`
  ];
  if (meta.isrc) queries.unshift(`"${meta.isrc}"`); // ISRC first
  return queries;
}

// ============================================================
// STEP 4+5 — MULTI-SOURCE SEARCH & SCORING
// ============================================================
const BAD_KEYWORDS = [
  'live', 'cover', 'nightcore', 'sped up', 'slowed',
  '8d', 'bass boost', 'reverb', 'karaoke', 'fanmade',
  'fan made', 'instrumental', 'tribute', 'reaction', 'piano version'
];

const GOOD_KEYWORDS = ['official audio', 'official music', 'topic', 'auto-generated', 'vevo'];

function scoreResult(video, meta) {
  let score = 0;

  const vTitle = (video.title || '').toLowerCase();
  const vUpload = (video.uploader || video.channel || '').toLowerCase();
  const normMeta = normalizeTitle(meta.title);
  const metaArtist = meta.artist.toLowerCase();

  // ── Title similarity ──
  const titleSim = jaccardSimilarity(normMeta, vTitle);
  if (titleSim > 0.85) score += 40;
  else if (titleSim > 0.65) score += 25;
  else if (titleSim > 0.45) score += 10;

  // ── Artist match ──
  const artistSim = jaccardSimilarity(metaArtist, vUpload);
  if (artistSim > 0.8) score += 30;
  else if (artistSim > 0.5) score += 15;
  else if (vTitle.includes(metaArtist.split(' ')[0])) score += 8;

  // ── Duration validation ──
  const diff = Math.abs((video.duration || 0) - (meta.duration || 0));
  if (diff <= 2) score += 20;
  else if (diff <= 7) score += 10;
  else if (diff > 60) score -= 50; // cực kỳ sai → loại thực tế

  // ── Good keywords → boost ──
  for (const kw of GOOD_KEYWORDS) {
    if (vTitle.includes(kw) || vUpload.includes(kw)) { score += 15; break; }
  }

  // ── Verified / VEVO / Topic ──
  if (vUpload.includes('vevo')) score += 10;
  if (vUpload.includes('- topic')) score += 10;
  if (video.channel_is_verified) score += 5;

  // ── Bad keywords → penalize ──
  for (const kw of BAD_KEYWORDS) {
    if (vTitle.includes(kw)) {
      score -= (kw === 'karaoke' || kw === 'nightcore') ? 100 : 40;
    }
  }

  return score;
}

// Jaccard token similarity (thay thế Levenshtein đơn giản, không cần lib)
function jaccardSimilarity(a, b) {
  if (!a || !b) return 0;
  const setA = new Set(a.split(/\s+/));
  const setB = new Set(b.split(/\s+/));
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

// ============================================================
// STEP 6 — SEARCH + PICK BEST MATCH
// ============================================================
async function findBestMatch(meta) {
  const queries = generateQueries(meta);
  let allVideos = [];

  // Search lần lượt từng query, dừng khi có đủ kết quả tốt
  for (const q of queries) {
    const videos = await ytdlpSearch(q, 3);
    allVideos.push(...videos);

    // Nếu đã có candidate score cao → dừng sớm
    const scored = allVideos.map(v => ({ v, s: scoreResult(v, meta) }));
    const best = scored.sort((a, b) => b.s - a.s)[0];
    if (best && best.s >= 60) break;
  }

  if (allVideos.length === 0) return null;

  // Dedup theo webpage_url
  const seen = new Set();
  allVideos = allVideos.filter(v => {
    if (seen.has(v.webpage_url)) return false;
    seen.add(v.webpage_url);
    return true;
  });

  // Score tất cả, chọn winner
  const ranked = allVideos
    .map(v => ({ v, s: scoreResult(v, meta) }))
    .sort((a, b) => b.s - a.s);

  const winner = ranked[0];
  if (!winner || winner.s < 0) return allVideos[0];

  return winner.v;
}

// yt-dlp search helper → trả về array video object
function ytdlpSearch(query, limit = 3) {
  return new Promise((resolve) => {
    const isUrl = /^https?:\/\//.test(query);
    const arg = isUrl ? query : `ytsearch${limit}:${query}`;

    const proc = spawn('yt-dlp', ['--dump-json', '--no-playlist', arg]);

    let json = '', err = '';
    proc.stdout.on('data', d => json += d.toString());
    proc.stderr.on('data', d => err += d.toString());

    proc.on('close', () => {
      const videos = [];
      for (const line of json.trim().split('\n')) {
        try { videos.push(JSON.parse(line)); } catch { }
      }
      resolve(videos);
    });

    proc.on('error', (e) => {
      console.error('[yt-dlp spawn error]', e.message);
      resolve([]);
    });
  });
}

// ============================================================
// STEP 7 — STREAM AUDIO VIA YT-DLP
// ============================================================
function spawnStream(videoUrl) {
  return spawn('yt-dlp', [
    '--no-playlist',
    '-f', 'bestaudio[ext=webm]/bestaudio/best',
    '-o', '-',
    '--quiet',
    videoUrl
  ]);
}

// ============================================================
// MODULE EXPORT
// ============================================================
module.exports = (client) => {

  // ─────────────────────────────────────────
  // AUTO-LEAVE: kênh voice trống → dừng sau 1 phút
  // ─────────────────────────────────────────
  client.on('voiceStateUpdate', (oldState, newState) => {
    for (const [gid, queue] of queues) {
      if (!queue.conn) continue;

      // Lấy channel mà bot đang ở
      const botVcId = queue.conn.joinConfig?.channelId;
      if (!botVcId) continue;

      // Chỉ xử lý khi có thay đổi liên quan đến kênh của bot
      const affected = oldState.channelId === botVcId || newState.channelId === botVcId;
      if (!affected) continue;

      const guild = client.guilds.cache.get(gid);
      if (!guild) continue;

      const botChannel = guild.channels.cache.get(botVcId);
      if (!botChannel) continue;

      // Đếm số human members trong kênh (không tính bot)
      const humanCount = botChannel.members.filter(m => !m.user.bot).size;

      if (humanCount === 0) {
        // Bắt đầu đếm 1 phút nếu chưa có timer
        if (!queue.emptyTimeout) {
          queue.emptyTimeout = setTimeout(() => {
            const q = queues.get(gid);
            if (!q) return;

            // Kiểm tra lại lần nữa trước khi out
            const ch = guild.channels.cache.get(botVcId);
            const still = ch?.members.filter(m => !m.user.bot).size ?? 0;
            if (still > 0) { q.emptyTimeout = null; return; }

            // Dừng nhạc và rời kênh
            q.list = [];
            q.player.stop();
            if (q.conn) { q.conn.destroy(); q.conn = null; }
            queues.delete(gid);

            if (q.textChannel) {
              const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setDescription('👋 Kênh voice trống, bot đã tự rời sau 1 phút.');
              q.textChannel.send({ embeds: [embed] }).catch(() => { });
            }
          }, 60_000); // 1 phút
        }
      } else {
        // Có người quay lại → huỷ timer
        if (queue.emptyTimeout) {
          clearTimeout(queue.emptyTimeout);
          queue.emptyTimeout = null;
        }
      }
    }
  });

  client.on('interactionCreate', async i => {
    if (!i.isChatInputCommand()) return;

    const gid = i.guild.id;

    // ─────────────────────────────────────────
    // /play
    // ─────────────────────────────────────────
    if (i.commandName === 'play') {

      const vc = i.member.voice.channel;
      if (!vc) return i.reply({ content: '❌ Vào voice trước', ephemeral: true });

      const query = i.options.getString('query');
      await i.deferReply();

      try {
        if (!queues.has(gid)) {
          queues.set(gid, {
            list: [],
            playing: false,
            conn: null,
            player: createAudioPlayer(),
            textChannel: i.channel,
            emptyTimeout: null   // timer auto-leave khi kênh trống
          });
        }

        const queue = queues.get(gid);
        queue.textChannel = i.channel;

        // ── Spotify Playlist ──
        if (query.includes('spotify.com/playlist')) {
          // getData để lấy metadata playlist (name, owner, image)
          // getTracks để lấy danh sách track với duration đúng
          const [playlistData, rawTracks] = await Promise.all([
            getData(query).catch(() => null),
            (typeof getTracks === 'function' ? getTracks(query) : Promise.resolve([])).catch(() => [])
          ]);

          if (!rawTracks?.length) return i.editReply('❌ Playlist trống hoặc private');

          // getTracks trả: { name, artist, duration (ms), uri, previewUrl }
          const tracks = rawTracks.filter(t => t?.name).map(t => ({
            title: t.name,
            artist: t.artist || '',
            album: '',
            duration: Math.round((t.duration || 0) / 1000), // duration là ms
            isrc: null
          }));

          if (!tracks.length) return i.editReply('❌ Playlist trống hoặc private');

          for (const t of tracks) queue.list.push({ type: 'spotify', meta: t });

          const totalSec = tracks.reduce((s, t) => s + (t.duration || 0), 0);
          const embed = buildPlaylistEmbed({
            type: 'playlist',
            name: playlistData?.name || 'Spotify Playlist',
            owner: playlistData?.owner_name || playlistData?.subtitle || playlistData?.owner?.display_name || 'Spotify',
            trackCount: tracks.length,
            totalSec,
            image: playlistData?.coverArt?.sources?.[0]?.url
              || playlistData?.images?.[0]?.url
              || null,
            url: query
          });

          await i.editReply({ embeds: [embed] });
          if (!queue.playing) playNext(i.guild, vc, gid);
          return;
        }

        // ── Spotify Album ──
        if (query.includes('spotify.com/album')) {
          const albumData = await getData(query).catch(() => null);
          const tracks = albumData ? extractTracks(albumData).filter(t => t?.name).map(t => ({
            title: t.name,
            artist: (t.artists || []).map(a => a.name).join(', '),
            album: albumData.name || '',
            duration: Math.round((t.duration_ms || 0) / 1000),
            isrc: t.external_ids?.isrc || null
          })) : [];

          if (!tracks.length) return i.editReply('❌ Album không có track nào');

          for (const t of tracks) queue.list.push({ type: 'spotify', meta: t });

          const totalSec = tracks.reduce((s, t) => s + (t.duration || 0), 0);
          const embed = buildPlaylistEmbed({
            type: 'album',
            name: albumData?.name || 'Spotify Album',
            owner: (albumData?.artists || []).map(a => a.name).join(', ') || 'Spotify',
            trackCount: tracks.length,
            totalSec,
            image: albumData?.images?.[0]?.url || null,
            url: query
          });

          await i.editReply({ embeds: [embed] });
          if (!queue.playing) playNext(i.guild, vc, gid);
          return;
        }

        // ── Spotify Track ──
        if (query.includes('spotify.com/track')) {
          const meta = await resolveSpotifyTrack(query);
          queue.list.push({ type: 'spotify', meta });
          await i.editReply(`🎶 Đã thêm vào queue: **${meta.title}** — ${meta.artist}`);
          if (!queue.playing) playNext(i.guild, vc, gid);
          return;
        }

        // ── YouTube / text search ──
        queue.list.push({ type: 'raw', query });
        await i.editReply(`➕ Đã thêm vào queue: **${query}**`);
        if (!queue.playing) playNext(i.guild, vc, gid);

      } catch (err) {
        return i.editReply(`❌ Lỗi: ${err.message}`);
      }
    }

    // ─────────────────────────────────────────
    // /skip
    // ─────────────────────────────────────────
    if (i.commandName === 'skip') {
      const q = queues.get(gid);
      if (!q?.playing) return i.reply('❌ Không có nhạc đang phát');
      q.player.stop();
      return i.reply('⏭ Đã skip');
    }

    // ─────────────────────────────────────────
    // /pause
    // ─────────────────────────────────────────
    if (i.commandName === 'pause') {
      const q = queues.get(gid);
      if (!q) return i.reply('❌ Không có nhạc');
      q.player.pause();
      return i.reply('⏸ Đã pause');
    }

    // ─────────────────────────────────────────
    // /resume
    // ─────────────────────────────────────────
    if (i.commandName === 'resume') {
      const q = queues.get(gid);
      if (!q) return i.reply('❌ Không có nhạc');
      q.player.unpause();
      return i.reply('▶️ Đã resume');
    }

    // ─────────────────────────────────────────
    // /stop
    // ─────────────────────────────────────────
    if (i.commandName === 'stop') {
      const q = queues.get(gid);
      if (!q) return i.reply('❌ Không có nhạc');

      q.list = [];
      q.player.stop();
      if (q.conn) { q.conn.destroy(); q.conn = null; }
      queues.delete(gid);
      return i.reply('⏹ Đã stop và rời voice');
    }
  });
};

// ============================================================
// PLAY NEXT — FULL FLOW
// ============================================================
async function playNext(guild, vc, gid) {
  const queue = queues.get(gid);

  if (!queue || queue.list.length === 0) {
    if (queue) {
      queue.playing = false;
      if (queue.textChannel) {
        const embed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setDescription('✅ Hết nhạc trong queue. Cảm ơn đã nghe nhạc!');
        queue.textChannel.send({ embeds: [embed] }).catch(() => { });
      }
      if (queue.conn) { queue.conn.destroy(); queue.conn = null; }
    }
    return;
  }

  queue.playing = true;
  const item = queue.list.shift();

  let video = null;

  try {
    if (item.type === 'spotify') {
      video = await findBestMatch(item.meta);
      if (!video) return playNext(guild, vc, gid);
    } else {
      // ── Raw YouTube / text search ──
      const results = await ytdlpSearch(item.query, 3);
      if (!results.length) return playNext(guild, vc, gid);

      // Simple filter cho raw query: ưu tiên official, loại quá dài
      video = results.find(v =>
        v.duration < 600 &&
        (v.title.toLowerCase().includes('official') || v.title.toLowerCase().includes('audio'))
      ) || results[0];
    }

    if (!video) return playNext(guild, vc, gid);

    const meta = item.type === 'spotify' ? item.meta : null;
    await sendNowPlaying(queue, video, meta);

    if (!queue.conn) {
      queue.conn = joinVoiceChannel({
        channelId: vc.id,
        guildId: gid,
        adapterCreator: guild.voiceAdapterCreator
      });
    }

    queue.conn.subscribe(queue.player);

    const ytdlp = spawnStream(video.webpage_url);
    ytdlp.on('error', () => { });

    const resource = createAudioResource(ytdlp.stdout, { inputType: 'arbitrary' });
    queue.player.play(resource);

    queue.player.once(AudioPlayerStatus.Idle, () => playNext(guild, vc, gid));
    queue.player.once('error', () => playNext(guild, vc, gid));

  } catch {
    playNext(guild, vc, gid);
  }
}

// ============================================================
// EMBED — NOW PLAYING
// ============================================================
function formatDuration(sec) {
  if (!sec) return '??:??';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function sendNowPlaying(queue, video, spotifyMeta = null) {
  if (!queue.textChannel) return;

  const url = video.webpage_url || '';
  const isYT = url.includes('youtube.com') || url.includes('youtu.be');
  const thumb = video.thumbnail || null;

  const isSpotify = !!spotifyMeta;
  const color = isSpotify ? 0x1DB954 : isYT ? 0xFF0000 : 0x5865F2;

  const authorName = isSpotify
    ? '▶  Spotify → YouTube'
    : '▶  Đang phát · YouTube';

  const authorIcon = isSpotify
    ? 'https://open.spotifycdn.com/cdn/images/favicon32.b64ecc03.png'
    : 'https://www.youtube.com/s/desktop/12d6b690/img/favicon_144x144.png';

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: authorName, iconURL: authorIcon })
    .setTitle(video.title || 'Không rõ tiêu đề')
    .setURL(url || null)
    .addFields(
      { name: '⏱ Thời lượng', value: formatDuration(video.duration), inline: true },
      { name: '📺 Kênh', value: video.uploader || video.channel || 'N/A', inline: true },
      { name: '🎶 Còn queue', value: `${queue.list.length} bài`, inline: true }
    );

  // Nếu là Spotify: hiển thị thêm thông tin gốc
  if (spotifyMeta) {
    embed.addFields(
      { name: '🎵 Spotify title', value: `${spotifyMeta.title} — ${spotifyMeta.artist}`, inline: false },
    );
    if (spotifyMeta.isrc) {
      embed.addFields({ name: '🔖 ISRC', value: spotifyMeta.isrc, inline: true });
    }
  }

  embed.setFooter({ text: 'Dùng /skip để bỏ qua · /stop để dừng' });
  if (thumb) embed.setThumbnail(thumb);

  try {
    await queue.textChannel.send({ embeds: [embed] });
  } catch { }
}

// ============================================================
// EMBED — PLAYLIST / ALBUM ADDED
// ============================================================
function formatTotalDuration(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function buildPlaylistEmbed({ type, name, owner, trackCount, totalSec, image, url }) {
  const isAlbum = type === 'album';
  const embed = new EmbedBuilder()
    .setColor(0x1DB954)
    .setAuthor({
      name: isAlbum ? 'Album · Added to queue' : 'Playlist · Added to queue',
      iconURL: 'https://open.spotifycdn.com/cdn/images/favicon32.b64ecc03.png'
    })
    .setTitle(name)
    .setURL(url)
    .addFields(
      { name: isAlbum ? '👤 Artist' : '👤 Owner', value: owner, inline: true },
      { name: '🎵 Tracks', value: `${trackCount}`, inline: true },
      { name: '⏱ Total Length', value: formatTotalDuration(totalSec), inline: true }
    )
    .setFooter({ text: 'Dùng /skip để bỏ qua · /stop để dừng' });

  if (image) embed.setThumbnail(image);
  return embed;
}