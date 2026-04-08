require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const cloudinary = require("cloudinary").v2;
const ffmpeg = require("fluent-ffmpeg");
const { execFile } = require("child_process");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "dj4mtzmjk",
  api_key: process.env.CLOUDINARY_API_KEY || "196665315695659",
  api_secret: process.env.CLOUDINARY_API_SECRET || "_ZJp2seaXrHEvizMpC6rVDNTvZ8"
});

const app = express();
app.use(cors({ origin: "*", methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"], allowedHeaders: ["Content-Type","Authorization"] }));
app.options("*", cors());
app.use(express.json());

// ============================================================
// PERSISTENT STORE
// ============================================================
const DATA_FILE = process.env.DATA_FILE || "/tmp/clipagent_data.json";
let channels = [];
let clips = [];
let logs = [];

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      channels = raw.channels || [];
      clips = raw.clips || [];
    }
  } catch(e) {}
}

function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify({ channels, clips }, null, 2)); } catch(e) {}
}

loadData();

// ============================================================
// THROTTLE
// ============================================================
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

// ============================================================
// API ROUTES
// ============================================================
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
    const r = await axios.get("https://graph.facebook.com/v25.0/oauth/access_token", { params: { grant_type: "fb_exchange_token", client_id: process.env.FACEBOOK_APP_ID, client_secret: process.env.FACEBOOK_APP_SECRET, fb_exchange_token: process.env.INSTAGRAM_ACCESS_TOKEN } });
    if (r.data.access_token) { process.env.INSTAGRAM_ACCESS_TOKEN = r.data.access_token; log("Token refreshed", "success"); res.json({ success: true }); }
    else res.status(400).json({ error: "Could not refresh" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// HELPERS
// ============================================================
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

// Get full video details including duration and description for smart clipping
async function getVideoDetails(videoId) {
  try {
    const res = await axios.get("https://www.googleapis.com/youtube/v3/videos", {
      params: { part: "snippet,contentDetails,statistics", id: videoId, key: process.env.YOUTUBE_API_KEY }
    });
    if (res.data.items && res.data.items.length > 0) {
      const item = res.data.items[0];
      // Parse ISO 8601 duration to seconds
      const dur = item.contentDetails.duration;
      const match = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      const totalSeconds = (parseInt(match[1]||0)*3600) + (parseInt(match[2]||0)*60) + (parseInt(match[3]||0));
      return {
        title: item.snippet.title,
        description: item.snippet.description,
        totalSeconds,
        viewCount: item.statistics.viewCount,
        likeCount: item.statistics.likeCount,
        tags: item.snippet.tags || []
      };
    }
  } catch (err) { log("Video details error: " + err.message, "warn"); }
  return null;
}

// ============================================================
// AI ANALYSIS — reads video metadata to find catchy moments
// NEVER picks from the first 20% of the video
// ============================================================
async function analyzeWithClaude(channel, videoId, videoTitle) {
  // First get full video details so Claude can make smart decisions
  const details = await getVideoDetails(videoId);
  const totalSeconds = details ? details.totalSeconds : 600;
  const description = details ? details.description.slice(0, 800) : "";
  const tags = details ? details.tags.slice(0, 10).join(", ") : "";

  // Safe zone: never clip from first 20% or last 5% of video
  const safeStart = Math.floor(totalSeconds * 0.20);
  const safeEnd = Math.floor(totalSeconds * 0.95) - channel.clipLength;
  const clipDuration = channel.clipLength;

  const prompt = `You are a viral short-form video expert. Analyze this YouTube video and find the MOST interesting, catchy, and engaging moments for Instagram Reels.

Video: "${videoTitle}"
Channel: "${channel.name}"
Total duration: ${totalSeconds} seconds
Description: ${description}
Tags: ${tags}
Clip length requested: ${clipDuration} seconds

RULES:
- ONLY suggest moments between ${safeStart}s and ${safeEnd}s (never from the intro/first 20%)
- Pick moments with high emotional impact: funny, shocking, insightful, controversial, or inspiring
- Each clip must be a complete thought or moment — not mid-sentence
- Space clips apart by at least 60 seconds
- Base your picks on the description, tags, and video context

Respond ONLY in raw JSON, no markdown:
{"clips":[{"title":"catchy title","startSeconds":${safeStart},"endSeconds":${safeStart + clipDuration},"viralScore":90,"reason":"why this moment is viral","caption":"caption with hashtags #fyp #viral #shorts"}]}

Suggest exactly 2 clips.`;

  try {
    const res = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }]
    }, { headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" } });

    const raw = res.data.content && res.data.content[0] ? res.data.content[0].text : "{}";
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    const clips = parsed.clips || [];

    // Validate timestamps — enforce safe zone
    return clips.map(c => {
      const start = Math.max(safeStart, Math.min(c.startSeconds || safeStart, safeEnd));
      return {
        ...c,
        startSeconds: start,
        endSeconds: start + clipDuration,
        startTime: secondsToTimestamp(start),
        endTime: secondsToTimestamp(start + clipDuration)
      };
    });
  } catch (err) { log("Claude error: " + err.message, "warn"); return []; }
}

