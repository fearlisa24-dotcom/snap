// Serverless Stories Endpoint for Vercel (/api/stories)
// Handles: Uploading stories, fetching active stories (<24h), automatic expiration purge
const { supabaseAdmin, supabasePublic } = require("./supabase");

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

// In-memory fallback for local preview or demo stories
let MEMORY_STORIES = [
  {
    id: "story_demo_lo",
    user_id: "106c7c59-8682-47ee-888b-5e0cfb75204d",
    username: "lo_writer",
    fullName: "LO (Novelist)",
    avatar: "✍️",
    media_url: "assets/camera-home-bg.jpg",
    media_type: "image",
    caption: "Midnight chapters & cold coffee ☕✨",
    created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    expires_at: new Date(Date.now() + 22 * 60 * 60 * 1000).toISOString()
  }
];

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  const nowIso = new Date().toISOString();
  const nowMs = Date.now();

  // 1. GET: Fetch active (unexpired) stories
  if (req.method === "GET") {
    try {
      // Query from Supabase 'stories' table if available
      const { data: dbStories, error } = await supabaseAdmin
        .from("stories")
        .select("id, user_id, username, full_name, avatar, media_url, media_type, caption, audience, created_at, expires_at")
        .gt("expires_at", nowIso)
        .order("created_at", { ascending: false });

      if (!error && dbStories && dbStories.length > 0) {
        return res.status(200).json({
          success: true,
          source: "supabase",
          stories: dbStories
        });
      }
    } catch (err) {
      console.warn("Supabase stories query fallback:", err);
    }

    // Filter memory stories to active ones
    const activeMem = MEMORY_STORIES.filter(s => new Date(s.expires_at).getTime() > nowMs);
    return res.status(200).json({
      success: true,
      source: "memory",
      stories: activeMem
    });
  }

  // 2. POST: Upload and record new story
  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch (e) {}
    }
    body = body || {};

    const userId = body.userId || body.user_id || "guest";
    const username = body.username || "user";
    const fullName = body.fullName || body.full_name || username;
    const avatar = body.avatar || "👤";
    const mediaUrl = body.mediaUrl || body.media_url || "";
    const mediaType = body.mediaType || body.media_type || "image";
    const caption = body.caption || "";
    const audience = body.audience || "friends";

    if (!mediaUrl) {
      return res.status(400).json({ success: false, error: "media_url is required to post a story." });
    }

    const createdAt = new Date().toISOString();
    const expiresAt = new Date(nowMs + TWENTY_FOUR_HOURS_MS).toISOString();
    const storyId = body.id || ("story_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6));

    const newStoryRecord = {
      id: storyId,
      user_id: userId,
      username: username,
      full_name: fullName,
      avatar: avatar,
      media_url: mediaUrl,
      media_type: mediaType,
      caption: caption,
      audience: audience,
      created_at: createdAt,
      expires_at: expiresAt
    };

    let savedToDb = false;
    try {
      const { error: insertErr } = await supabaseAdmin
        .from("stories")
        .insert([newStoryRecord]);

      if (!insertErr) {
        savedToDb = true;
      } else {
        console.warn("Could not insert story to Supabase:", insertErr.message);
      }
    } catch (dbErr) {
      console.warn("Supabase stories insert exception:", dbErr);
    }

    MEMORY_STORIES.unshift(newStoryRecord);

    return res.status(201).json({
      success: true,
      source: savedToDb ? "supabase" : "memory",
      message: "Story uploaded! Will expire in 24 hours.",
      story: newStoryRecord
    });
  }

  return res.status(405).json({ success: false, error: "Method not allowed" });
};
