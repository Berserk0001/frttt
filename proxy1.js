"use strict";
import https from "https";
import sharp from "sharp";
import pick from "./pick.js"; // Make sure this path is correct
import superagent from "superagent";

const DEFAULT_QUALITY = 40;
const MIN_COMPRESS_LENGTH = 1024;
const MIN_TRANSPARENT_COMPRESS_LENGTH = MIN_COMPRESS_LENGTH * 100;

function shouldCompress(req) {
    const { originType, originSize, webp } = req.params;
    if (!originType.startsWith("image")) return false;
    if (originSize === 0) return false;
    if (req.headers.range) return false;
    if (webp && originSize < MIN_COMPRESS_LENGTH) return false;
    if (!webp && (originType.endsWith("png") || originType.endsWith("gif")) && originSize < MIN_TRANSPARENT_COMPRESS_LENGTH) {
        return false;
    }
    return true;
}

function redirect(req, res) {
    if (res.headersSent) return;
    res.set("content-length", 0);
    res.removeHeader("cache-control");
    res.removeHeader("expires");
    res.removeHeader("date");
    res.removeHeader("etag");
    res.set("location", encodeURI(req.params.url));
    res.statusCode = 302;
    res.end();
}

const sharpStream = _ => sharp({ animated: false, unlimited: true });

function compress(req, res, input) {
    const format = req.params.webp ? "webp" : "jpeg";
    const sharpInstance = sharpStream();

    input.on("error", (err) => {
        console.error("Input stream error:", err);
        return redirect(req, res);
    });

    input.pipe(sharpInstance)
        .metadata()
        .then((metadata) => {
            if (metadata.height > 16383) {
                sharpInstance.resize({ height: 16383, withoutEnlargement: true });
            }
            return sharpInstance
                .grayscale(req.params.grayscale)
                .toFormat(format, { quality: req.params.quality, effort: 0 })
                .on("info", (info) => {
                    res.set("Content-Type", `image/${format}`);
                    res.set("Content-Length", info.size);
                    res.set("X-Original-Size", req.params.originSize);
                    res.set("X-Bytes-Saved", req.params.originSize - info.size);
                    res.statusCode = 200;
                })
                .on("error", (err) => {
                    console.error("Sharp processing error:", err);
                    redirect(req, res);
                })
                .pipe(res);
        })
        .catch((err) => {
            console.error("Metadata or processing error:", err);
            redirect(req, res);
        });
}

async function hhproxy(req, res) {
    const url = req.query.url;
    if (!url) return res.end("bandwidth-hero-proxy");

    req.params = {
        url: decodeURIComponent(url),
        webp: !req.query.jpeg,
        grayscale: req.query.bw != 0,
        quality: parseInt(req.query.l, 10) || DEFAULT_QUALITY
    };

    try {
        const originReq = superagent.get(req.params.url)
            .set(pick(req.headers, ["cookie", "dnt", "referer", "range", "user-agent"]))
            .set("X-Forwarded-For", req.headers["x-forwarded-for"] || req.ip)
            .set("Via", "1.1 bandwidth-hero")
            .redirects(4)
            .on('error', (err) => {
                console.error("Superagent request error:", err);
                redirect(req, res);
            });
        
        originReq.on('response', (originRes) => {
            if (originRes.status >= 400) return redirect(req, res);

            if (originRes.status >= 300 && originRes.headers.location) {
                req.params.url = originRes.headers.location;
                return redirect(req, res);
            }

            res.set("Content-Encoding", "identity");
            res.set("Access-Control-Allow-Origin", "*");
            res.set("Cross-Origin-Resource-Policy", "cross-origin");
            res.set("Cross-Origin-Embedder-Policy", "unsafe-none");
            res.set("Vary", "Accept-Encoding");

            req.params.originType = originRes.headers["content-type"] || "";
            req.params.originSize = parseInt(originRes.headers["content-length"] || "0", 10);

            if (shouldCompress(req)) {
                compress(req, res, originRes);
            } else {
                res.set("X-Proxy-Bypass", 1);
                ["accept-ranges", "content-type", "content-length", "content-range"].forEach(header => {
                    if (originRes.headers[header]) {
                        res.set(header, originRes.headers[header]);
                    }
                });
                originRes.pipe(res);
            }
        });
    } catch (err) {
        console.error("Outer try/catch error:", err);
        redirect(req, res);
    }
}

export default hhproxy;
