import { Shazam } from 'shazam-api';

export interface TrackInfo {
  title: string;
  artist: string;
  coverUrl: string | null;
  url: string | null;
}

let shazam: Shazam | null = null;

/**
 * Recognizes a track from raw PCM (16 kHz, mono, s16) captured from system
 * loopback audio. Uses Shazam's unofficial endpoint; no API key.
 */
export async function recognizeMusic(pcm: Int16Array): Promise<TrackInfo | null> {
  shazam ??= new Shazam();
  const res = await shazam.fullRecognizeSong(Array.from(pcm));
  if (!res?.track) return null;
  return {
    title: res.track.title,
    artist: res.track.subtitle,
    coverUrl: res.track.images?.coverarthq ?? res.track.images?.coverart ?? null,
    url: res.track.url ?? null
  };
}
