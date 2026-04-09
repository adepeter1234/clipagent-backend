require("dotenv").config();

// Global persistent access token
let ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN || "";
const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const cloudinary = require("cloudinary").v2;
const ffmpeg = require("fluent-ffmpeg");
const { execFile, exec } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "dj4mtzmjk",
  api_key: process.env.CLOUDINARY_API_KEY || "196665315695659",
  api_secret: process.env.CLOUDINARY_API_SECRET || "_ZJp2seaXrHEvizMpC6rVDNTvZ8"
});

const app = express();
app.use(cors({
  origin: "*",
  methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"]
}));
app.options("*", cors());
app.use(express.json());

let channels = [];
let clips = [];
let logs = [];

// ================================================
// PERSISTENT STORAGE
// ================================================
const DATA_FILE = "/tmp/clipagent_data.json";

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ channels, clips: clips.slice(0, 200), accessToken: ACCESS_TOKEN }, null, 2));
  } catch (e) { log("saveData error: " + e.message, "warn"); }
}

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      if (data.channels) channels = data.channels;
      if (data.clips) clips = data.clips;
      if (data.accessToken && data.accessToken.length > 10) {
        ACCESS_TOKEN = data.accessToken;
        log("Loaded saved Instagram token", "success");
      }
      log("Data loaded: " + channels.length + " channels, " + clips.length + " clips", "success");
    }
  } catch (e) { log("loadData error: " + e.message, "warn"); }
}

// ================================================
// THROTTLE
// ================================================
let lastPostTime = 0;
let lastScanTime = 0;
const MIN_POST_GAP_MS = 30 * 60 * 1000;
const MIN_SCAN_GAP_MS = 60 * 60 * 1000;

async function waitForPostSlot() {
  const elapsed = Date.now() - lastPostTime;
  if (elapsed < MIN_POST_GAP_MS) {
    const waitMs = MIN_POST_GAP_MS - elapsed;
    log("Post throttle: waiting " + Math.ceil(waitMs/60000) + " min", "info");
    await new Promise(r => setTimeout(r, waitMs));
  }
  lastPostTime = Date.now();
}

function log(msg, type) {
  if (!type) type = "info";
  const entry = { time: new Date().toISOString(), msg, type };
  logs.unshift(entry);
  if (logs.length > 200) logs.pop();
  console.log("[" + type.toUpperCase() + "] " + msg);
}

function cleanFile(filePath) {
  try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
}

// ================================================
// ROUTES
// ================================================
app.get("/", (req, res) => res.json({ name: "ClipAgent Backend", status: "running", uptime_seconds: Math.floor(process.uptime()), channels: channels.length, clips: clips.length, posts: clips.filter(c => c.status === "posted").length }));
app.get("/api/stats", (req, res) => { const posted = clips.filter(c => c.status === "posted").length; res.json({ channels: channels.length, clips: clips.length, posts: posted, earnings: (posted * 250 * 0.0025).toFixed(2) }); });
app.get("/api/logs", (req, res) => res.json(logs.slice(0, 50)));
app.get("/api/channels", (req, res) => res.json(channels));
app.get("/api/clips", (req, res) => res.json(clips));

app.post("/api/channels", async (req, res) => {
  try {
    const { url, name, clipLength = 60, postTo = "all", autoPost = true } = req.body;
    if (!url) return res.status(400).json({ error: "YouTube channel URL is required" });
    if (channels.length >= 10) return res.status(400).json({ error: "Maximum of 10 channels reached" });
    if (channels.find(c => c.url === url)) return res.status(400).json({ error: "Channel already added" });
    const handle = extractHandle(url);
    const info = await getYouTubeChannelInfo(handle);
    const channel = { id: Date.now().toString(), url, name: name || info.name || handle, ytId: info.ytId || handle, clipLength: parseInt(clipLength), postTo, autoPost: Boolean(autoPost), status: "active", clipsGenerated: 0, postsPublished: 0, lastScanned: null, addedAt: new Date().toISOString() };
    channels.push(channel);
    saveData();
    log("Channel added: " + channel.name, "success");
    res.json(channel);
  } catch (err) { log("Add channel error: " + err.message, "error"); res.status(500).json({ error: err.message }); }
});

