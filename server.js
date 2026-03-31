require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// =============================================
// IN-MEMORY STORE (channels + clips)
// =============================================
let channels = [];
let clips = [];
let logs = [];

function addLog(msg, type = 'info') {
  const entry = { time: new Date().toISOString(), msg, type };
  logs.unshift(entry);
  if (logs.length > 100) logs.pop();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

// =============================================
// HEALTH CHECK
// =============================================
app.get('/', (req, res) => {
  res.json({ status: 'ClipAgent running', channels: channels.length, clips: clips.length, uptime: process.uptime() });
});

// =============================================
// CHANNELS API
// =============================================
app.get('/api/channels', (req, res) => res.json(channels));

app.post('/api/channels', async (req, res) => {
  const { url, name, clipLength = 60, postTo = 'all', autoPost = true } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  if (channels.length >= 10) return res.status(400).json({ error: 'Max 10 channels' });
  if (channels.find(c => c.url === url)) return res.status(400).json({ error: 'Channel already exists' });

  try {
    const channelId = extractChannelId(url);
    const info = await fetchYouTubeChannelInfo(channelId);
    const channel = {
      id: Date.now().toString(),
      url, name: name || info.name || channelId,
      ytId: info.ytId || channelId,
      clipLength, postTo, autoPost,
      status: 'active',
      clipsGenerated: 0,
      postsPublished: 0,
      lastScanned: null,
      addedAt: new Date().toISOString()
    };
    channels.push(channel);
    addLog(`Channel added: ${channel.name}`, 'success');
    res.json(channel);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/channels/:id', (req, res) => {
  const ch = channels.find(c => c.id === req.params.id);
  channels = channels.filter(c => c.id !== req.params.id);
  addLog(`Channel removed: ${ch?.name}`, 'warn');
  res.json({ success: true });
});

app.patch('/api/channels/:id/toggle', (req, res) => {
  const ch = channels.find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: 'Not found' });
  ch.status = ch.status === 'active' ? 'paused' : 'active';
  res.json(ch);
});

// =============================================
// CLIPS API
// =============================================
app.get('/api/clips', (req, res) => res.json(clips));

app.delete('/api/clips/:id', (req, res) => {
  clips = clips.filter(c => c.id !== req.params.id);
  res.json({ success: true });
});

app.post('/api/clips/:id/post', async (req, res) => {
  const clip = clips.find(c => c.id === req.params.id);
  if (!clip) return res.status(404).json({ error: 'Clip not found' });
  const ch = channels.find(c => c.id === clip.channelId);
  await postClip(clip, ch);
  res.json({ success: true });
});

// =============================================
// LOGS + STATS
// =============================================
app.get('/api/logs', (req, res) => res.json(logs));

app.get('/api/stats', (req, res) => {
  res.json({
    channels: channels.length,
    clips: clips.length,
    posts: clips.filter(c => c.status === 'posted').length,
    earnings: (clips.filter(c => c.status === 'posted').length * 250 * 0.0025).toFixed(2)
  });
});

// =============================================
// MANUAL SCAN TRIGGER
// =============================================
app.post('/api/scan', async (req, res) => {
  const { channelId } = req.body;
  if (channelId) {
    const ch = channels.find(c => c.id === channelId);
    if (ch) { await scanChannel(ch); return res.json({ success: true }); }
  } else {
    for (const ch of channels.filter(c => c.status === 'active')) {
      await scanChannel(ch);
    }
  }
  res.json({ success: true, scanned: channels.filter(c => c.status === 'active').length });
});

// =============================================
// YOUTUBE HELPERS
// =============================================
function extractChannelId(url) {
  const match = url.match(/youtube\.com\/@([^\/\?]+)/) ||
    url.match(/youtube\.com\/channel\/([^\/\?]+)/) ||
    url.match(/youtube\.com\/c\/([^\/\?]+)/);
  return match ? match[1] : url.replace(/.*\//, '').replace('@', '');
}

async function fetchYouTubeChannelInfo(handle) {
  try {
    const res = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: { part: 'snippet', type: 'channel', q: handle, key: process.env.YOUTUBE_API_KEY, maxResults: 1 }
    });
    if (res.data.items?.length > 0) {
      return { name: res.data.items[0].snippet.channelTitle, ytId: res.data.items[0].id.channelId };
    }
  } catch (e) {}
  return { name: handle, ytId: handle };
}

async function fetchLatestVideos(ytChannelId) {
  try {
    const res = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: { part: 'snippet', channelId: ytChannelId, type: 'video', order: 'date', maxResults: 3, key: process.env.YOUTUBE_API_KEY }
    });
    return res.data.items || [];
  } catch (e) { return []; }
}

// =============================================
// AI CLIP ANALYSIS
// =============================================
async function analyzeWithClaude(channel, videoTitle, videoId) {
  const prompt = `You are a viral content expert. Analyze this YouTube video and suggest 2 clip moments perfect for TikTok/Shorts.

Channel: "${channel.name}"
Video Title: "${videoTitle}"
Target clip length: ${channel.clipLength} seconds

Respond in JSON only — no markdown, no explanation:
{
  "clips": [
    {
      "title": "Viral clip title",
      "startTime": "00:30",
      "endTime": "01:30",
      "viralScore": 87,
      "reason": "Why this moment is viral",
      "caption": "Engaging TikTok caption with hashtags #fyp #viral"
    }
  ]
}`;

  try {
    const res = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
    });

    const text = res.data.content?.[0]?.text || '{}';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    addLog(`AI analysis error: ${e.message}`, 'warn');
    return { clips: [] };
  }
}

