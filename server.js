require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// ================================================
// IN-MEMORY DATA STORE
// ================================================
let channels = [];
let clips = [];
let logs = [];

function log(msg, type = "info") {
  const entry = { time: new Date().toISOString(), msg, type };
  logs.unshift(entry);
  if (logs.length > 200) logs.pop();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

// ================================================
// ROOT — Health Check
// ================================================
app.get("/", (req, res) => {
  res.json({
    name: "ClipAgent Backend",
    status: "running",
    uptime_seconds: Math.floor(process.uptime()),
    channels: channels.length,
    clips: clips.length,
    posts: clips.filter((c) => c.status === "posted").length,
  });
});

// ================================================
// STATS
// ================================================
app.get("/api/stats", (req, res) => {
  const posted = clips.filter((c) => c.status === "posted").length;
  res.json({
    channels: channels.length,
    clips: clips.length,
    posts: posted,
    earnings: (posted * 250 * 0.0025).toFixed(2),
  });
});

// ================================================
// LOGS
// ================================================
app.get("/api/logs", (req, res) => {
  res.json(logs.slice(0, 50));
});

// ================================================
// CHANNELS — Get All
// ================================================
app.get("/api/channels", (req, res) => {
  res.json(channels);
});

// ================================================
// CHANNELS — Add New (max 10)
// ================================================
app.post("/api/channels", async (req, res) => {
  try {
    const { url, name, clipLength = 60, postTo = "all", autoPost = true } = req.body;

    if (!url) return res.status(400).json({ error: "YouTube channel URL is required" });
    if (channels.length >= 10) return res.status(400).json({ error: "Maximum of 10 channels reached" });
    if (channels.find((c) => c.url === url)) return res.status(400).json({ error: "This channel is already added" });

    const handle = extractHandle(url);
    const info = await getYouTubeChannelInfo(handle);

    const channel = {
      id: Date.now().toString(),
      url,
      name: name || info.name || handle,
      ytId: info.ytId || handle,
      clipLength: parseInt(clipLength),
      postTo,
      autoPost: Boolean(autoPost),
      status: "active",
      clipsGenerated: 0,
      postsPublished: 0,
      lastScanned: null,
      addedAt: new Date().toISOString(),
    };

    channels.push(channel);
    log(`Channel added: ${channel.name}`, "success");
    res.json(channel);
  } catch (err) {
    log(`Add channel error: ${err.message}`, "error");
    res.status(500).json({ error: err.message });
  }
});

// ================================================
// CHANNELS — Delete
// ================================================
app.delete("/api/channels/:id", (req, res) => {
  const ch = channels.find((c) => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: "Channel not found" });
  channels = channels.filter((c) => c.id !== req.params.id);
  log(`Channel removed: ${ch.name}`, "warn");
  res.json({ success: true });
});

// ================================================
// CHANNELS — Pause / Resume Toggle
// ================================================
app.patch("/api/channels/:id/toggle", (req, res) => {
  const ch = channels.find((c) => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: "Channel not found" });
  ch.status = ch.status === "active" ? "paused" : "active";
  log(`Channel ${ch.status}: ${ch.name}`, "info");
  res.json(ch);
});

// ================================================
// CLIPS — Get All
// ================================================
app.get("/api/clips", (req, res) => {
  res.json(clips);
});

// ================================================
// CLIPS — Delete
// ================================================
app.delete("/api/clips/:id", (req, res) => {
  const clip = clips.find((c) => c.id === req.params.id);
  if (!clip) return res.status(404).json({ error: "Clip not found" });
  clips = clips.filter((c) => c.id !== req.params.id);
  log(`Clip deleted: ${clip.clipTitle}`, "warn");
  res.json({ success: true });
});

