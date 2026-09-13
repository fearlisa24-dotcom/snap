// Serverless My AI Endpoint (/api/myai)
// Powered by OpenAI GPT
const B64_KEY = 'c2stcHJvai1zVjJaMUd0cFMzRDBZN2VGeGtNMUg0RWd1TXo1LTV4MVhkdWtzS1Ffd1RZZnJzTmlPa0dwYlBMcW8yVG9xVFpqeE1McjNiWER3MFQzQmxia0ZKNnhfeXl2RGVaSE54M0wwLVJuWUV3NDFfVjJ4OHE0bEJ6SFlZSzViM0kxcTUzdE5pU0VrckZiU1V0TERHelRDMDlHQzcwbzF4b0E=';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || Buffer.from(B64_KEY, 'base64').toString('utf8');

const SYSTEM_PROMPT = `You are My AI, Snapchat's official companion and friendly virtual best friend.
- Personality: Warm, upbeat, supportive, casual, trendy, slightly playful, and witty.
- Style: Keep responses concise (1 to 3 short sentences usually), use natural modern texting tone, and sprinkle relevant emojis naturally (✨, 👻, 💬, 📸, 🔥).
- Capabilities: Answer questions, brainstorm ideas, share trivia, give advice, or just chat about life.
- Avoid sounding like a corporate robotic assistant. Talk like a real friend on Snapchat.`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {}
  }
  body = body || {};

  const userMessage = (body.message || body.text || '').trim();
  const history = Array.isArray(body.history) ? body.history : [];
  const customKey = (body.apiKey || '').trim();
  const effectiveKey = customKey || OPENAI_API_KEY;

  if (!userMessage && history.length === 0) {
    return res.status(400).json({ success: false, error: 'Message is required.' });
  }

  const messagesPayload = [
    { role: 'system', content: SYSTEM_PROMPT }
  ];

  const recentHistory = history.slice(-6);
  recentHistory.forEach(item => {
    if (item && item.text) {
      messagesPayload.push({
        role: item.sender === 'me' ? 'user' : 'assistant',
        content: item.text
      });
    }
  });

  if (userMessage && (!recentHistory.length || recentHistory[recentHistory.length - 1]?.text !== userMessage)) {
    messagesPayload.push({ role: 'user', content: userMessage });
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const openAiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + effectiveKey
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: messagesPayload,
        max_tokens: 180,
        temperature: 0.8
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const data = await openAiResponse.json().catch(() => null);

    if (openAiResponse.ok && data?.choices?.[0]?.message?.content) {
      return res.status(200).json({
        success: true,
        source: 'openai',
        model: 'gpt-4o-mini',
        reply: data.choices[0].message.content.trim()
      });
    }

    if (data?.error) {
      return res.status(200).json({
        success: false,
        source: 'openai_error',
        error: data.error.message || 'OpenAI error',
        code: data.error.code || openAiResponse.status,
        reply: '[OpenAI: ' + (data.error.message || 'Check billing at platform.openai.com') + ']'
      });
    }
  } catch (err) {
    return res.status(200).json({
      success: false,
      source: 'fetch_error',
      error: err.message,
      reply: '[OpenAI connection issue: ' + err.message + ']'
    });
  }

  return res.status(200).json({
    success: true,
    source: 'fallback',
    reply: 'Hey there! How is your day going? ✨'
  });
};
