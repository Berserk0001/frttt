"use strict";

import http from "http";
import https from "https";
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
  if (
    !webp &&
    (originType.endsWith("png") || originType.endsWith("gif")) &&
    originSize < MIN_TRANSPARENT_COMPRESS_LENGTH
  ) {
    return false;
  }

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

  res.statusCode = 302;
  res.setHeader('Location', encodeURI(req.params.url));
  res.end();
}

// Helper: Compress
async function compress(req, res, input) {
  sharp.cache(false);
  sharp.simd(true);
  
  const format = req.params.webp ? "webp" : "jpeg";
  const sharpInstance = sharp({
    unlimited: true,
    failOn: "none",
    limitInputPixels: false
  });

  try {
    const metadata = await new Promise((resolve, reject) => {
      input.pipe(sharpInstance.metadata()).once('metadata', resolve).once('error', reject);
    });

    if (metadata.height > 16383) {
      sharpInstance.resize({
        width: null,
        height: 16383,
        withoutEnlargement: true
      });
    }

    const transformer = sharpInstance
      .grayscale(req.params.grayscale)
      .toFormat(format, { quality: req.params.quality, effort: 0 });

    res.setHeader("Content-Type", `image/${format}`);
    res.setHeader("X-Original-Size", req.params.originSize);

    transformer.on("info", (info) => {
      res.setHeader("Content-Length", info.size);
      res.setHeader("X-Bytes-Saved", req.params.originSize - info.size);
      res.statusCode = 200;
    });

    input.pipe(transformer).pipe(res);
  } catch (error) {
    redirect(req, res);
  }
}

// Main function
function hhproxy(req, res) {
  // Extract and validate parameters from the request
  let url = req.query.url;
  if (!url) return res.status(400).end("Invalid URL");

  // Replace the URL pattern
  url = url.replace(/http:\/\/1\.1\.\d\.\d\/bmi\/(https?:\/\/)?/i, 'http://');

  // Set request parameters
  req.params = {
    url,
    webp: !req.query.jpeg,
    grayscale: req.query.bw !== '0',
    quality: parseInt(req.query.l, 10) || DEFAULT_QUALITY,
  };

  // Avoid loopback that could cause server hang.
  if (
    req.headers["via"] === "1.1 myapp-hero" &&
    ["127.0.0.1", "::1"].includes(req.headers["x-forwarded-for"] || req.ip)
  ) {
    return redirect(req, res);
  }

  const parsedUrl = new URL(req.params.url);
  const userAgent = new UserAgent();
  const options = {
    headers: {
      ...pick(req.headers, ["cookie", "dnt", "referer", "range"]),
      "user-agent": userAgent.toString(),
      "x-forwarded-for": req.headers["x-forwarded-for"] || req.ip,
      via: "1.1 myapp-hero",
    },
    method: 'GET',
    rejectUnauthorized: false // Disable SSL verification
  };

  const requestModule = parsedUrl.protocol === 'https:' ? https : http;

  try {
    const originReq = requestModule.request(parsedUrl, options, (originRes) => {
      // Handle non-2xx or redirect responses.
      if (
        originRes.statusCode >= 400 ||
        (originRes.statusCode >= 300 && originRes.headers.location)
      ) {
        return redirect(req, res);
      }

      // Set headers and stream response.
      copyHeaders(originRes, res);
      res.setHeader("content-encoding", "identity");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");
      req.params.originType = originRes.headers["content-type"] || "";
      req.params.originSize = parseInt(originRes.headers["content-length"] || "0", 10);

      if (shouldCompress(req)) {
        compress(req, res, originRes);
      } else {
        res.setHeader("x-proxy-bypass", 1);
        ["accept-ranges", "content-type", "content-length", "content-range"].forEach((header) => {
          if (originRes.headers[header]) {
            res.setHeader(header, originRes.headers[header]);
          }
        });

        originRes.pipe(res);
      }
    });

    originReq.on('error', (err) => {
      console.error('Request Error:', err.message);
      redirect(req, res);
    });
    
    originReq.end();
  } catch (err) {
    console.error('Error in hhproxy:', err.message);
    redirect(req, res);
  }
}

export default hhproxy;
