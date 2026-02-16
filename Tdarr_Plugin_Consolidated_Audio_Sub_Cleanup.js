/* eslint-disable no-await-in-loop */
module.exports.dependencies = ['axios@0.27.2', '@cospired/i18n-iso-languages'];
// tdarrSkipTest

/**
 * Consolidated Tdarr Plugin: Audio & Subtitle Cleanup
 *
 * In a single pass, this plugin:
 *   1. Looks up the file's native language via Radarr/Sonarr → TMDB
 *   2. Keeps only the FIRST audio track per allowed language (native + English)
 *   3. Adds an AAC copy alongside each kept track (with JOC/Atmos channel layout fix)
 *   4. Removes subtitle tracks that don't match allowed languages
 *   5. Optionally removes commentary/SDH subtitle tracks
 */

const details = () => ({
  id: 'Tdarr_Plugin_Consolidated_Audio_Sub_Cleanup',
  Stage: 'Pre-processing',
  Name: 'Consolidated Audio & Subtitle Cleanup',
  Type: 'Audio',
  Operation: 'Transcode',
  Description:
    'Single-pass plugin: keeps first audio track per allowed language, adds AAC copies ' +
    'with proper channel layout handling (fixes Atmos/JOC corruption), and cleans subtitle tracks.',
  Version: '1.0',
  Tags: 'pre-processing,ffmpeg,configurable',
  Inputs: [
    // --- Language Lookup ---
    {
      name: 'priority',
      type: 'string',
      defaultValue: 'radarr',
      inputUI: { type: 'dropdown', options: ['radarr', 'sonarr'] },
      tooltip: 'Which arr to query first for IMDB ID lookup.',
    },
    {
      name: 'tmdb_api_key',
      type: 'string',
      defaultValue: '',
      inputUI: { type: 'text' },
      tooltip: 'TMDB API key (v3). https://www.themoviedb.org/',
    },
    {
      name: 'radarr_url',
      type: 'string',
      defaultValue: '192.168.1.2:7878',
      inputUI: { type: 'text' },
      tooltip: 'Radarr URL without http://, including port.',
    },
    {
      name: 'radarr_api_key',
      type: 'string',
      defaultValue: '',
      inputUI: { type: 'text' },
      tooltip: 'Radarr API key.',
    },
    {
      name: 'sonarr_url',
      type: 'string',
      defaultValue: '192.168.1.2:8989',
      inputUI: { type: 'text' },
      tooltip: 'Sonarr URL without http://, including port.',
    },
    {
      name: 'sonarr_api_key',
      type: 'string',
      defaultValue: '',
      inputUI: { type: 'text' },
      tooltip: 'Sonarr API key.',
    },
    // --- Audio ---
    {
      name: 'extra_languages',
      type: 'string',
      defaultValue: '',
      inputUI: { type: 'text' },
      tooltip:
        'Additional ISO-639-2 languages to keep (comma-separated). English and the native ' +
        'language are always kept.\nExample: fre,spa',
    },
    {
      name: 'aac_bitrate_per_channel',
      type: 'string',
      defaultValue: '64000',
      inputUI: { type: 'text' },
      tooltip:
        'AAC bitrate per channel in bps. Total bitrate = channels * this value.\n' +
        'Example: 64000 → stereo=128k, 5.1=384k, 7.1=512k',
    },
    {
      name: 'lossless_default_bitrate',
      type: 'string',
      defaultValue: '640000',
      inputUI: { type: 'text' },
      tooltip:
        'Fallback bitrate (bps) used when the original track has no reported bitrate ' +
        '(common with lossless codecs like TrueHD/FLAC).',
    },
    // --- Subtitles ---
    {
      name: 'subtitle_languages',
      type: 'string',
      defaultValue: 'eng',
      inputUI: { type: 'text' },
      tooltip:
        'Subtitle languages to keep (comma-separated ISO-639-2). ' +
        'Leave empty to keep all subtitles.\nExample: eng,fre',
    },
    {
      name: 'remove_commentary_subs',
      type: 'boolean',
      defaultValue: 'true',
      inputUI: { type: 'dropdown', options: ['true', 'false'] },
      tooltip: 'Remove subtitle tracks with commentary/description/SDH in the title.',
    },
  ],
});

