"use strict";

import sharp from "sharp";
import pick from "./pick.js";
import superagent from "superagent";
import { availableParallelism } from "os";

// Constants
const DEFAULT_QUALITY = 40;
const MIN_COMPRESS_LENGTH = 1024;
const MIN_TRANSPARENT_COMPRESS_LENGTH = MIN_COMPRESS_LENGTH * 100;
const MAX_HEIGHT = 16383;
const USER_AGENT = "Bandwidth-Hero Compressor";

/**
 * Determines if image compression should be applied based on request parameters.
 * @param {http.IncomingMessage} req - The incoming HTTP request.
 * @returns {boolean} - Whether compression should be performed.
 */
function shouldCompress(req) {
  const { originType, originSize, webp } = req.params;
  return (
    originType.startsWith("image") &&
    originSize > 0 &&
    !req.headers.range &&
    !(webp && originSize < MIN_COMPRESS_LENGTH) &&
    !(!webp && (originType.endsWith("png") || originType.endsWith("gif")) && originSize < MIN_TRANSPARENT_COMPRESS_LENGTH)
  );
}

/**
 * Redirects the request to the original URL with proper headers.
 * @param {http.IncomingMessage} req - The incoming HTTP request.
 * @param {http.ServerResponse} res - The HTTP response.
 */
function redirect(req, res) {
  if (!res.headersSent) {
    res.writeHead(302, {
      Location: encodeURI(req.params.url),
      "Content-Length": "0",
    });
    ["cache-control", "expires", "date", "etag"].forEach((header) => res.removeHeader(header));
    res.end();
  }
}

/**
 * Compresses and transforms the image according to request parameters.
 * @param {http.IncomingMessage} req - The incoming HTTP request.
 * @param {http.ServerResponse} res - The HTTP response.
 * @param {stream.Readable} input - The input image stream.
 */
function compress(req, res, input) {
  const format = req.params.webp ? "webp" : "jpeg";
  const sharpInstance = sharp(input, {
    unlimited: true,
    failOn: "none",
    limitInputPixels: false,
  });

  sharp.cache(false);
  sharp.simd(false);
  sharp.concurrency(availableParallelism());

  sharpInstance
    .metadata()
    .then((metadata) => {
      if (metadata.height > MAX_HEIGHT) {
        sharpInstance.resize({
          width: null,
          height: MAX_HEIGHT,
          withoutEnlargement: true,
        });
      }
      return sharpInstance
        .grayscale(req.params.grayscale)
        .toFormat(format, { quality: req.params.quality, effort: 0 });
    })
    .then((outputStream) => {
      // Set headers only once before sending the data
      res.writeHead(200, {
        "Content-Type": `image/${format}`,
        "Content-Length": outputStream.length,  // Set content-length if needed, otherwise skip this header
        "X-Original-Size": req.params.originSize,
        "X-Bytes-Saved": req.params.originSize - outputStream.length,
      });

      outputStream.pipe(res); // Pipe the processed data directly to the response stream
    })
    .catch(() => redirect(req, res));
}

/**
 * Main proxy handler for bandwidth optimization.
 * @param {http.IncomingMessage} req - The incoming HTTP request.
 * @param {http.ServerResponse} res - The HTTP response.
 */
async function hhproxy(req, res) {
  let url = req.query.url;
  if (!url) return res.end("bandwidth-hero-proxy");

  req.params = {
    url: decodeURIComponent(url),
    webp: !req.query.jpeg,
    grayscale: req.query.bw != 0,
    quality: parseInt(req.query.l, 10) || DEFAULT_QUALITY,
  };

  if (
    req.headers["via"] === "1.1 bandwidth-hero" &&
    ["127.0.0.1", "::1"].includes(req.headers["x-forwarded-for"] || req.ip)
  ) {
    return redirect(req, res);
  }

  try {
    const response = await superagent
      .get(req.params.url)
      .set({
        ...pick(req.headers, ["cookie", "dnt", "referer", "range"]),
        "User-Agent": USER_AGENT,
        "X-Forwarded-For": req.headers["x-forwarded-for"] || req.ip,
        "Via": "1.1 bandwidth-hero",
      })
      .responseType("stream"); // Set response type to stream

    req.params.originType = response.headers["content-type"] || "";
    req.params.originSize = parseInt(response.headers["content-length"] || "0");

    if (shouldCompress(req)) {
      // Pass the stream from superagent directly to sharp
      compress(req, res, response.body);
    } else {
      // Ensure headers are set before streaming
      res.writeHead(200, {
        ...response.headers,
        "Access-Control-Allow-Origin": "*",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Cross-Origin-Embedder-Policy": "unsafe-none",
        "X-Proxy-Bypass": 1,
      });

      // Pipe the original response body directly to the client
      response.body.pipe(res);
    }
  } catch (err) {
    if (err.status === 404 || err.response?.headers?.location) {
      redirect(req, res);
    } else {
      res.status(400).send("Invalid URL");
      console.error(err);
    }
  }
}

export default hhproxy;