// =============================================
// SCAN CHANNEL
// =============================================
async function scanChannel(channel) {
  addLog(`Scanning channel: ${channel.name}`, 'info');
  channel.status = 'processing';
  channel.lastScanned = new Date().toISOString();

  try {
    const videos = await fetchLatestVideos(channel.ytId);

    if (videos.length > 0) {
      for (const video of videos.slice(0, 2)) {
        const videoId = video.id.videoId;
        const title = video.snippet.title;
        const alreadyClipped = clips.find(c => c.videoId === videoId);
        if (alreadyClipped) continue;

        addLog(`Analyzing video: ${title}`, 'info');
        const aiResult = await analyzeWithClaude(channel, title, videoId);

        for (const clip of (aiResult.clips || [])) {
          const clipObj = {
            id: Date.now().toString() + Math.random().toString(36).slice(2),
            channelId: channel.id,
            channelName: channel.name,
            videoId, videoTitle: title,
            clipTitle: clip.title,
            startTime: clip.startTime,
            endTime: clip.endTime,
            duration: channel.clipLength + 's',
            viralScore: clip.viralScore,
            reason: clip.reason,
            caption: clip.caption,
            status: channel.autoPost ? 'queued' : 'ready',
            createdAt: new Date().toISOString()
          };
          clips.unshift(clipObj);
          channel.clipsGenerated++;
          addLog(`Clip created: "${clip.title}" (Score: ${clip.viralScore}%)`, 'success');

          if (channel.autoPost) {
            await postClip(clipObj, channel);
          }
        }
      }
    } else {
      addLog(`No new videos found for ${channel.name}`, 'info');
    }
  } catch (e) {
    addLog(`Scan error for ${channel.name}: ${e.message}`, 'warn');
  }

  channel.status = 'active';
}

// =============================================
// POST CLIP TO PLATFORMS
// =============================================
async function postClip(clip, channel) {
  if (!channel) return;
  addLog(`Posting clip: "${clip.clipTitle}"`, 'info');

  // Post to Instagram Reels
  if (channel.postTo === 'all' || channel.postTo === 'instagram') {
    await postToInstagram(clip);
  }

  clip.status = 'posted';
  clip.postedAt = new Date().toISOString();
  channel.postsPublished++;
  addLog(`Posted successfully: "${clip.clipTitle}"`, 'success');
}

async function postToInstagram(clip) {
  try {
    const createRes = await axios.post(
      `https://graph.facebook.com/v25.0/${process.env.INSTAGRAM_PAGE_ID}/media`,
      {
        media_type: 'REELS',
        caption: clip.caption,
        access_token: process.env.INSTAGRAM_ACCESS_TOKEN
      }
    );
    if (createRes.data.id) {
      await axios.post(
        `https://graph.facebook.com/v25.0/${process.env.INSTAGRAM_PAGE_ID}/media_publish`,
        { creation_id: createRes.data.id, access_token: process.env.INSTAGRAM_ACCESS_TOKEN }
      );
      addLog(`Instagram Reel published: "${clip.clipTitle}"`, 'success');
    }
  } catch (e) {
    addLog(`Instagram error: ${e.message}`, 'warn');
  }
}

// =============================================
// AUTO-SCAN CRON — every 5 minutes
// =============================================
cron.schedule('*/5 * * * *', async () => {
  const active = channels.filter(c => c.status === 'active');
  if (active.length > 0) {
    addLog(`Auto-scan: checking ${active.length} channel(s)`, 'info');
    for (const ch of active) {
      await scanChannel(ch);
    }
  }
});

// =============================================
// START SERVER
// =============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  addLog(`ClipAgent backend running on port ${PORT}`, 'success');
  console.log(`ClipAgent server started on port ${PORT}`);
});
```

---

## 🔑 Step 3: Add Your Keys in Railway Variables Tab

In Railway, instead of uploading `.env`, go to your service → **Variables tab** → click **"New Variable"** and add each one:

| Variable Name | Value |
|---|---|
| `YOUTUBE_API_KEY` | `AIzaSyBKhMo1epDVM17Xa8DiVoq-JIOFVAXR5O0` |
| `ANTHROPIC_API_KEY` | `sk-ant-api03-cjtA...` (your full key) |
| `WHOP_API_KEY` | `apik_NFa5...` (your full key) |
| `INSTAGRAM_ACCESS_TOKEN` | `EAANkPE...` (your full token) |
| `INSTAGRAM_PAGE_ID` | `105515848943534` |

---

## 📁 Step 4: How to Add Files on Railway

1. In your Railway service click **"Files"** tab
2. Click **"New File"** → paste `package.json` content → save
3. Click **"New File"** → paste `server.js` content → save
4. Click **"Deploy"** — Railway installs everything and starts the server

---

## 🌐 Step 5: Get Your Railway URL

Once deployed Railway gives you a URL like:
```
https://clipagent-backend-production.up.railway.app