// ============================================================================
// TMDB / Radarr / Sonarr lookup helpers (from henk plugin)
// ============================================================================

/**
 * Query TMDB's /find endpoint with an IMDB ID to get the original language.
 */
const tmdbLookup = async (imdbId, apiKey, axios) => {
  if (!imdbId) return null;

  // Accept raw IMDB IDs or extract from a filename string
  let id = imdbId;
  if (!id.startsWith('tt')) {
    const match = id.match(/(tt\d{7,8})/);
    if (match) id = match[1];
    else return null;
  }

  const url =
    `https://api.themoviedb.org/3/find/${id}` +
    `?api_key=${apiKey}&language=en-US&external_source=imdb_id`;

  const resp = await axios.get(url).then((r) => r.data);
  if (resp.movie_results && resp.movie_results.length > 0) return resp.movie_results[0];
  if (resp.tv_results && resp.tv_results.length > 0) return resp.tv_results[0];
  return null;
};

/**
 * Try to resolve the file's original language by querying Radarr/Sonarr, then TMDB.
 * Returns an ISO-639-1 two-letter language code (e.g. "en") or null.
 */
const resolveOriginalLanguage = async (file, inputs, axios, log) => {
  const fileNameEncoded = encodeURIComponent(file.meta.FileName);
  const languages = require('@cospired/i18n-iso-languages');

  const order =
    inputs.priority === 'sonarr' ? ['sonarr', 'radarr'] : ['radarr', 'sonarr'];

  for (const arr of order) {
    try {
      if (arr === 'radarr' && inputs.radarr_api_key) {
        const resp = await axios.get(
          `http://${inputs.radarr_url}/api/v3/parse?apikey=${inputs.radarr_api_key}&title=${fileNameEncoded}`,
        );
        const movie = resp.data && resp.data.movie;
        if (movie && movie.imdbId) {
          log(`Grabbed IMDB ID (${movie.imdbId}) from Radarr`);
          // Radarr gives us the original language name directly
          if (movie.originalLanguage && movie.originalLanguage.name) {
            const alpha2 = languages.getAlpha2Code(movie.originalLanguage.name, 'en');
            if (alpha2) return alpha2;
          }
          // Fallback: use IMDB ID to query TMDB
          const tmdb = await tmdbLookup(movie.imdbId, inputs.tmdb_api_key, axios);
          if (tmdb) return tmdb.original_language;
        }
      }

      if (arr === 'sonarr' && inputs.sonarr_api_key) {
        const resp = await axios.get(
          `http://${inputs.sonarr_url}/api/v3/parse?apikey=${inputs.sonarr_api_key}&title=${fileNameEncoded}`,
        );
        const series = resp.data && resp.data.series;
        if (series && series.imdbId) {
          log(`Grabbed IMDB ID (${series.imdbId}) from Sonarr`);
          const tmdb = await tmdbLookup(series.imdbId, inputs.tmdb_api_key, axios);
          if (tmdb) return tmdb.original_language;
        }
      }
    } catch (err) {
      log(`${arr} lookup failed: ${err.message}`);
    }
  }

  // Last resort: try to extract an IMDB ID from the filename itself
  try {
    const tmdb = await tmdbLookup(fileNameEncoded, inputs.tmdb_api_key, axios);
    if (tmdb) return tmdb.original_language;
  } catch (err) {
    log(`TMDB filename fallback failed: ${err.message}`);
  }

  return null;
};

// ============================================================================
// Main plugin logic
// ============================================================================

