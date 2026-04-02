require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const cors = require("cors");

const app = express();
app.use(cors());
app.options("*", cors());
app.use(express.json());

let channels = [];
let clips = [];
let logs = [];

function log(msg, type) {
  if (!type) type = "info";
  var entry = { time: new Date().toISOString(), msg: msg, type: type };
  logs.unshift(entry);
  if (logs.length > 200) logs.pop();
  console.log("[" + type.toUpperCase() + "] " + msg);
}

app.get("/", function(req, res) {
  res.json({
    name: "ClipAgent Backend",
    status: "running",
    uptime_seconds: Math.floor(process.uptime()),
    channels: channels.length,
    clips: clips.length,
    posts: clips.filter(function(c) { return c.status === "posted"; }).length
  });
});

app.get("/api/stats", function(req, res) {
  var posted = clips.filter(function(c) { return c.status === "posted"; }).length;
  res.json({
    channels: channels.length,
    clips: clips.length,
    posts: posted,
    earnings: (posted * 250 * 0.0025).toFixed(2)
  });
});

app.get("/api/logs", function(req, res) {
  res.json(logs.slice(0, 50));
});

app.get("/api/channels", function(req, res) {
  res.json(channels);
});

app.post("/api/channels", async function(req, res) {
  try {
    var url = req.body.url;
    var name = req.body.name;
    var clipLength = req.body.clipLength || 60;
    var postTo = req.body.postTo || "all";
    var autoPost = req.body.autoPost !== undefined ? req.body.autoPost : true;

    if (!url) return res.status(400).json({ error: "YouTube channel URL is required" });
    if (channels.length >= 10) return res.status(400).json({ error: "Maximum of 10 channels reached" });
    if (channels.find(function(c) { return c.url === url; })) {
      return res.status(400).json({ error: "This channel is already added" });
    }

    var handle = extractHandle(url);
    var info = await getYouTubeChannelInfo(handle);

    var channel = {
      id: Date.now().toString(),
      url: url,
      name: name || info.name || handle,
      ytId: info.ytId || handle,
      clipLength: parseInt(clipLength),
      postTo: postTo,
      autoPost: Boolean(autoPost),
      status: "active",
      clipsGenerated: 0,
      postsPublished: 0,
      lastScanned: null,
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

app.delete("/api/channels/:id", function(req, res) {
  var ch = channels.find(function(c) { return c.id === req.params.id; });
  if (!ch) return res.status(404).json({ error: "Channel not found" });
  channels = channels.filter(function(c) { return c.id !== req.params.id; });
  log("Channel removed: " + ch.name, "warn");
  res.json({ success: true });
});

app.patch("/api/channels/:id/toggle", function(req, res) {
  var ch = channels.find(function(c) { return c.id === req.params.id; });
  if (!ch) return res.status(404).json({ error: "Channel not found" });
  ch.status = ch.status === "active" ? "paused" : "active";
  log("Channel " + ch.status + ": " + ch.name, "info");
  res.json(ch);
});

app.get("/api/clips", function(req, res) {
  res.json(clips);
});

app.delete("/api/clips/:id", function(req, res) {
  var clip = clips.find(function(c) { return c.id === req.params.id; });
  if (!clip) return res.status(404).json({ error: "Clip not found" });
  clips = clips.filter(function(c) { return c.id !== req.params.id; });
  log("Clip deleted: " + clip.clipTitle, "warn");
  res.json({ success: true });
});

app.post("/api/clips/:id/post", async function(req, res) {
  try {
    var clip = clips.find(function(c) { return c.id === req.params.id; });
    if (!clip) return res.status(404).json({ error: "Clip not found" });
    var ch = channels.find(function(c) { return c.id === clip.channelId; });
    await postClip(clip, ch);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/scan", async function(req, res) {
  try {
    var channelId = req.body.channelId;
    if (channelId) {
      var ch = channels.find(function(c) { return c.id === channelId; });
      if (!ch) return res.status(404).json({ error: "Channel not found" });
      await scanChannel(ch);
      return res.json({ success: true, channel: ch.name });
    }
    var active = channels.filter(function(c) { return c.status === "active"; });
    for (var i = 0; i < active.length; i++) {
      await scanChannel(active[i]);
    }
    res.json({ success: true, scanned: active.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/refresh-token", async function(req, res) {
  try {
    var refreshRes = await axios.get("https://graph.facebook.com/v25.0/oauth/access_token", {
      params: {
        grant_type: "fb_exchange_token",
        client_id: process.env.FACEBOOK_APP_ID,
        client_secret: process.env.FACEBOOK_APP_SECRET,
        fb_exchange_token: process.env.INSTAGRAM_ACCESS_TOKEN
      }
    });
    if (refreshRes.data.access_token) {
      process.env.INSTAGRAM_ACCESS_TOKEN = refreshRes.data.access_token;
      log("Instagram token refreshed", "success");
      res.json({ success: true, expires_in: refreshRes.data.expires_in });
    } else {
      res.status(400).json({ error: "Could not refresh token" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/instagram/setup", async function(req, res) {
  try {
    var token = process.env.INSTAGRAM_ACCESS_TOKEN;
    var pageId = process.env.INSTAGRAM_PAGE_ID;
    var r = await axios.get(
      "https://graph.facebook.com/v25.0/" + pageId + "?fields=instagram_business_account&access_token=" + token
    );
    if (r.data.instagram_business_account) {
      var igId = r.data.instagram_business_account.id;
      process.env.INSTAGRAM_BUSINESS_ID = igId;
      log("Instagram Business ID: " + igId, "success");
      res.json({ success: true, instagram_business_id: igId });
    } else {
      res.json({ success: false, message: "No Instagram Business account linked to this Facebook Page" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function extractHandle(url) {
  var m = url.match(/youtube\.com\/@([^\/\?&]+)/) ||
    url.match(/youtube\.com\/channel\/([^\/\?&]+)/) ||
    url.match(/youtube\.com\/c\/([^\/\?&]+)/) ||
    url.match(/youtube\.com\/user\/([^\/\?&]+)/);
  return m ? m[1] : url.replace(/.*\//, "").replace("@", "");
}

async function getYouTubeChannelInfo(handle) {
  try {
    var res = await axios.get("https://www.googleapis.com/youtube/v3/search", {
      params: {
        part: "snippet",
        type: "channel",
        q: handle,
        maxResults: 1,
        key: process.env.YOUTUBE_API_KEY
      }
    });
    if (res.data.items && res.data.items.length > 0) {
      return {
        name: res.data.items[0].snippet.channelTitle,
        ytId: res.data.items[0].id.channelId
      };
    }
  } catch (err) {
    log("YouTube info error: " + err.message, "warn");
  }
  return { name: handle, ytId: handle };
}

async function getLatestVideos(ytChannelId) {
  try {
    var res = await axios.get("https://www.googleapis.com/youtube/v3/search", {
      params: {
        part: "snippet",
        channelId: ytChannelId,
        type: "video",
        order: "date",
        maxResults: 3,
        key: process.env.YOUTUBE_API_KEY
      }
    });
    return res.data.items || [];
  } catch (err) {
    log("Fetch videos error: " + err.message, "warn");
    return [];
  }
}

async function analyzeWithClaude(channel, videoTitle) {
  var prompt = "You are a viral short-form content expert.\n\n" +
    "Channel: \"" + channel.name + "\"\n" +
    "Video Title: \"" + videoTitle + "\"\n" +
    "Target clip length: " + channel.clipLength + " seconds\n\n" +
    "Suggest the 2 best clip moments for TikTok, Instagram Reels, and YouTube Shorts.\n\n" +
    "Respond ONLY in raw JSON with no markdown:\n" +
    "{\"clips\":[{\"title\":\"clip title\",\"startTime\":\"00:45\",\"endTime\":\"01:45\",\"viralScore\":91,\"reason\":\"why viral\",\"caption\":\"caption #fyp #viral\"}]}";

  try {
    var res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }]
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json"
        }
      }
    );
    var raw = (res.data.content && res.data.content[0]) ? res.data.content[0].text : "{}";
    var clean = raw.replace(/```json|```/g, "").trim();
    var parsed = JSON.parse(clean);
    return parsed.clips || [];
  } catch (err) {
    log("Claude AI error: " + err.message, "warn");
    return [];
  }
}

async function scanChannel(channel) {
  log("Scanning: " + channel.name, "info");
  channel.status = "processing";
  channel.lastScanned = new Date().toISOString();

  try {
    var videos = await getLatestVideos(channel.ytId);

    if (videos.length === 0) {
      log("No videos found for: " + channel.name, "info");
      channel.status = "active";
      return;
    }

    for (var v = 0; v < Math.min(videos.length, 2); v++) {
      var video = videos[v];
      var videoId = video.id && video.id.videoId;
      var title = video.snippet && video.snippet.title;
      if (!videoId || !title) continue;

      var alreadyClipped = clips.find(function(c) { return c.videoId === videoId; });
      if (alreadyClipped) {
        log("Already clipped: " + title, "info");
        continue;
      }

      log("AI analyzing: " + title, "info");
      var suggestions = await analyzeWithClaude(channel, title);

      for (var s = 0; s < suggestions.length; s++) {
        var suggestion = suggestions[s];
        var clip = {
          id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
          channelId: channel.id,
          channelName: channel.name,
          videoId: videoId,
          videoTitle: title,
          clipTitle: suggestion.title,
          startTime: suggestion.startTime,
          endTime: suggestion.endTime,
          duration: channel.clipLength + "s",
          viralScore: suggestion.viralScore,
          reason: suggestion.reason,
          caption: suggestion.caption,
          status: channel.autoPost ? "queued" : "ready",
          createdAt: new Date().toISOString(),
          postedAt: null
        };

        clips.unshift(clip);
        channel.clipsGenerated++;
        log("Clip ready: \"" + suggestion.title + "\" Score: " + suggestion.viralScore + "%", "success");

        if (channel.autoPost) {
          await postClip(clip, channel);
        }
      }
    }
  } catch (err) {
    log("Scan error for " + channel.name + ": " + err.message, "error");
  }

  channel.status = "active";
}

async function postClip(clip, channel) {
  if (!channel) return;
  log("Posting: \"" + clip.clipTitle + "\"", "info");

  if (channel.postTo === "all" || channel.postTo === "instagram") {
    await postToInstagram(clip);
  }

  clip.status = "posted";
  clip.postedAt = new Date().toISOString();
  channel.postsPublished++;
  log("Posted: \"" + clip.clipTitle + "\"", "success");
}

async function postToInstagram(clip) {
  try {
    var igId = process.env.INSTAGRAM_BUSINESS_ID || process.env.INSTAGRAM_PAGE_ID;
    var token = process.env.INSTAGRAM_ACCESS_TOKEN;

    var thumbUrl = (clip.videoId && clip.videoId !== "demo")
      ? "https://img.youtube.com/vi/" + clip.videoId + "/maxresdefault.jpg"
      : null;

    if (!thumbUrl) {
      log("Instagram skip — no thumbnail for: " + clip.clipTitle, "info");
      return false;
    }

    var caption = clip.caption + "\n\nClip: " + clip.clipTitle + "\nScore: " + clip.viralScore + "%";

    var create = await axios.post(
      "https://graph.facebook.com/v25.0/" + igId + "/media",
      {
        image_url: thumbUrl,
        caption: caption,
        access_token: token
      }
    );

    if (create.data.id) {
      await new Promise(function(r) { setTimeout(r, 3000); });
      var publish = await axios.post(
        "https://graph.facebook.com/v25.0/" + igId + "/media_publish",
        {
          creation_id: create.data.id,
          access_token: token
        }
      );
      if (publish.data.id) {
        log("Instagram post published: \"" + clip.clipTitle + "\"", "success");
        return true;
      }
    }
  } catch (err) {
    var errMsg = (err.response && err.response.data && err.response.data.error)
      ? err.response.data.error.message
      : err.message;
    log("Instagram error: " + errMsg, "warn");
    return false;
  }
}

cron.schedule("*/5 * * * *", async function() {
  var active = channels.filter(function(c) { return c.status === "active"; });
  if (active.length === 0) return;
  log("Auto-scan: " + active.length + " channel(s)", "info");
  for (var i = 0; i < active.length; i++) {
    await scanChannel(active[i]);
  }
});

cron.schedule("0 0 */50 * *", async function() {
  try {
    log("Auto-refreshing Instagram token...", "info");
    var res = await axios.get("https://graph.facebook.com/v25.0/oauth/access_token", {
      params: {
        grant_type: "fb_exchange_token",
        client_id: process.env.FACEBOOK_APP_ID,
        client_secret: process.env.FACEBOOK_APP_SECRET,
        fb_exchange_token: process.env.INSTAGRAM_ACCESS_TOKEN
      }
    });
    if (res.data.access_token) {
      process.env.INSTAGRAM_ACCESS_TOKEN = res.data.access_token;
      log("Instagram token auto-refreshed", "success");
    }
  } catch (err) {
    log("Token refresh error: " + err.message, "warn");
  }
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  log("ClipAgent running on port " + PORT, "success");
  console.log("ClipAgent server started on port " + PORT);
});
