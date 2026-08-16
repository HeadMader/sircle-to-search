import { nativeImage } from 'electron';

/** Lens web resizes to <1000px itself; uploading more just slows the POST down. */
function downscale(png: Buffer): Buffer {
  const img = nativeImage.createFromBuffer(png);
  const { width, height } = img.getSize();
  const max = Math.max(width, height);
  if (max <= 1000) return png;
  const f = 1000 / max;
  return img
    .resize({ width: Math.round(width * f), height: Math.round(height * f), quality: 'good' })
    .toPNG();
}

export interface LensUpload {
  url: string;
  postData: Electron.UploadRawData[];
  extraHeaders: string;
}

/**
 * Builds the Lens upload as a real browser navigation: the results view POSTs
 * the multipart body itself and follows Google's 303 to the results page.
 * One organic client end to end — the result URL is session-bound, so doing
 * the upload out-of-band (or opening the URL in another browser) gets
 * "Expired visual search" or a 403 instead of results.
 */
export function lensUploadRequest(png: Buffer): LensUpload {
  const boundary = '----sircle' + Math.random().toString(36).slice(2);
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="encoded_image"; filename="screenshot.png"\r\n` +
        `Content-Type: image/png\r\n\r\n`
    ),
    downscale(png),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  return {
    url: `https://lens.google.com/v3/upload?hl=en&st=${Date.now()}`,
    postData: [{ type: 'rawData', bytes: body }],
    extraHeaders: `Content-Type: multipart/form-data; boundary=${boundary}`
  };
}

// The NID cookie (minted by the Lens upload itself) makes google.com/search
// return 403 in an embedded browser; the same request cookieless returns the
// real results page. Strip cookies from /search navigations only.
export function stripSearchCookies(sess: Electron.Session): void {
  sess.webRequest.onBeforeSendHeaders(
    { urls: ['https://www.google.com/*'] },
    (details, callback) => {
      const headers = details.requestHeaders;
      if (
        details.resourceType === 'mainFrame' &&
        details.url.startsWith('https://www.google.com/search')
      ) {
        const key = Object.keys(headers).find((k) => k.toLowerCase() === 'cookie');
        if (key) delete headers[key];
      }
      callback({ requestHeaders: headers });
    }
  );
}