function secondsToTimestamp(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  return (h>0?String(h).padStart(2,"0")+":":"") + String(m).padStart(2,"0") + ":" + String(sec).padStart(2,"0");
}

// ============================================================
// yt-dlp BINARY FINDER
// ============================================================
function findYtDlp() {
  const locations = ["yt-dlp", "/usr/local/bin/yt-dlp", "/usr/bin/yt-dlp", "/home/user/.local/bin/yt-dlp"];
  for (const loc of locations) {
    try { require("child_process").execFileSync(loc, ["--version"], { timeout: 5000 }); return loc; } catch(e) {}
  }
  return null;
}

// ============================================================
// DOWNLOAD full video via yt-dlp
// ============================================================
async function downloadYouTubeVideo(videoId) {
  const outputPath = path.join("/tmp", uuidv4() + "_raw.mp4");
  const videoUrl = "https://www.youtube.com/watch?v=" + videoId;
  const ytdlpBin = findYtDlp();
  if (!ytdlpBin) throw new Error("yt-dlp not found on this server");

  log("Downloading video: " + videoId, "info");

  return new Promise((resolve, reject) => {
    const args = ["--no-playlist", "--format", "worst[ext=mp4]/worst", "--output", outputPath, "--no-warnings", "--quiet", "--no-check-certificate", videoUrl];

    // Cookie support for age-restricted or bot-blocked videos
    const cookiesPath = "/tmp/yt_cookies_" + uuidv4() + ".txt";
    if (process.env.YOUTUBE_COOKIES) {
      try {
        let cookieContent = "# Netscape HTTP Cookie File\n";
        process.env.YOUTUBE_COOKIES.split(";").forEach(c => {
          const eqIdx = c.indexOf("=");
          if (eqIdx > 0) {
            const name = c.slice(0, eqIdx).trim();
            const value = c.slice(eqIdx + 1).trim();
            cookieContent += ".youtube.com\tTRUE\t/\tTRUE\t9999999999\t" + name + "\t" + value + "\n";
          }
        });
        fs.writeFileSync(cookiesPath, cookieContent);
        args.unshift("--cookies", cookiesPath);
        log("Using YouTube cookies", "info");
      } catch (e) { log("Cookie write error: " + e.message, "warn"); }
    }

    const timer = setTimeout(() => { cleanFile(outputPath); cleanFile(cookiesPath); reject(new Error("yt-dlp timeout after 120s")); }, 120000);
    execFile(ytdlpBin, args, { maxBuffer: 1024 * 1024 * 100 }, (error, stdout, stderr) => {
      clearTimeout(timer);
      cleanFile(cookiesPath);
      if (error) { cleanFile(outputPath); reject(new Error("yt-dlp error: " + (stderr || error.message).slice(0, 300))); return; }
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) { reject(new Error("yt-dlp: output file missing or empty")); return; }
      log("Download complete: " + outputPath, "success");
      resolve(outputPath);
    });
  });
}

// ============================================================
// CUT CLIP — exact user-selected start/end time
// ============================================================
async function cutVideoClip(inputPath, startSeconds, clipLength) {
  const outputPath = path.join("/tmp", uuidv4() + "_clip.mp4");
  log("Cutting clip: start=" + startSeconds + "s duration=" + clipLength + "s", "info");
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(startSeconds)
      .setDuration(clipLength)
      .videoCodec("libx264")
      .audioCodec("aac")
      .outputOptions([
        "-preset ultrafast",
        "-crf 28",
        "-vf scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2",
        "-movflags +faststart",
        "-pix_fmt yuv420p"
      ])
      .output(outputPath)
      .on("end", () => { log("Clip cut done: " + outputPath, "success"); resolve(outputPath); })
      .on("error", (err) => { cleanFile(outputPath); reject(new Error("FFmpeg error: " + err.message)); })
      .run();
    setTimeout(() => { cleanFile(outputPath); reject(new Error("FFmpeg timeout")); }, 180000);
  });
}

// ============================================================
// UPLOAD TO CLOUDINARY — get public HTTPS video URL
// ============================================================
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

