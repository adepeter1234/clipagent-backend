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
const ytdl = require("ytdl-core");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "dj4mtzmjk",
  api_key: process.env.CLOUDINARY_API_KEY || "196665315695659",
  api_secret: process.env.CLOUDINARY_API_SECRET || "_ZJp2seaXrHEvizMpC6rVDNTvZ8"
});

const app = express();
app.use(cors());
app.use(express.json());

let channels = [];
let clips = [];
let logs = [];

function log(msg, type) {
  if (!type) type = "info";
  const entry = { time: new Date().toISOString(), msg, type };
  logs.unshift(entry);
  if (logs.length > 200) logs.pop();
  console.log("[" + type.toUpperCase() + "] " + msg);
}

function cleanFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      log("Cleaned up: " + filePath, "info");
    }
  } catch (e) {
    log("Cleanup error: " + e.message, "warn");
  }
}

// ================================================
// HEALTH CHECK
// ================================================
app.get("/", (req, res) => {
  res.json({
    name: "ClipAgent Backend",
    status: "running",
    uptime_seconds: Math.floor(process.uptime()),
    channels: channels.length,
    clips: clips.length,
    posts: clips.filter(c => c.status === "posted").length
  });
});

app.get("/api/stats", (req, res) => {
  const posted = clips.filter(c => c.status === "posted").length;
  res.json({
    channels: channels.length,
    clips: clips.length,
    posts: posted,
    earnings: (posted * 250 * 0.0025).toFixed(2)
  });
});

app.get("/api/logs", (req, res) => res.json(logs.slice(0, 50)));
app.get("/api/channels", (req, res) => res.json(channels));
app.get("/api/clips", (req, res) => res.json(clips));

// ================================================
// CHANNELS — Add
// ================================================
app.post("/api/channels", async (req, res) => {
  try {
    const { url, name, clipLength = 60, postTo = "all", autoPost = true } = req.body;
    if (!url) return res.status(400).json({ error: "YouTube channel URL is required" });
    if (channels.length >= 10) return res.status(400).json({ error: "Maximum of 10 channels reached" });
    if (channels.find(c => c.url === url)) return res.status(400).json({ error: "Channel already added" });
    const handle = extractHandle(url);
    const info = await getYouTubeChannelInfo(handle);
    const channel = {
      id: Date.now().toString(), url, name: name || info.name || handle,
      ytId: info.ytId || handle, clipLength: parseInt(clipLength),
      postTo, autoPost: Boolean(autoPost), status: "active",
      clipsGenerated: 0, postsPublished: 0, lastScanned: null,
      addedAt: new Date().toISOString()
    };
    channels.push(channel);
    log("Channel added: " + channel.name, "success");
    res.json(channel);
  } catch (err) {
    log("Add channel error: " + err.message, "error");
    res.status(500).json({ error: err.message });
  }
});

// ================================================
// CHANNELS — Delete / Toggle
// ================================================
app.delete("/api/channels/:id", (req, res) => {
  const ch = channels.find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: "Not found" });
  channels = channels.filter(c => c.id !== req.params.id);
  log("Channel removed: " + ch.name, "warn");
  res.json({ success: true });
});

app.patch("/api/channels/:id/toggle", (req, res) => {
  const ch = channels.find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: "Not found" });
  ch.status = ch.status === "active" ? "paused" : "active";
  log("Channel " + ch.status + ": " + ch.name, "info");
  res.json(ch);
});

// ================================================
// CLIPS — Delete / Post
// ================================================
app.delete("/api/clips/:id", (req, res) => {
  clips = clips.filter(c => c.id !== req.params.id);
  res.json({ success: true });
});

