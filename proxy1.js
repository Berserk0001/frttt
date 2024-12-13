"use strict";
import UserAgent from 'user-agents';
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
 * Copies headers from the source response to the target response, logging errors if any.
 * @param {Object} sourceHeaders - The headers from the source response.
 * @param {http.ServerResponse} target - The target response object.
 */
function copyHeaders(source, target) {
  Object.entries(source.headers).forEach(([key, value]) => {
    try {
      target.setHeader(key, value);
    } catch (e) {
      console.error(`Error setting header ${key}: ${e.message}`);
    }
  });
}

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
/**
 * Compresses and transforms the image according to request parameters.
 * @param {http.IncomingMessage} req - The incoming HTTP request.
 * @param {http.ServerResponse} res - The HTTP response.
 * @param {stream.Readable} input - The input image stream.
 */

//const sharpStream = _ => sharp({ animated: !process.env.NO_ANIMATE, unlimited: true });
const sharpStream = _ => sharp({ animated: false, unlimited: true });

function compress(req, res, input) {
  const format = req.params.webp ? 'webp' : 'jpeg';

  /*
   * Determine the uncompressed image size when there's no content-length header. Only do metadata thing and do not change other things.
   */

  /*
   * input.pipe => sharp (The compressor) => Send to httpResponse
   * The following headers:
   * |  Header Name  |            Description            |           Value            |
   * |---------------|-----------------------------------|----------------------------|
   * |x-original-size|Original photo size                |OriginSize                  |
   * |x-bytes-saved  |Saved bandwidth from original photo|OriginSize - Compressed Size|
   */

  input.pipe(sharpStream()
    .metadata((err, metadata) => {
      if (err) return redirect(req, res);

      let transform = sharpStream();

      if (metadata.height > 16383) {
        transform = transform.resize(null, 16383, { withoutEnlargement: true });
      }

      transform
        .grayscale(req.params.grayscale)
        .toFormat(format, {
          quality: req.params.quality,
          progressive: true,
          optimizeScans: true
        })
        .toBuffer((err, output, info) => _sendResponse(err, output, info, format, req, res));
    })
  );
}

function _sendResponse(err, output, info, format, req, res) {
  if (err || !info) return redirect(req, res);

  res.setHeader('content-type', 'image/' + format);
  res.setHeader('content-length', info.size);
  res.setHeader('x-original-size', req.params.originSize);
  res.setHeader('x-bytes-saved', req.params.originSize - info.size);
  res.status(200);
  res.write(output);
  res.end();
}




/**
 * Main proxy handler for bandwidth optimization.
 * @param {http.IncomingMessage} req - The incoming HTTP request.
 * @param {http.ServerResponse} res - The HTTP response.
 */
async function hhproxy(req, res) {
  const url = req.query.url;
  if (!url) {
    return res.end("bandwidth-hero-proxy");
  }


  req.params = {
    url: decodeURIComponent(url),
    webp: !req.query.jpeg,
    grayscale: req.query.bw != 0,
    quality: parseInt(req.query.l, 10) || DEFAULT_QUALITY
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

 // const requestModule = parsedUrl.protocol === 'https:' ? https : http;

  try {
    let originReq = await superagent.get(req.params.url, options, (originRes) => {
      _onRequestResponse(originRes, req, res);
    });

  } catch (err) {
    _onRequestError(req, res, err);
  }
}

function _onRequestError(req, res, err) {
  if (err.code === "ERR_INVALID_URL") {
    res.statusCode = 400;
    return res.end("Invalid URL");
  }

  redirect(req, res);
  console.error(err);
}

function _onRequestResponse(originRes, req, res) {
  if (originRes.statusCode >= 400) {
    return redirect(req, res);
  }

  if (originRes.statusCode >= 300 && originRes.headers.location) {
    req.params.url = originRes.headers.location;
    return redirect(req, res); // Follow the redirect manually
  }

  copyHeaders(originRes, res);

  res.setHeader("Content-Encoding", "identity");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");

  req.params.originType = originRes.headers["content-type"] || "";
  req.params.originSize = parseInt(originRes.headers["content-length"] || "0", 10);
 
  originRes.on('error', _ => req.socket.destroy());

  if (shouldCompress(req)) {
    return compress(req, res, originRes);
  } else {
    res.setHeader("X-Proxy-Bypass", 1);

    ["accept-ranges", "content-type", "content-length", "content-range"].forEach(header => {
      if (originRes.headers[header]) {
        res.setHeader(header, originRes.headers[header]);
      }
    });

   return originRes.pipe(res);
  }
}

export default hhproxy;