const plugin = async (file, librarySettings, inputs, otherArguments) => {
  const lib = require('../methods/lib')();
  inputs = lib.loadDefaultValues(inputs, details);
  const axios = require('axios').default;
  const languages = require('@cospired/i18n-iso-languages');

  const response = {
    processFile: false,
    preset: '',
    container: `.${file.container}`,
    handBrakeMode: false,
    FFmpegMode: true,
    reQueueAfter: false,
    infoLog: '',
  };

  function log(msg) {
    console.log(msg);
    response.infoLog += msg + '\n';
  }

  log(`--- Consolidated Audio & Subtitle Cleanup ---`);
  log(`File: ${file.file}`);

  // ------------------------------------------------------------------
  // Validate ffprobe data
  // ------------------------------------------------------------------

  if (!file.ffProbeData || !file.ffProbeData.streams) {
    log('No ffprobe data found. Skipping.');
    return response;
  }

  // ------------------------------------------------------------------
  // Resolve allowed audio languages
  // ------------------------------------------------------------------

  const alpha2 = await resolveOriginalLanguage(file, inputs, axios, log);
  if (!alpha2) {
    log('Could not determine original language. Skipping file to be safe.');
    return response;
  }

  // Chinese edge case: TMDB returns 'cn', iso-languages expects 'zh'
  const alpha2Fixed = alpha2 === 'cn' ? 'zh' : alpha2;
  const nativeLang3 = languages.alpha2ToAlpha3B(alpha2Fixed);

  // Build set of allowed audio languages (3-letter codes)
  const allowedAudioLangs = new Set();
  allowedAudioLangs.add(nativeLang3);
  allowedAudioLangs.add('eng');
  allowedAudioLangs.add('und'); // keep undefined-language tracks to be safe

  if (inputs.extra_languages) {
    inputs.extra_languages.split(',').forEach((l) => {
      const trimmed = l.trim().toLowerCase();
      if (trimmed) allowedAudioLangs.add(trimmed);
    });
  }

  log(`Original language: ${alpha2Fixed} → ${nativeLang3}`);
  log(`Allowed audio languages: ${[...allowedAudioLangs].join(', ')}`);

  // ------------------------------------------------------------------
  // Parse subtitle settings
  // ------------------------------------------------------------------

  const subtitleLangs = inputs.subtitle_languages
    ? new Set(inputs.subtitle_languages.split(',').map((l) => l.trim().toLowerCase()))
    : null; // null = keep all
  const removeCommentarySubs = inputs.remove_commentary_subs === 'true' || inputs.remove_commentary_subs === true;

  // ------------------------------------------------------------------
  // AAC transcoding settings
  // ------------------------------------------------------------------

  const bitratePerChannel = parseInt(inputs.aac_bitrate_per_channel) || 64000;
  const losslessDefaultBitrate = parseInt(inputs.lossless_default_bitrate) || 640000;

  // Named layouts for standard channel counts (fixes JOC/Atmos corruption)
  const channelLayouts = {
    1: 'mono',
    2: 'stereo',
    6: '5.1',
    8: '7.1',
  };

  // Codecs that are already AAC — no need to create a copy
  const skipTranscodeCodecs = new Set(['aac']);

  // ------------------------------------------------------------------
  // Walk all streams and build the ffmpeg command
  // ------------------------------------------------------------------

  const cmdParts = [];
  let outputAudioIdx = 0;
  let audioInputIdx = 0;
  let subtitleInputIdx = 0;
  const langsAlreadyKept = {};
  let needsProcessing = false;
  const originalAudioCount = file.ffProbeData.streams.filter(
    (s) => s.codec_type === 'audio',
  ).length;
  const originalSubCount = file.ffProbeData.streams.filter(
    (s) => s.codec_type === 'subtitle',
  ).length;

  // Video: copy all video streams as-is
  cmdParts.push('-map 0:v -c:v copy');

  // --- Audio ---
  for (const stream of file.ffProbeData.streams) {
    if (stream.codec_type !== 'audio') continue;

    const lang = stream.tags && stream.tags.language ? stream.tags.language.toLowerCase() : 'und';
    const codecName = stream.codec_name ? stream.codec_name.toLowerCase() : 'unknown';
    const channels = stream.channels || 2;

    // Decide whether to keep this track
    let keep = false;

    if (!allowedAudioLangs.has(lang)) {
      // Wrong language — drop it
      log(`Audio ${audioInputIdx}: ${codecName} ${channels}ch [${lang}] → REMOVE (unwanted language)`);
    } else if (langsAlreadyKept[lang]) {
      // Duplicate for this language — drop it
      log(`Audio ${audioInputIdx}: ${codecName} ${channels}ch [${lang}] → REMOVE (duplicate, keeping first only)`);
    } else {
      // First track for this language — keep it
      keep = true;
      langsAlreadyKept[lang] = true;
    }

    if (keep) {
      // Copy the original track
      cmdParts.push(`-map 0:a:${audioInputIdx} -c:a:${outputAudioIdx} copy`);
      log(`Audio ${audioInputIdx}: ${codecName} ${channels}ch [${lang}] → KEEP (output a:${outputAudioIdx})`);
      outputAudioIdx++;

      // Add AAC copy if the track isn't already AAC
      if (!skipTranscodeCodecs.has(codecName)) {
        const aacBitrate = channels * bitratePerChannel;

        cmdParts.push(`-map 0:a:${audioInputIdx}`);
        cmdParts.push(`-c:a:${outputAudioIdx} aac`);
        cmdParts.push(`-b:a:${outputAudioIdx} ${aacBitrate}`);

        // Force channel count and layout for multichannel to prevent JOC/Atmos corruption
        if (channels > 2) {
          cmdParts.push(`-ac:a:${outputAudioIdx} ${channels}`);
          if (channelLayouts[channels]) {
            cmdParts.push(`-channel_layout:a:${outputAudioIdx} ${channelLayouts[channels]}`);
          }
        }

        // Set metadata on the AAC copy
        cmdParts.push(`-metadata:s:a:${outputAudioIdx} language=${lang}`);
        const title = `AAC ${channels}ch ${aacBitrate / 1000}kbps [Auto]`;
        cmdParts.push(`-metadata:s:a:${outputAudioIdx} "title=${title}"`);

        log(`  + AAC copy: ${channels}ch ${aacBitrate / 1000}kbps (output a:${outputAudioIdx})`);
        outputAudioIdx++;
      }
    }

    audioInputIdx++;
  }

  // Safety check: ensure we didn't remove all audio
  if (outputAudioIdx === 0) {
    log('All audio tracks would be removed. Aborting to be safe.');
    return response;
  }

  // --- Subtitles ---
  let subtitlesKept = 0;

  for (const stream of file.ffProbeData.streams) {
    if (stream.codec_type !== 'subtitle') continue;

    // Skip streams with missing/invalid codec (prevents ffmpeg crashes)
    if (!stream.codec_name || stream.codec_name === 'none') {
      log(`Subtitle ${subtitleInputIdx}: missing codec, skipping to prevent crash`);
      subtitleInputIdx++;
      continue;
    }

    const lang = stream.tags && stream.tags.language ? stream.tags.language.toLowerCase() : 'und';
    const title = stream.tags && stream.tags.title ? stream.tags.title.toLowerCase() : '';

    let keep = true;
    let reason = '';

    // Language filter
    if (subtitleLangs && !subtitleLangs.has(lang) && lang !== 'und') {
      keep = false;
      reason = `unwanted language [${lang}]`;
    }

    // Commentary/SDH filter
    if (keep && removeCommentarySubs) {
      if (title.includes('commentary') || title.includes('description') || title.includes('sdh')) {
        keep = false;
        reason = `commentary/SDH: "${title}"`;
      }
    }

    if (keep) {
      cmdParts.push(`-map 0:s:${subtitleInputIdx} -c:s:${subtitlesKept} copy`);
      subtitlesKept++;
    } else {
      log(`Subtitle ${subtitleInputIdx} [${lang}]: REMOVE (${reason})`);
    }

    subtitleInputIdx++;
  }

  // If no subtitles survived, explicitly disable subtitle output
  if (subtitlesKept === 0 && originalSubCount > 0) {
    cmdParts.push('-sn');
  }

  // ------------------------------------------------------------------
  // Determine if processing is actually needed
  // ------------------------------------------------------------------

  // Check if any audio tracks were removed or transcoded
  const audioTracksRemoved = audioInputIdx !== Object.keys(langsAlreadyKept).length;
  const audioTracksTranscoded = outputAudioIdx > Object.keys(langsAlreadyKept).length;
  const subsRemoved = subtitlesKept < originalSubCount;

  needsProcessing = audioTracksRemoved || audioTracksTranscoded || subsRemoved;

  if (!needsProcessing) {
    log('Nothing to do — file already matches desired state.');
    return response;
  }

  // ------------------------------------------------------------------
  // Assemble final command and return
  // ------------------------------------------------------------------

  // Add max muxing queue size to prevent buffer errors on large files
  cmdParts.push('-max_muxing_queue_size 9999');

  response.processFile = true;
  response.preset = `, ${cmdParts.join(' ')}`;

  log(`--- Done. Output: ${outputAudioIdx} audio tracks, ${subtitlesKept} subtitle tracks ---`);

  return response;
};

module.exports.details = details;
module.exports.plugin = plugin;
