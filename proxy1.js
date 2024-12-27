"use strict";

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
function compress(req, res, input) {
    const format = req.params.webp ? 'webp' : 'jpeg';

    // Set up Sharp transformations
    let transformer = sharp(input);

    transformer
        .metadata()
        .then(metadata => {
            // Resize if the height exceeds the limit
            if (metadata.height > 16383) {
                transformer = transformer.resize({ height: 16383 });
            }

            // Apply grayscale if requested
            if (req.params.grayscale) {
                transformer = transformer.grayscale();
            }

            // Set output format and quality
            transformer = transformer.toFormat(format, {
                quality: req.params.quality || 80,
                effort: 0,
            });

            // Set response headers and stream data directly to the response
            res.setHeader('Content-Type', `image/${format}`);
            res.setHeader('Transfer-Encoding', 'chunked');

            // Pipe processed image data directly to the response
            transformer
                .on('info', info => {
                    // Set additional headers for original size and bytes saved
                    res.setHeader('x-original-size', req.params.originSize);
                    res.setHeader('x-bytes-saved', req.params.originSize - info.size);
                })
                .on('error', err => {
                    console.error('Error during image processing:', err);
                    redirect(req, res); // Handle processing errors
                });

            // Pipe the input to the transformer and then to the response
            input.pipe(transformer).pipe(res);
        })
        .catch(err => {
            console.error('Error reading metadata:', err);
            redirect(req, res); // Handle metadata errors
        });
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
  };

  try {
    let originRes = await request
      .get(req.params.url, options)
      .redirects(4)
      .buffer(false)

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