// ============================================================
// POST TO INSTAGRAM AS REEL — VIDEO ONLY, NO IMAGES EVER
// ============================================================
async function postToInstagram(clip) {
  let rawVideoPath = null;
  let clipVideoPath = null;

  try {
    const igId = process.env.INSTAGRAM_BUSINESS_ID || process.env.INSTAGRAM_PAGE_ID;
    const token = process.env.INSTAGRAM_ACCESS_TOKEN;

    if (!clip.videoId || clip.videoId === "demo") { log("Skipping — no valid video ID", "info"); return false; }
    if (!igId || !token) { log("Instagram error: missing credentials", "warn"); return false; }

    // Step 1: Download full video
    rawVideoPath = await downloadYouTubeVideo(clip.videoId);

    // Step 2: Cut to exact clip using user-selected startSeconds and clipLength
    clipVideoPath = await cutVideoClip(rawVideoPath, clip.startSeconds || 0, clip.clipLength || 30);

    // Step 3: Upload clip to Cloudinary for a public HTTPS URL
    const videoUrl = await uploadToCloudinary(clipVideoPath, clip.clipTitle);

    // Step 4: Create Instagram Reel container — REELS only, never IMAGE
    const caption = clip.caption + "\n\n" + clip.clipTitle;
    log("Posting Reel to Instagram: " + clip.clipTitle, "info");

    const createRes = await axios.post(
      "https://graph.facebook.com/v25.0/" + igId + "/media",
      { media_type: "REELS", video_url: videoUrl, caption: caption, access_token: token }
    );

    if (!createRes.data || !createRes.data.id) {
      log("Instagram container failed: " + JSON.stringify(createRes.data), "warn");
      return false;
    }

    const containerId = createRes.data.id;
    log("Instagram container created: " + containerId, "info");

    // Step 5: Poll until video is processed
    let ready = false;
    for (let i = 0; i < 18; i++) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const statusRes = await axios.get("https://graph.facebook.com/v25.0/" + containerId + "?fields=status_code&access_token=" + token);
        log("Instagram status: " + statusRes.data.status_code, "info");
        if (statusRes.data.status_code === "FINISHED") { ready = true; break; }
        if (statusRes.data.status_code === "ERROR") throw new Error("Instagram video processing failed");
      } catch (pollErr) { log("Poll error: " + pollErr.message, "warn"); }
    }

    if (!ready) throw new Error("Instagram video processing timed out");

    // Step 6: Publish
    const publishRes = await axios.post(
      "https://graph.facebook.com/v25.0/" + igId + "/media_publish",
      { creation_id: containerId, access_token: token }
    );

    if (publishRes.data && publishRes.data.id) {
      log("Instagram Reel published: " + clip.clipTitle, "success");
      return true;
    }

    log("Instagram publish failed: " + JSON.stringify(publishRes.data), "warn");
    return false;

  } catch (err) {
    const msg = err.response && err.response.data && err.response.data.error ? err.response.data.error.message : err.message;
    log("Instagram error: " + msg, "warn");
    return false;
  } finally {
    // Always clean up temp files
    cleanFile(rawVideoPath);
    cleanFile(clipVideoPath);
  }
}

// ============================================================
// SCAN CHANNEL — analyzes video before clipping
// ============================================================
async function scanChannel(channel) {
  log("Scanning: " + channel.name, "info");
  channel.status = "processing";
  channel.lastScanned = new Date().toISOString();
  try {
    const videos = await getLatestVideos(channel.ytId);
    if (!videos.length) { log("No videos found: " + channel.name, "info"); channel.status = "active"; return; }

    let videoIndex = 0;
    for (const video of videos.slice(0, 2)) {
      if (videoIndex > 0) { log("Throttle: 15s delay between videos", "info"); await new Promise(r => setTimeout(r, 15000)); }
      videoIndex++;

      const videoId = video.id && video.id.videoId;
      const title = video.snippet && video.snippet.title;
      if (!videoId || !title) continue;
      if (clips.find(c => c.videoId === videoId)) { log("Already clipped: " + title, "info"); continue; }

      log("Analyzing video content: " + title, "info");
      // Pass videoId so Claude can read duration and metadata before picking timestamps
      const suggestions = await analyzeWithClaude(channel, videoId, title);

      for (const s of suggestions) {
        const clip = {
          id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
          channelId: channel.id,
          channelName: channel.name,
          videoId,
          videoTitle: title,
          clipTitle: s.title,
          startTime: s.startTime,
          endTime: s.endTime,
          startSeconds: s.startSeconds,
          clipLength: channel.clipLength,
          duration: channel.clipLength + "s",
          viralScore: s.viralScore,
          reason: s.reason,
          caption: s.caption,
          status: channel.autoPost ? "queued" : "ready",
          createdAt: new Date().toISOString(),
          postedAt: null
        };
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

// ============================================================
// CRON JOBS
// ============================================================
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
    const r = await axios.get("https://graph.facebook.com/v25.0/oauth/access_token", { params: { grant_type: "fb_exchange_token", client_id: process.env.FACEBOOK_APP_ID, client_secret: process.env.FACEBOOK_APP_SECRET, fb_exchange_token: process.env.INSTAGRAM_ACCESS_TOKEN } });
    if (r.data.access_token) { process.env.INSTAGRAM_ACCESS_TOKEN = r.data.access_token; log("Token auto-refreshed", "success"); }
  } catch (err) { log("Token refresh error: " + err.message, "warn"); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log("ClipAgent running on port " + PORT, "success");
  console.log("ClipAgent started on port " + PORT);
});