app.delete("/api/channels/:id", (req, res) => {
  const ch = channels.find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: "Not found" });
  channels = channels.filter(c => c.id !== req.params.id);
  saveData();
  log("Channel removed: " + ch.name, "warn");
  res.json({ success: true });
});

app.patch("/api/channels/:id/toggle", (req, res) => {
  const ch = channels.find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: "Not found" });
  ch.status = ch.status === "active" ? "paused" : "active";
  saveData();
  res.json(ch);
});

app.delete("/api/clips/:id", (req, res) => { clips = clips.filter(c => c.id !== req.params.id); saveData(); res.json({ success: true }); });

app.post("/api/clips/:id/post", async (req, res) => {
  try {
    const clip = clips.find(c => c.id === req.params.id);
    if (!clip) return res.status(404).json({ error: "Not found" });
    const ch = channels.find(c => c.id === clip.channelId);
    await postClip(clip, ch);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/scan", async (req, res) => {
  try {
    const { channelId } = req.body;
    lastScanTime = Date.now();
    if (channelId) {
      const ch = channels.find(c => c.id === channelId);
      if (!ch) return res.status(404).json({ error: "Not found" });
      await scanChannel(ch);
      return res.json({ success: true, channel: ch.name });
    }
    const active = channels.filter(c => c.status === "active");
    for (let i = 0; i < active.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 15000));
      await scanChannel(active[i]);
    }
    res.json({ success: true, scanned: active.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/refresh-token", async (req, res) => {
  try {
    const r = await axios.get("https://graph.facebook.com/v25.0/oauth/access_token", { params: { grant_type: "fb_exchange_token", client_id: process.env.FACEBOOK_APP_ID, client_secret: process.env.FACEBOOK_APP_SECRET, fb_exchange_token: ACCESS_TOKEN } });
    if (r.data.access_token) { ACCESS_TOKEN = r.data.access_token; saveData(); log("Token refreshed", "success"); res.json({ success: true }); }
    else res.status(400).json({ error: "Could not refresh" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================================================
// HELPERS
// ================================================
function extractHandle(url) {
  const m = url.match(/youtube\.com\/@([^\/\?&]+)/) || url.match(/youtube\.com\/channel\/([^\/\?&]+)/) || url.match(/youtube\.com\/c\/([^\/\?&]+)/) || url.match(/youtube\.com\/user\/([^\/\?&]+)/);
  return m ? m[1] : url.replace(/.*\//, "").replace("@", "");
}

async function getYouTubeChannelInfo(handle) {
  try {
    const res = await axios.get("https://www.googleapis.com/youtube/v3/search", { params: { part: "snippet", type: "channel", q: handle, maxResults: 1, key: process.env.YOUTUBE_API_KEY } });
    if (res.data.items && res.data.items.length > 0) return { name: res.data.items[0].snippet.channelTitle, ytId: res.data.items[0].id.channelId };
  } catch (err) { log("YouTube info error: " + err.message, "warn"); }
  return { name: handle, ytId: handle };
}

async function getLatestVideos(ytChannelId) {
  try {
    const res = await axios.get("https://www.googleapis.com/youtube/v3/search", { params: { part: "snippet", channelId: ytChannelId, type: "video", order: "date", maxResults: 3, key: process.env.YOUTUBE_API_KEY } });
    return res.data.items || [];
  } catch (err) { log("Fetch videos error: " + err.message, "warn"); return []; }
}

// Get video details so Claude can pick truly interesting moments
async function getVideoDetails(videoId) {
  try {
    const res = await axios.get("https://www.googleapis.com/youtube/v3/videos", {
      params: { part: "snippet,contentDetails,statistics", id: videoId, key: process.env.YOUTUBE_API_KEY }
    });
    if (res.data.items && res.data.items.length > 0) {
      const item = res.data.items[0];
      const dur = item.contentDetails.duration;
      const match = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      const totalSeconds = (parseInt(match[1]||0)*3600) + (parseInt(match[2]||0)*60) + (parseInt(match[3]||0));
      return {
        description: (item.snippet.description || "").slice(0, 800),
        totalSeconds,
        tags: (item.snippet.tags || []).slice(0, 10).join(", ")
      };
    }
  } catch (err) { log("Video details error: " + err.message, "warn"); }
  return null;
}

function secondsToTimestamp(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  return (h>0?String(h).padStart(2,"0")+":":"") + String(m).padStart(2,"0") + ":" + String(sec).padStart(2,"0");
}

// ================================================
// AI ANALYSIS — reads video details, avoids intros
// Never clips from first 20% or last 5%
// ================================================
async function analyzeWithClaude(channel, videoId, videoTitle) {
  const details = await getVideoDetails(videoId);
  const totalSeconds = details ? details.totalSeconds : 600;
  const description = details ? details.description : "";
  const tags = details ? details.tags : "";
  const clipLen = channel.clipLength;
  const safeStart = Math.floor(totalSeconds * 0.20);
  const safeEnd = Math.max(safeStart + clipLen + 60, Math.floor(totalSeconds * 0.95) - clipLen);

  const prompt = `You are a viral short-form video expert. Find the MOST interesting, catchy, emotionally engaging moments for Instagram Reels.

Video: "${videoTitle}"
Channel: "${channel.name}"
Total duration: ${totalSeconds}s
Description: ${description}
Tags: ${tags}
Clip length: ${clipLen}s

STRICT RULES:
- ONLY pick moments between ${safeStart}s and ${safeEnd}s — NEVER from the intro or outro
- Pick moments that are: funny, shocking, emotional, controversial, surprising, or highly insightful
- Each clip must be a complete thought — not mid-sentence or mid-action
- Space the 2 clips at least 90 seconds apart

Respond ONLY in raw JSON, no markdown:
{"clips":[{"title":"catchy short title","startSeconds":${safeStart},"viralScore":90,"reason":"why this moment is viral","caption":"engaging caption #fyp #viral #shorts #reels"}]}

Suggest exactly 2 clips.`;

  try {
    const res = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-20250514", max_tokens: 1000,
      messages: [{ role: "user", content: prompt }]
    }, { headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" } });

    const raw = res.data.content && res.data.content[0] ? res.data.content[0].text : "{}";
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    return (parsed.clips || []).map(c => {
      const start = Math.max(safeStart, Math.min(Number(c.startSeconds) || safeStart, safeEnd));
      return { title: c.title || videoTitle, startSeconds: start, endSeconds: start + clipLen, startTime: secondsToTimestamp(start), endTime: secondsToTimestamp(start + clipLen), viralScore: c.viralScore || 80, reason: c.reason || "", caption: c.caption || "#fyp #viral #shorts" };
    });
  } catch (err) { log("Claude error: " + err.message, "warn"); return []; }
}

// ================================================
// yt-dlp FINDER
// ================================================
function findYtDlp() {
  const locations = ["yt-dlp", "/usr/local/bin/yt-dlp", "/usr/bin/yt-dlp", "/home/user/.local/bin/yt-dlp"];
  for (const loc of locations) {
    try { require("child_process").execFileSync(loc, ["--version"], { timeout: 5000 }); return loc; } catch(e) {}
  }
  return null;
}

// ================================================
// DOWNLOAD via yt-dlp with cookies + Android client
// ================================================
async function downloadYouTubeVideo(videoId) {
  const outputPath = path.join("/tmp", uuidv4() + "_raw.mp4");
  const videoUrl = "https://www.youtube.com/watch?v=" + videoId;
  const ytdlpBin = findYtDlp();
  if (!ytdlpBin) throw new Error("yt-dlp not found on this server");

  log("Downloading video: " + videoId, "info");

  // Write cookies file once per download with unique path
  const cookiesPath = "/tmp/yt_cookies_" + uuidv4() + ".txt";
  let cookiesWritten = false;

  if (process.env.YOUTUBE_COOKIES) {
    try {
      // Netscape cookie format — split on semicolons but preserve = inside values
      const lines = ["# Netscape HTTP Cookie File", "# https://curl.haxx.se/rfc/cookie_spec.html", "# This is a generated file!  Do not edit.", ""];
      process.env.YOUTUBE_COOKIES.split(";").forEach(pair => {
        pair = pair.trim();
        if (!pair) return;
        const eqIdx = pair.indexOf("=");
        if (eqIdx < 1) return;
        const name = pair.slice(0, eqIdx).trim();
        const value = pair.slice(eqIdx + 1).trim();
        // Netscape format: domain  includeSubdomains  path  secure  expiry  name  value
        lines.push(".youtube.com	TRUE	/	TRUE	2147483647	" + name + "	" + value);
      });
      fs.writeFileSync(cookiesPath, lines.join("\n") + "\n");
      cookiesWritten = true;
      log("Wrote " + (lines.length - 4) + " YouTube cookies to file", "info");
    } catch (e) {
      log("Cookie write error: " + e.message, "warn");
    }
  } else {
    log("No YOUTUBE_COOKIES set — download may be rate-limited", "warn");
  }

  return new Promise((resolve, reject) => {
    const args = [
      "--no-playlist",
      "--format", "mp4/bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best",
      "--merge-output-format", "mp4",
      "--output", outputPath,
      "--no-warnings",
      "--quiet",
      "--no-check-certificate",
      "--extractor-args", "youtube:player_client=android,web",
      "--user-agent", "com.google.android.youtube/17.36.4 (Linux; U; Android 12; GB) gzip"
    ];

    if (cookiesWritten) {
      args.push("--cookies", cookiesPath);
      log("Using cookies file for download", "info");
    }

    args.push(videoUrl);

    const timer = setTimeout(() => {
      cleanFile(outputPath);
      cleanFile(cookiesPath);
      reject(new Error("yt-dlp timeout after 120s"));
    }, 120000);

    execFile(ytdlpBin, args, { maxBuffer: 1024 * 1024 * 100 }, (error, stdout, stderr) => {
      clearTimeout(timer);
      cleanFile(cookiesPath);
      if (error) {
        cleanFile(outputPath);
        const msg = (stderr || error.message || "").slice(0, 400);
        log("yt-dlp stderr: " + msg, "warn");
        if (msg.includes("Sign in") || msg.includes("bot") || msg.includes("confirm")) {
          reject(new Error("YouTube bot check failed — cookies may be expired, re-export from browser"));
        } else {
          reject(new Error("yt-dlp error: " + msg));
        }
        return;
      }
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
        reject(new Error("yt-dlp: output file missing or empty"));
        return;
      }
      log("Download complete: " + outputPath, "success");
      resolve(outputPath);
    });
  });
}

// ================================================
// CUT CLIP — exact timestamp, user-selected length
// ================================================
async function cutVideoClip(inputPath, startSeconds, clipLength) {
  const outputPath = path.join("/tmp", uuidv4() + "_clip.mp4");
  log("Cutting clip: start=" + startSeconds + "s duration=" + clipLength + "s", "info");
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(startSeconds)
      .setDuration(clipLength)
      .videoCodec("libx264")
      .audioCodec("aac")
      .outputOptions(["-preset ultrafast", "-crf 28", "-vf scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2", "-movflags +faststart", "-pix_fmt yuv420p"])
      .output(outputPath)
      .on("end", () => { log("Clip cut done", "success"); resolve(outputPath); })
      .on("error", (err) => { cleanFile(outputPath); reject(new Error("FFmpeg error: " + err.message)); })
      .run();
    setTimeout(() => { cleanFile(outputPath); reject(new Error("FFmpeg timeout")); }, 180000);
  });
}

// ================================================
// UPLOAD TO CLOUDINARY — real public HTTPS video URL
// ================================================
async function uploadToCloudinary(filePath, clipTitle) {
  log("Uploading to Cloudinary: " + clipTitle, "info");
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload(filePath, {
      resource_type: "video",
      public_id: "clipagent_" + Date.now(),
      folder: "clipagent",
      overwrite: true
    }, (error, result) => {
      if (error) reject(new Error("Cloudinary error: " + error.message));
      else { log("Cloudinary done: " + result.secure_url, "success"); resolve(result.secure_url); }
    });
  });
}

// ================================================
// POST TO INSTAGRAM AS REEL — VIDEO ONLY, NO IMAGES
// Pipeline: download → cut → upload → post → poll → publish
// ================================================
async function postToInstagram(clip) {
  let rawVideoPath = null;
  let clipVideoPath = null;

  try {
    const igId = process.env.INSTAGRAM_BUSINESS_ID || process.env.INSTAGRAM_PAGE_ID;
    if (!ACCESS_TOKEN || ACCESS_TOKEN.length < 10) { log("Instagram skip: ACCESS_TOKEN missing", "warn"); return false; }
    if (!igId) { log("Instagram skip: INSTAGRAM_PAGE_ID not set", "warn"); return false; }
    if (!clip.videoId || clip.videoId === "demo") { log("Instagram skip: no valid video ID", "info"); return false; }

    // Step 1: Download full video
    rawVideoPath = await downloadYouTubeVideo(clip.videoId);

    // Step 2: Cut to exact clip at user-selected timestamp
    clipVideoPath = await cutVideoClip(rawVideoPath, clip.startSeconds || 0, clip.clipLength || 30);

    // Step 3: Upload to Cloudinary — get real public HTTPS URL
    const videoUrl = await uploadToCloudinary(clipVideoPath, clip.clipTitle);

    // Step 4: Create Instagram Reel container — REELS only, never IMAGE
    const caption = clip.caption + "\n\n" + clip.clipTitle;
    log("Creating Instagram Reel container: " + clip.clipTitle, "info");

    const createRes = await axios.post(
      "https://graph.facebook.com/v25.0/" + igId + "/media",
      { media_type: "REELS", video_url: videoUrl, caption: caption, access_token: ACCESS_TOKEN }
    );

    if (!createRes.data || !createRes.data.id) { log("Instagram container failed: " + JSON.stringify(createRes.data), "warn"); return false; }

    const containerId = createRes.data.id;
    log("Instagram container created: " + containerId, "info");

    // Step 5: Poll until Instagram finishes processing (up to 3 minutes)
    let ready = false;
    for (let i = 0; i < 36; i++) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const statusRes = await axios.get("https://graph.facebook.com/v25.0/" + containerId + "?fields=status_code,status&access_token=" + ACCESS_TOKEN);
        const code = statusRes.data.status_code;
        log("Instagram status [" + (i+1) + "/36]: " + code, "info");
        if (code === "FINISHED") { ready = true; break; }
        if (code === "ERROR") { log("Instagram processing error: " + JSON.stringify(statusRes.data), "warn"); return false; }
      } catch (pollErr) { log("Poll error: " + pollErr.message, "warn"); }
    }

    if (!ready) { log("Instagram processing timed out: " + clip.clipTitle, "warn"); return false; }

    // Step 6: Publish the Reel
    const publishRes = await axios.post(
      "https://graph.facebook.com/v25.0/" + igId + "/media_publish",
      { creation_id: containerId, access_token: ACCESS_TOKEN }
    );

    if (publishRes.data && publishRes.data.id) { log("Instagram Reel PUBLISHED: " + clip.clipTitle + " | ID: " + publishRes.data.id, "success"); return true; }
    log("Instagram publish failed: " + JSON.stringify(publishRes.data), "warn");
    return false;

  } catch (err) {
    const msg = err.response && err.response.data && err.response.data.error ? err.response.data.error.message : err.message;
    log("Instagram error: " + msg, "warn");
    return false;
  } finally {
    cleanFile(rawVideoPath);
    cleanFile(clipVideoPath);
  }
}

// ================================================
// SCAN CHANNEL
// ================================================
async function scanChannel(channel) {
  log("Scanning: " + channel.name, "info");
  channel.status = "processing";
  channel.lastScanned = new Date().toISOString();
  try {
    const videos = await getLatestVideos(channel.ytId);
    if (!videos.length) { log("No videos found: " + channel.name, "info"); channel.status = "active"; return; }
    let videoIndex = 0;
    for (const video of videos.slice(0, 2)) {
      if (videoIndex > 0) { log("Throttle: 15s delay", "info"); await new Promise(r => setTimeout(r, 15000)); }
      videoIndex++;
      const videoId = video.id && video.id.videoId;
      const title = video.snippet && video.snippet.title;
      if (!videoId || !title) continue;
      if (clips.find(c => c.videoId === videoId)) { log("Already clipped: " + title, "info"); continue; }
      log("AI analyzing: " + title, "info");
      const suggestions = await analyzeWithClaude(channel, videoId, title);
      for (const s of suggestions) {
        const clip = { id: Date.now().toString() + Math.random().toString(36).slice(2, 7), channelId: channel.id, channelName: channel.name, videoId, videoTitle: title, clipTitle: s.title, startTime: s.startTime, endTime: s.endTime, startSeconds: s.startSeconds, clipLength: channel.clipLength, duration: channel.clipLength + "s", viralScore: s.viralScore, reason: s.reason, caption: s.caption, status: channel.autoPost ? "queued" : "ready", createdAt: new Date().toISOString(), postedAt: null };
        clips.unshift(clip);
        channel.clipsGenerated++;
        saveData();
        log("Clip ready: " + s.title + " @ " + s.startTime + " Score: " + s.viralScore + "%", "success");
        if (channel.autoPost) await postClip(clip, channel);
      }
    }
  } catch (err) { log("Scan error: " + err.message, "error"); }
  channel.status = "active";
  saveData();
}

async function postClip(clip, channel) {
  if (!channel) return;
  log("Posting: " + clip.clipTitle, "info");
  try {
    await waitForPostSlot();
    let success = false;
    if (channel.postTo === "all" || channel.postTo === "instagram") success = await postToInstagram(clip);
    if (success) { clip.status = "posted"; clip.postedAt = new Date().toISOString(); channel.postsPublished++; saveData(); log("Posted: " + clip.clipTitle, "success"); }
    else { clip.status = "failed"; saveData(); log("Post failed: " + clip.clipTitle, "warn"); }
  } catch (err) { log("Post error: " + err.message, "warn"); clip.status = "failed"; saveData(); }
}

// ================================================
// CRON JOBS
// ================================================
cron.schedule("0 * * * *", async () => {
  try {
    const now = Date.now();
    if (now - lastScanTime < MIN_SCAN_GAP_MS) { log("Scan throttle: skipping", "info"); return; }
    lastScanTime = now;
    const active = channels.filter(c => c.status === "active");
    if (!active.length) return;
    log("Auto-scan: " + active.length + " channel(s)", "info");
    for (let i = 0; i < active.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 15000));
      await scanChannel(active[i]);
    }
  } catch (err) { log("Auto-scan error: " + err.message, "error"); }
});

cron.schedule("0 0 * * *", async () => {
  try {
    const r = await axios.get("https://graph.facebook.com/v25.0/oauth/access_token", { params: { grant_type: "fb_exchange_token", client_id: process.env.FACEBOOK_APP_ID, client_secret: process.env.FACEBOOK_APP_SECRET, fb_exchange_token: ACCESS_TOKEN } });
    if (r.data.access_token) { ACCESS_TOKEN = r.data.access_token; saveData(); log("Token auto-refreshed", "success"); }
  } catch (err) { log("Token refresh error: " + err.message, "warn"); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  loadData();
  log("ClipAgent running on port " + PORT, "success");
  console.log("ClipAgent started on port " + PORT);
});
