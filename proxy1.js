"use strict";

import { URL } from 'url';

import request from 'superagent';
import sharp from "sharp";
import pick from "./pick.js";
import UserAgent from 'user-agents';

const DEFAULT_QUALITY = 40;
const MIN_COMPRESS_LENGTH = 1024;
const MIN_TRANSPARENT_COMPRESS_LENGTH = MIN_COMPRESS_LENGTH * 100;

// Helper: Should compress
function shouldCompress(req) {
  const { originType, originSize, webp } = req.params;

  if (!originType.startsWith("image")) return false;
  if (originSize === 0) return false;
  if (req.headers.range) return false;
  if (webp && originSize < MIN_COMPRESS_LENGTH) return false;
  if (!webp && (originType.endsWith("png") || originType.endsWith("gif")) && originSize < MIN_TRANSPARENT_COMPRESS_LENGTH) return false;

  return true;
}

// Helper: Copy headers
function copyHeaders(source, target) {
  for (const [key, value] of Object.entries(source.headers)) {
    try {
      target.setHeader(key, value);
    } catch (e) {
      console.error(`Error setting header ${key}: ${e.message}`);
    }
  }
}

// Helper: Redirect
function redirect(req, res) {
  if (res.headersSent) return;

  res.setHeader("content-length", 0);
  res.removeHeader("cache-control");
  res.removeHeader("expires");
  res.removeHeader("date");
  res.removeHeader("etag");
  res.setHeader("location", encodeURI(req.params.url));
  res.status = 302;
  res.end();
}

// Helper: Compress
import redis from 'redis';
const client = redis.createClient();

// Configuration options
const cacheOptions = {
    expirationTime: 3600, // 1 hour
};

 async function compress(req, res, input) {
    const cacheKey = `${req.params.url}-${req.params.quality}-${req.params.grayscale}`;

    client.get(cacheKey, async (err, cachedResponse) => {
        if (err) throw err;

        if (cachedResponse) {
            res.setHeader('Content-Type', `image/${format}`);
            res.status(200).send(cachedResponse);
            return;
        }

        // Your existing compression logic
        const format = 'webp';
        const threads = sharp.concurrency(0);
        const image = sharp(input);

        image.metadata(async (err, metadata) => {
            if (err) {
                return redirect(req, res);
            }

            let resizeWidth = null;
            let resizeHeight = null;
            let imgWidth = metadata.width;
            let imgHeight = metadata.height;
            let pixelCount = imgWidth * imgHeight;
            let compressionQuality = req.params.quality;

            if (imgHeight >= 16383) {
                resizeHeight = 16383;
            }

            if (pixelCount > 3000000 || metadata.size > 1536000) {
                compressionQuality *= 0.1;
            } else if (pixelCount > 2000000 && metadata.size > 1024000) {
                compressionQuality *= 0.25;
            } else if (pixelCount > 1000000 && metadata.size > 512000) {
                compressionQuality *= 0.5;
            } else if (pixelCount > 500000 && metadata.size > 256000) {
                compressionQuality *= 0.75;
            }

            compressionQuality = Math.ceil(compressionQuality);

            sharp(input)
                .resize({
                    width: resizeWidth,
                    height: resizeHeight
                })
                .grayscale(req.params.grayscale)
                .toFormat(format, {
                    quality: compressionQuality,
                    effort: 0,
                    smartSubsample: false,
                    lossless: false
                })
                .toBuffer((err, output, info) => {
                    if (err || res.headersSent) return redirect(req, res);
                    setResponseHeaders(info, format);
                    client.setex(cacheKey, cacheOptions.expirationTime, output);
                    res.status(200).send(output);
                });
        });
    });

    function setResponseHeaders(info, imgFormat) {
        res.setHeader('content-type', `image/${imgFormat}`);
        res.setHeader('content-length', info.size);
        let filename = (new URL(req.params.url).pathname.split('/').pop() || "image") + '.' + format;
        res.setHeader('Content-Disposition', 'inline; filename="' + filename + '"');
        res.setHeader('x-original-size', req.params.originSize);
        res.setHeader('x-bytes-saved', req.params.originSize - info.size);
    }

   // Function to invalidate cache
 function invalidateCache(key) {
    client.del(key, (err, response) => {
        if (err) throw err;
    });
 }
}







// Main proxy handler for bandwidth optimization
async function hhproxy(req, res) {
  const url = req.query.url;
  if (!url) return res.end("bandwidth-hero-proxy");

  req.params = {
    url: decodeURIComponent(url),
    webp: !req.query.jpeg,
    grayscale: req.query.bw != 0,
    quality: parseInt(req.query.l, 10) || DEFAULT_QUALITY,
  };
  const userAgent = new UserAgent();
  const options = {
    headers: {
      ...pick(req.headers, ["cookie", "dnt", "referer", "range"]),
      "User-Agent": userAgent.toString(),
      "X-Forwarded-For": req.headers["x-forwarded-for"] || req.ip,
      Via: "1.1 bandwidth-hero"
    },
    method: 'GET',
    rejectUnauthorized: false,
    maxRedirects: 4
  };

  try {
    let originRes = await request
      .get(req.params.url, options)
      .redirects(4)
      .buffer(false);

    _onRequestResponse(originRes, req, res);
  } catch (err) {
    _onRequestError(req, res, err);
  }
}

function _onRequestError(req, res, err) {
  if (err.code === "ERR_INVALID_URL") {
    res.statusCode = 400;
    return res.end("Invalid URL");
  }

  console.error(`Request error: ${err.message}`);
  redirect(req, res);
}

function _onRequestResponse(originRes, req, res) {
  if (originRes.status >= 400) return redirect(req, res);
  if (originRes.status >= 300 && originRes.headers.location) {
    req.params.url = originRes.headers.location;
    return redirect(req, res);
  }

  copyHeaders(originRes, res);
  res.setHeader("Content-Encoding", "identity");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");

  req.params.originType = originRes.headers["content-type"] || "";
  req.params.originSize = parseInt(originRes.headers["content-length"] || "0", 10);

  if (shouldCompress(req)) {
    return compress(req, res, originRes.body);
  } else {
    res.setHeader("X-Proxy-Bypass", 1);
    ["accept-ranges", "content-type", "content-length", "content-range"].forEach(header => {
      if (originRes.headers[header]) res.setHeader(header, originRes.headers[header]);
    });
    return originRes.body.pipe(res);
  }
}

export default hhproxy;