app.post("/api/clips/:id/post", async (req, res) => {
  try {
    const clip = clips.find(c => c.id === req.params.id);
    if (!clip) return res.status(404).json({ error: "Not found" });
    const ch = channels.find(c => c.id === clip.channelId);
    await postClip(clip, ch);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================
// SCAN — Manual Trigger
// ================================================
app.post("/api/scan", async (req, res) => {
  try {
    const { channelId } = req.body;
    if (channelId) {
      const ch = channels.find(c => c.id === channelId);
      if (!ch) return res.status(404).json({ error: "Not found" });
      await scanChannel(ch);
      return res.json({ success: true, channel: ch.name });
    }
    const active = channels.filter(c => c.status === "active");
    for (const ch of active) await scanChannel(ch);
    res.json({ success: true, scanned: active.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================
// TOKEN REFRESH
// ================================================
app.post("/api/refresh-token", async (req, res) => {
  try {
    const r = await axios.get("https://graph.facebook.com/v25.0/oauth/access_token", {
      params: {
        grant_type: "fb_exchange_token",
        client_id: process.env.FACEBOOK_APP_ID,
        client_secret: process.env.FACEBOOK_APP_SECRET,
        fb_exchange_token: process.env.INSTAGRAM_ACCESS_TOKEN
      }
    });
    if (r.data.access_token) {
      process.env.INSTAGRAM_ACCESS_TOKEN = r.data.access_token;
      log("Instagram token refreshed", "success");
      res.json({ success: true });
    } else {
      res.status(400).json({ error: "Could not refresh" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================
// YOUTUBE HELPERS
// ================================================
function extractHandle(url) {
  const m = url.match(/youtube\.com\/@([^\/\?&]+)/) ||
    url.match(/youtube\.com\/channel\/([^\/\?&]+)/) ||
    url.match(/youtube\.com\/c\/([^\/\?&]+)/) ||
    url.match(/youtube\.com\/user\/([^\/\?&]+)/);
  return m ? m[1] : url.replace(/.*\//, "").replace("@", "");
}

async function getYouTubeChannelInfo(handle) {
  try {
    const res = await axios.get("https://www.googleapis.com/youtube/v3/search", {
      params: { part: "snippet", type: "channel", q: handle, maxResults: 1, key: process.env.YOUTUBE_API_KEY }
    });
    if (res.data.items && res.data.items.length > 0) {
      return { name: res.data.items[0].snippet.channelTitle, ytId: res.data.items[0].id.channelId };
    }
  } catch (err) {
    log("YouTube info error: " + err.message, "warn");
  }
  return { name: handle, ytId: handle };
}

async function getLatestVideos(ytChannelId) {
  try {
    const res = await axios.get("https://www.googleapis.com/youtube/v3/search", {
      params: { part: "snippet", channelId: ytChannelId, type: "video", order: "date", maxResults: 3, key: process.env.YOUTUBE_API_KEY }
    });
    return res.data.items || [];
  } catch (err) {
    log("Fetch videos error: " + err.message, "warn");
    return [];
  }
}

// ================================================
// CLAUDE AI — Analyze Video
// ================================================
async function analyzeWithClaude(channel, videoTitle) {
  const prompt = "You are a viral content expert.\nChannel: \"" + channel.name + "\"\nVideo: \"" + videoTitle + "\"\nClip length: " + channel.clipLength + "s\n\nSuggest 2 clip moments. Respond ONLY in raw JSON no markdown:\n{\"clips\":[{\"title\":\"title\",\"startTime\":\"00:30\",\"endTime\":\"01:30\",\"startSeconds\":30,\"viralScore\":90,\"reason\":\"reason\",\"caption\":\"caption #fyp #viral #shorts\"}]}";
  try {
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      { model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content: prompt }] },
      { headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" } }
    );
    const raw = res.data.content && res.data.content[0] ? res.data.content[0].text : "{}";
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    return parsed.clips || [];
  } catch (err) {
    log("Claude error: " + err.message, "warn");
    return [];
  }
}

// ================================================
// STEP 1 — DOWNLOAD YOUTUBE VIDEO
// ================================================
async function downloadYouTubeVideo(videoId) {
  const outputPath = path.join("/tmp", uuidv4() + "_raw.mp4");
  log("Downloading video: " + videoId, "info");
  return new Promise((resolve, reject) => {
    try {
      const videoUrl = "https://www.youtube.com/watch?v=" + videoId;
      const stream = ytdl(videoUrl, { quality: "lowest", filter: "videoandaudio" });
      const file = fs.createWriteStream(outputPath);
      stream.pipe(file);
      file.on("finish", () => {
        log("Download complete: " + outputPath, "success");
        resolve(outputPath);
      });
      file.on("error", (err) => {
        cleanFile(outputPath);
        reject(err);
      });
      stream.on("error", (err) => {
        cleanFile(outputPath);
        reject(err);
      });
      setTimeout(() => {
        cleanFile(outputPath);
        reject(new Error("Download timeout after 120 seconds"));
      }, 120000);
    } catch (err) {
      cleanFile(outputPath);
      reject(err);
    }
  });
}

// ================================================
// STEP 2 — CUT CLIP WITH FFMPEG
// ================================================
async function cutVideoClip(inputPath, startSeconds, duration) {
  const outputPath = path.join("/tmp", uuidv4() + "_clip.mp4");
  const start = startSeconds || 0;
  const clipDuration = duration || 30;
  log("Cutting clip: start=" + start + "s duration=" + clipDuration + "s", "info");
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(start)
      .setDuration(clipDuration)
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
      .on("end", () => {
        log("Clip ready: " + outputPath, "success");
        resolve(outputPath);
      })
      .on("error", (err) => {
        cleanFile(outputPath);
        reject(new Error("FFmpeg error: " + err.message));
      })
      .run();
    setTimeout(() => {
      cleanFile(outputPath);
      reject(new Error("FFmpeg timeout after 180 seconds"));
    }, 180000);
  });
}

// ================================================
// STEP 3 — UPLOAD TO CLOUDINARY
// ================================================
async function uploadToCloudinary(filePath, clipTitle) {
  log("Uploading to Cloudinary: " + clipTitle, "info");
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload(filePath,
      {
        resource_type: "video",
        public_id: "clipagent_" + Date.now(),
        folder: "clipagent",
        overwrite: true
      },
      (error, result) => {
        if (error) {
          reject(new Error("Cloudinary upload error: " + error.message));
        } else {
          log("Cloudinary upload done: " + result.secure_url, "success");
          resolve(result.secure_url);
        }
      }
    );
  });
}

// ================================================
// STEP 4 — POST TO INSTAGRAM AS REEL
// ================================================
async function postToInstagram(clip) {
  let rawVideoPath = null;
  let clippedVideoPath = null;

  try {
    const igId = process.env.INSTAGRAM_BUSINESS_ID || process.env.INSTAGRAM_PAGE_ID;
    const token = process.env.INSTAGRAM_ACCESS_TOKEN;

    if (!clip.videoId || clip.videoId === "demo") {
      log("Skipping Instagram — no valid video ID for: " + clip.clipTitle, "info");
      return false;
    }

    // STEP 1 — Download
    rawVideoPath = await downloadYouTubeVideo(clip.videoId);

    // STEP 2 — Cut clip
    const startSeconds = clip.startSeconds || 0;
    const duration = clip.clipLength || 30;
    clippedVideoPath = await cutVideoClip(rawVideoPath, startSeconds, duration);

    // STEP 3 — Upload to Cloudinary
    const videoUrl = await uploadToCloudinary(clippedVideoPath, clip.clipTitle);

    // STEP 4 — Post to Instagram as Reel
    log("Posting Reel to Instagram: " + clip.clipTitle, "info");
    const caption = clip.caption + "\n\n" + clip.clipTitle;

    const createRes = await axios.post(
      "https://graph.facebook.com/v25.0/" + igId + "/media",
      { media_type: "REELS", video_url: videoUrl, caption: caption, access_token: token }
    );

    if (!createRes.data.id) {
      throw new Error("Failed to create Instagram media container");
    }

    const containerId = createRes.data.id;
    log("Instagram container created: " + containerId, "info");

    // Wait for Instagram to process video (poll up to 90 seconds)
    let ready = false;
    for (let i = 0; i < 18; i++) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const statusRes = await axios.get(
          "https://graph.facebook.com/v25.0/" + containerId + "?fields=status_code&access_token=" + token
        );
        log("Instagram status: " + statusRes.data.status_code, "info");
        if (statusRes.data.status_code === "FINISHED") { ready = true; break; }
        if (statusRes.data.status_code === "ERROR") { throw new Error("Instagram video processing failed"); }
      } catch (pollErr) {
        log("Poll error: " + pollErr.message, "warn");
      }
    }

    if (!ready) {
      throw new Error("Instagram video processing timed out");
    }

    // Publish
    const publishRes = await axios.post(
      "https://graph.facebook.com/v25.0/" + igId + "/media_publish",
      { creation_id: containerId, access_token: token }
    );

    if (publishRes.data.id) {
      log("Instagram Reel published: " + clip.clipTitle + " ID: " + publishRes.data.id, "success");
      return true;
    }

  } catch (err) {
    const msg = err.response && err.response.data && err.response.data.error
      ? err.response.data.error.message
      : err.message;
    log("Instagram error: " + msg, "warn");
    return false;
  } finally {
    cleanFile(rawVideoPath);
    cleanFile(clippedVideoPath);
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
    if (!videos.length) {
      log("No videos found: " + channel.name, "info");
      channel.status = "active";
      return;
    }
    for (const video of videos.slice(0, 2)) {
      const videoId = video.id && video.id.videoId;
      const title = video.snippet && video.snippet.title;
      if (!videoId || !title) continue;
      if (clips.find(c => c.videoId === videoId)) {
        log("Already clipped: " + title, "info");
        continue;
      }
      log("AI analyzing: " + title, "info");
      const suggestions = await analyzeWithClaude(channel, title);
      for (const s of suggestions) {
        const clip = {
          id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
          channelId: channel.id, channelName: channel.name,
          videoId, videoTitle: title, clipTitle: s.title,
          startTime: s.startTime, endTime: s.endTime,
          startSeconds: s.startSeconds || 0,
          clipLength: channel.clipLength,
          duration: channel.clipLength + "s",
          viralScore: s.viralScore, reason: s.reason, caption: s.caption,
          status: channel.autoPost ? "queued" : "ready",
          createdAt: new Date().toISOString(), postedAt: null
        };
        clips.unshift(clip);
        channel.clipsGenerated++;
        log("Clip ready: " + s.title + " Score: " + s.viralScore + "%", "success");
        if (channel.autoPost) await postClip(clip, channel);
      }
    }
  } catch (err) {
    log("Scan error: " + err.message, "error");
  }
  channel.status = "active";
}

// ================================================
// POST CLIP
// ================================================
async function postClip(clip, channel) {
  if (!channel) return;
  log("Posting: " + clip.clipTitle, "info");
  try {
    if (channel.postTo === "all" || channel.postTo === "instagram") {
      await postToInstagram(clip);
    }
    clip.status = "posted";
    clip.postedAt = new Date().toISOString();
    channel.postsPublished++;
    log("Posted: " + clip.clipTitle, "success");
  } catch (err) {
    log("Post error: " + err.message, "warn");
    clip.status = "failed";
  }
}

// ================================================
// AUTO SCAN — Every 5 minutes
// ================================================
cron.schedule("*/5 * * * *", async () => {
  const active = channels.filter(c => c.status === "active");
  if (!active.length) return;
  log("Auto-scan: " + active.length + " channel(s)", "info");
  for (const ch of active) await scanChannel(ch);
});

// ================================================
// AUTO REFRESH TOKEN — Every 50 days
// ================================================
cron.schedule("0 0 */50 * *", async () => {
  try {
    const r = await axios.get("https://graph.facebook.com/v25.0/oauth/access_token", {
      params: {
        grant_type: "fb_exchange_token",
        client_id: process.env.FACEBOOK_APP_ID,
        client_secret: process.env.FACEBOOK_APP_SECRET,
        fb_exchange_token: process.env.INSTAGRAM_ACCESS_TOKEN
      }
    });
    if (r.data.access_token) {
      process.env.INSTAGRAM_ACCESS_TOKEN = r.data.access_token;
      log("Token auto-refreshed", "success");
    }
  } catch (err) {
    log("Token refresh error: " + err.message, "warn");
  }
});

// ================================================
// START
// ================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log("ClipAgent running on port " + PORT, "success");
  console.log("ClipAgent started on port " + PORT);
});
