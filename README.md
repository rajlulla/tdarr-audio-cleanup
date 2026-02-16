# Tdarr Plugin: Consolidated Audio & Subtitle Cleanup

A single-pass Tdarr plugin that handles audio language filtering, AAC transcoding, and subtitle cleanup — replacing three separate plugins and eliminating redundant remux passes.

## What It Does

1. **Looks up the file's native language** via Radarr/Sonarr → TMDB
2. **Keeps only the first audio track per allowed language** (native + English + any extras you configure), removing all duplicates and unwanted languages
3. **Adds an AAC copy** alongside each kept track for maximum client compatibility
4. **Fixes Atmos/JOC channel layout corruption** by forcing explicit channel layouts on multichannel AAC output (`-ac` and `-channel_layout`)
5. **Cleans subtitle tracks** — removes unwanted languages and optionally strips commentary/SDH tracks

All in one ffmpeg command, one file write.

## Why

Running separate plugins for language filtering, audio transcoding, and subtitle cleanup means the full file gets remuxed multiple times. For a 25GB file that's three full read/write cycles instead of one. This plugin does everything in a single pass.

### The Atmos/JOC Problem

ffmpeg's native AAC encoder mishandles EAC3 Atmos (JOC) and TrueHD Atmos channel mappings. Without explicit layout flags, the LFE channel gets remapped to nonsensical positions like "Center Back", producing files that strict TV decoders reject. This plugin forces `-ac` and `-channel_layout` on all multichannel transcodes, which fixes Atmos sources and is a harmless no-op on everything else.

## Configuration

| Input | Default | Description |
|---|---|---|
| `priority` | `radarr` | Query Radarr or Sonarr first for IMDB ID lookup |
| `tmdb_api_key` | | TMDB API key (v3) |
| `radarr_url` | `192.168.1.2:7878` | Radarr URL (no http://) |
| `radarr_api_key` | | Radarr API key |
| `sonarr_url` | `192.168.1.2:8989` | Sonarr URL (no http://) |
| `sonarr_api_key` | | Sonarr API key |
| `extra_languages` | | Additional ISO-639-2 languages to keep (comma-separated) |
| `aac_bitrate_per_channel` | `64000` | AAC bitrate per channel in bps (e.g. stereo=128k, 5.1=384k, 7.1=512k) |
| `lossless_default_bitrate` | `640000` | Fallback bitrate for lossless sources with no reported bitrate |
| `subtitle_languages` | `eng` | Subtitle languages to keep (comma-separated ISO-639-2) |
| `remove_commentary_subs` | `true` | Remove subtitles with commentary/description/SDH in the title |

## Example Output

A file with TrueHD 7.1 Atmos (eng), EAC3 7.1 (eng), EAC3 5.1 Atmos (eng), EAC3 5.1 Atmos (eng), and 38 subtitle tracks becomes:

```
Video:  HEVC (copy)
a:0     TrueHD 7.1 Atmos [eng] (copy)
a:1     AAC 8ch 512kbps [eng] (transcoded, -ac 8 -channel_layout 7.1)
s:0     English SRT (copy)
```

## Credits

Built using these plugins as reference:

- [**Tdarr_Plugin_henk_Keep_Native_Lang_Plus_Eng**](https://github.com/HaveAGitGat/Tdarr_Plugins) — Native language + English audio filtering via Radarr/Sonarr/TMDB
- [**add_transcoded_audio_tracks**](https://github.com/DamienDessagne/TdarrPlugins) — AAC transcoding with codec-aware bitrate/channel limits
- [**Tdarr_Plugin_MC93_Migz4CleanSubs**](https://github.com/HaveAGitGat/Tdarr_Plugins) — Subtitle language filtering and cleanup