// ================================================
// CLIPS — Manually Post a Clip
// ================================================
app.post("/api/clips/:id/post", async (req, res) => {
  try {
    const clip = clips.find((c) => c.id === req.params.id);
    if (!clip) return res.status(404).json({ error: "Clip not found" });
    const ch = channels.find((c) => c.id === clip.channelId);
    await postClip(clip, ch);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================
// SCAN — Trigger Manually
// ================================================
app.post("/api/scan", async (req, res) => {
  try {
    const { channelId } = req.body;
    if (channelId) {
      const ch = channels.find((c) => c.id === channelId);
      if (!ch) return res.status(404).json({ error: "Channel not found" });
      await scanChannel(ch);
      return res.json({ success: true, channel: ch.name });
    }
    const active = channels.filter((c) => c.status === "active");
    for (const ch of active) await scanChannel(ch);
    res.json({ success: true, scanned: active.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================
// YOUTUBE — Extract handle from URL
// ================================================
function extractHandle(url) {
  const m =
    url.match(/youtube\.com\/@([^\/\?&]+)/) ||
    url.match(/youtube\.com\/channel\/([^\/\?&]+)/) ||
    url.match(/youtube\.com\/c\/([^\/\?&]+)/) ||
    url.match(/youtube\.com\/user\/([^\/\?&]+)/);
  return m ? m[1] : url.replace(/.*\//, "").replace("@", "");
}

// ================================================
// YOUTUBE — Fetch Channel Info
// ================================================
async function getYouTubeChannelInfo(handle) {
  try {
    const res = await axios.get("https://www.googleapis.com/youtube/v3/search", {
      params: {
        part: "snippet",
        type: "channel",
        q: handle,
        maxResults: 1,
        key: process.env.YOUTUBE_API_KEY,
      },
    });
    if (res.data.items && res.data.items.length > 0) {
      return {
        name: res.data.items[0].snippet.channelTitle,
        ytId: res.data.items[0].id.channelId,
      };
    }
  } catch (err) {
    log(`YouTube info error: ${err.message}`, "warn");
  }
  return { name: handle, ytId: handle };
}

// ================================================
// YOUTUBE — Fetch Latest Videos
// ================================================
async function getLatestVideos(ytChannelId) {
  try {
    const res = await axios.get("https://www.googleapis.com/youtube/v3/search", {
      params: {
        part: "snippet",
        channelId: ytChannelId,
        type: "video",
        order: "date",
        maxResults: 3,
        key: process.env.YOUTUBE_API_KEY,
      },
    });
    return res.data.items || [];
  } catch (err) {
    log(`Fetch videos error: ${err.message}`, "warn");
    return [];
  }
}

// ================================================
// CLAUDE AI — Analyze Video & Suggest Clips
// ================================================
async function analyzeWithClaude(channel, videoTitle) {
  const prompt = `You are a viral short-form content expert.

A YouTube channel called "${channel.name}" just uploaded a video titled: "${videoTitle}"
Target clip length: ${channel.clipLength} seconds

Suggest the 2 best clip moments for TikTok, Instagram Reels, and YouTube Shorts.

Respond ONLY in raw JSON with no markdown or explanation:
{
  "clips": [
    {
      "title": "Short punchy clip title",
      "startTime": "00:45",
      "endTime": "01:45",
      "viralScore": 91,
      "reason": "Why this moment is viral",
      "caption": "Engaging caption with hashtags #fyp #viral #shorts"
    },
    {
      "title": "Second clip title",
      "startTime": "05:10",
      "endTime": "06:10",
      "viralScore": 83,
      "reason": "Why this moment is viral",
      "caption": "Another caption #trending #creator"
    }
  ]
}`;

  try {
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
      }
    );

    const raw = res.data.content?.[0]?.text || "{}";
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    return parsed.clips || [];
  } catch (err) {
    log(`Claude AI error: ${err.message}`, "warn");
    return [];
  }
}

// ================================================
// SCAN CHANNEL — Detect new videos and clip them
// ================================================
async function scanChannel(channel) {
  log(`Scanning: ${channel.name}`, "info");
  channel.status = "processing";
  channel.lastScanned = new Date().toISOString();

  try {
    const videos = await getLatestVideos(channel.ytId);

    if (videos.length === 0) {
      log(`No videos found for: ${channel.name}`, "info");
      channel.status = "active";
      return;
    }

    for (const video of videos.slice(0, 2)) {
      const videoId = video.id?.videoId;
      const title = video.snippet?.title;
      if (!videoId || !title) continue;

      // Skip already clipped videos
      if (clips.find((c) => c.videoId === videoId)) {
        log(`Already clipped: ${title}`, "info");
        continue;
      }

      log(`AI analyzing: ${title}`, "info");
      const suggestions = await analyzeWithClaude(channel, title);

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
          duration: channel.clipLength + "s",
          viralScore: s.viralScore,
          reason: s.reason,
          caption: s.caption,
          status: channel.autoPost ? "queued" : "ready",
          createdAt: new Date().toISOString(),
          postedAt: null,
        };

        clips.unshift(clip);
        channel.clipsGenerated++;
        log(`Clip ready: "${s.title}" — Score: ${s.viralScore}%`, "success");

        if (channel.autoPost) {
          await postClip(clip, channel);
        }
      }
    }
  } catch (err) {
    log(`Scan error for ${channel.name}: ${err.message}`, "error");
  }

  channel.status = "active";
}

// ================================================
// POST CLIP — Distribute to platforms
// ================================================
async function postClip(clip, channel) {
  if (!channel) return;
  log(`Posting: "${clip.clipTitle}"`, "info");

  if (channel.postTo === "all" || channel.postTo === "instagram") {
    await postToInstagram(clip);
  }

  // TikTok — enabled once API approved
  // if (channel.postTo === "all" || channel.postTo === "tiktok") {
  //   await postToTikTok(clip);
  // }

  clip.status = "posted";
  clip.postedAt = new Date().toISOString();
  channel.postsPublished++;
  log(`Posted: "${clip.clipTitle}"`, "success");
}

// ================================================
// INSTAGRAM — Publish Reel
// NOTE: Requires a public video URL to post
// We post as IMAGE with thumbnail if no video URL
// or queue it for when video is available
// ================================================
async function postToInstagram(clip) {
  try {
    const igId = process.env.INSTAGRAM_BUSINESS_ID || process.env.INSTAGRAM_PAGE_ID;
    const token = process.env.INSTAGRAM_ACCESS_TOKEN;
    const videoUrl = clip.videoUrl || null;

    if (!videoUrl) {
      // No video URL yet — post as a text/image update instead
      // using a YouTube thumbnail as the image
      const thumbUrl = clip.videoId && clip.videoId !== "demo"
        ? `https://img.youtube.com/vi/${clip.videoId}/maxresdefault.jpg`
        : null;

      if (thumbUrl) {
        // Post as IMAGE with clip caption and thumbnail
        const create = await axios.post(
          `https://graph.facebook.com/v25.0/${igId}/media`,
          {
            image_url: thumbUrl,
            caption: `${clip.caption}\n\n🎬 New clip: ${clip.clipTitle}\n⏱ ${clip.startTime} - ${clip.endTime}\n🔥 Viral Score: ${clip.viralScore}%`,
            access_token: token,
          }
        );

        if (create.data.id) {
          // Wait 3 seconds for media to process
          await new Promise(r => setTimeout(r, 3000));

          const publish = await axios.post(
            `https://graph.facebook.com/v25.0/${igId}/media_publish`,
            {
              creation_id: create.data.id,
              access_token: token,
            }
          );

          if (publish.data.id) {
            log(`Instagram image post published: "${clip.clipTitle}"`, "success");
            return true;
          }
        }
      } else {
        log(`Instagram skip — no video URL or thumbnail for: "${clip.clipTitle}"`, "info");
        return false;
      }
    } else {
      // Post as full REEL with video URL
      const create = await axios.post(
        `https://graph.facebook.com/v25.0/${igId}/media`,
        {
          media_type: "REELS",
          video_url: videoUrl,
          caption: clip.caption,
          access_token: token,
        }
      );

      if (create.data.id) {
        // Poll until video is processed (up to 60 seconds)
        let ready = false;
        for (let i = 0; i < 12; i++) {
          await new Promise(r => setTimeout(r, 5000));
          const status = await axios.get(
            `https://graph.facebook.com/v25.0/${create.data.id}?fields=status_code&access_token=${token}`
          );
          if (status.data.status_code === "FINISHED") { ready = true; break; }
          if (status.data.status_code === "ERROR") { break; }
        }

        if (ready) {
          await axios.post(
            `https://graph.facebook.com/v25.0/${igId}/media_publish`,
            { creation_id: create.data.id, access_token: token }
          );
          log(`Instagram Reel posted: "${clip.clipTitle}"`, "success");
          return true;
        }
      }
    }
  } catch (err) {
    log(`Instagram error: ${err.response?.data?.error?.message || err.message}`, "warn");
    return false;
  }
}

// ================================================
// GET INSTAGRAM BUSINESS ACCOUNT ID
// ================================================
app.get("/api/instagram/setup", async (req, res) => {
  try {
    const token = process.env.INSTAGRAM_ACCESS_TOKEN;
    const pageId = process.env.INSTAGRAM_PAGE_ID;

    const r = await axios.get(
      `https://graph.facebook.com/v25.0/${pageId}?fields=instagram_business_account&access_token=${token}`
    );

    if (r.data.instagram_business_account) {
      const igId = r.data.instagram_business_account.id;
      process.env.INSTAGRAM_BUSINESS_ID = igId;
      log(`Instagram Business ID found: ${igId}`, "success");
      res.json({ success: true, instagram_business_id: igId, message: "Add this as INSTAGRAM_BUSINESS_ID in Railway variables" });
    } else {
      res.json({ success: false, message: "No Instagram Business account linked to this Facebook Page. Please connect Instagram to your Meow Moods Facebook page first." });
    }
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ================================================
// AUTO SCAN — Every 5 minutes
// ================================================
cron.schedule("*/5 * * * *", async () => {
  const active = channels.filter((c) => c.status === "active");
  if (active.length === 0) return;
  log(`Auto-scan triggered: ${active.length} channel(s)`, "info");
  for (const ch of active) {
    await scanChannel(ch);
  }
});

// ================================================
// AUTO REFRESH INSTAGRAM TOKEN — Every 50 days
// ================================================
cron.schedule("0 0 */50 * *", async () => {
  try {
    log("Refreshing Instagram access token...", "info");
    const res = await axios.get("https://graph.facebook.com/v25.0/oauth/access_token", {
      params: {
        grant_type: "fb_exchange_token",
        client_id: process.env.FACEBOOK_APP_ID,
        client_secret: process.env.FACEBOOK_APP_SECRET,
        fb_exchange_token: process.env.INSTAGRAM_ACCESS_TOKEN,
      },
    });
    if (res.data.access_token) {
      process.env.INSTAGRAM_ACCESS_TOKEN = res.data.access_token;
      log("Instagram token auto-refreshed successfully ✅", "success");
    }
  } catch (err) {
    log(`Instagram token refresh error: ${err.message}`, "warn");
  }
});

// ================================================
// MANUAL TOKEN REFRESH ENDPOINT
// ================================================
app.post("/api/refresh-token", async (req, res) => {
  try {
    const refreshRes = await axios.get("https://graph.facebook.com/v25.0/oauth/access_token", {
      params: {
        grant_type: "fb_exchange_token",
        client_id: process.env.FACEBOOK_APP_ID,
        client_secret: process.env.FACEBOOK_APP_SECRET,
        fb_exchange_token: process.env.INSTAGRAM_ACCESS_TOKEN,
      },
    });
    if (refreshRes.data.access_token) {
      process.env.INSTAGRAM_ACCESS_TOKEN = refreshRes.data.access_token;
      log("Instagram token manually refreshed ✅", "success");
      res.json({ success: true, expires_in: refreshRes.data.expires_in });
    } else {
      res.status(400).json({ error: "Could not refresh token" });
    }
  } catch (err) {
    log(`Manual token refresh error: ${err.message}`, "warn");
    res.status(500).json({ error: err.message });
  }
});

// ================================================
// START
// ================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`ClipAgent running on port ${PORT}`, "success");
  console.log(`ClipAgent server started — port ${PORT}`);
});
