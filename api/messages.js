// Serverless Chat & 12-Hour Disappearing Snaps Endpoint for Vercel (/api/messages)
// Handles: Sending messages/snaps, Fetching chat history, Server-side 12-hour TTL expiration purge

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const { supabaseAdmin } = require("./supabase");

// Persistent conversation message store (Only My AI gets demo starter text)
let MESSAGES_DB = {
  myai: [
    { type: 'unsupported' },
    {
      type: 'voicenote',
      sender: 'me',
      duration: '0:02',
      time: '4:19 PM'
    },
    {
      type: 'text',
      sender: 'friend',
      text: "Hey! I'm My AI, your SnapTok personal companion. Ask me anything or send me snaps!",
      time: '4:21 PM'
    }
  ]
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const now = Date.now();

  // 1. Purge all expired snaps on server side
  Object.keys(MESSAGES_DB).forEach(chatId => {
    MESSAGES_DB[chatId].forEach(msg => {
      if (msg.type === 'snap' && msg.status !== 'expired') {
        if (msg.expiresAt && now >= msg.expiresAt) {
          msg.status = 'expired';
        }
      }
    });
  });

  // Helper to resolve any username, handle, email, or UUID into a valid Supabase Auth UUID
  async function resolveUUID(identifier, allUsers) {
    if (!identifier) return null;
    const str = String(identifier).trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)) {
      return str;
    }
    const lower = str.toLowerCase();
    const clean = lower.replace(/[^a-z0-9_]/g, '');
    const match = (allUsers || []).find(u => {
      const uName = (u.user_metadata?.username || '').toLowerCase();
      const uFull = (u.user_metadata?.full_name || '').toLowerCase();
      const uEmail = (u.email || '').toLowerCase();
      return uName === lower || uName === clean ||
             uFull === lower ||
             uEmail === lower || uEmail.startsWith(lower + '@') || uEmail.startsWith(clean + '@') ||
             u.id.toLowerCase() === lower;
    });
    return match ? match.id : null;
  }

  // GET: Fetch messages for chat
  if (req.method === 'GET') {
    const chatId = (req.query.chatId || 'myai').toLowerCase();
    const senderIdParam = req.query.senderId;
    const receiverIdParam = req.query.receiverId;

    if (senderIdParam && receiverIdParam) {
      try {
        const { data: listU } = await supabaseAdmin.auth.admin.listUsers();
        const allUsers = listU?.users || [];

        const finalSenderId = await resolveUUID(senderIdParam, allUsers);
        const finalReceiverId = await resolveUUID(receiverIdParam, allUsers);

        if (finalSenderId && finalReceiverId) {
          const { data: dbMsgs, error: queryErr } = await supabaseAdmin
            .from('messages')
            .select('id, sender_id, receiver_id, content, created_at')
            .or(`and(sender_id.eq.${finalSenderId},receiver_id.eq.${finalReceiverId}),and(sender_id.eq.${finalReceiverId},receiver_id.eq.${finalSenderId})`)
            .order('created_at', { ascending: true });

          if (!queryErr && dbMsgs && dbMsgs.length > 0) {
            const formatted = dbMsgs.map(m => {
              const isMe = (m.sender_id === finalSenderId || m.sender_id === senderIdParam);
              let rawContent = m.content;

              if (typeof rawContent === 'string') {
                if (rawContent.startsWith('{"type":"snap"')) {
                  try {
                    const snapObj = JSON.parse(rawContent);
                    return {
                      id: m.id,
                      sender_id: m.sender_id,
                      type: 'snap',
                      sender: isMe ? 'me' : 'friend',
                      status: isMe ? 'delivered' : (snapObj.status || 'unread'),
                      title: snapObj.title || 'Camera Snap 📸',
                      content: snapObj.content || 'Photo snapped from web camera view!',
                      image: snapObj.image || null,
                      time: new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
                      sentAt: snapObj.sentAt || new Date(m.created_at).getTime(),
                      expiresAt: snapObj.expiresAt || (new Date(m.created_at).getTime() + TWELVE_HOURS_MS),
                      replyTo: snapObj.replyTo || null
                    };
                  } catch (e) {}
                } else if (rawContent.startsWith('{"type":"image"')) {
                  try {
                    const imgObj = JSON.parse(rawContent);
                    return {
                      id: m.id,
                      sender_id: m.sender_id,
                      type: 'image',
                      sender: isMe ? 'me' : 'friend',
                      image: imgObj.image || null,
                      text: imgObj.text || 'Photo',
                      time: new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
                      replyTo: imgObj.replyTo || null
                    };
                  } catch (e) {}
                } else if (rawContent.startsWith('{"type":"voicenote"')) {
                  try {
                    const vnObj = JSON.parse(rawContent);
                    return {
                      id: m.id,
                      sender_id: m.sender_id,
                      type: 'voicenote',
                      sender: isMe ? 'me' : 'friend',
                      audio: vnObj.audio || null,
                      duration: vnObj.duration || '0:03',
                      time: new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
                      replyTo: vnObj.replyTo || null
                    };
                  } catch (e) {}
                }
              }

              return {
                id: m.id,
                sender_id: m.sender_id,
                type: 'text',
                sender: isMe ? 'me' : 'friend',
                text: rawContent,
                time: new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
              };
            });
            return res.status(200).json({ success: true, chatId: chatId, messages: formatted });
          }
        }
      } catch (err) {
        console.warn('Supabase messages query fallback:', err);
      }
    }

    const list = MESSAGES_DB[chatId] || [];
    return res.status(200).json({ success: true, chatId: chatId, messages: list });
  }

  // POST: Send new message or snap
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {}
    }
    body = body || {};

    const chatId = (body.chatId || 'myai').toLowerCase();
    if (!MESSAGES_DB[chatId]) MESSAGES_DB[chatId] = [];

    const nowTime = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    // Also persist directly into Supabase messages table if human IDs provided
    if (body.senderId && body.receiverId && (body.text || body.content)) {
      try {
        const { data: listU } = await supabaseAdmin.auth.admin.listUsers();
        const allUsers = listU?.users || [];
        const finalSenderId = await resolveUUID(body.senderId, allUsers);
        const finalReceiverId = await resolveUUID(body.receiverId, allUsers);

        // Action: Mark Snap Opened in Database
        if (body.action === 'mark_opened' && body.snapId) {
          // Find message matching snapId and update its status
          const { data: matchingMsgs } = await supabaseAdmin
            .from('messages')
            .select('id, content')
            .or(`and(sender_id.eq.${finalSenderId},receiver_id.eq.${finalReceiverId}),and(sender_id.eq.${finalReceiverId},receiver_id.eq.${finalSenderId})`)
            .ilike('content', `%"${body.snapId}"%`);

          if (matchingMsgs && matchingMsgs.length > 0) {
            for (const row of matchingMsgs) {
              try {
                const parsed = JSON.parse(row.content);
                parsed.status = 'opened';
                parsed.openedAt = Date.now();
                await supabaseAdmin
                  .from('messages')
                  .update({ content: JSON.stringify(parsed) })
                  .eq('id', row.id);
              } catch (_) {}
            }
            return res.status(200).json({ success: true, message: 'Snap marked opened' });
          }
          return res.status(200).json({ success: true });
        }

        if (isUUID(finalSenderId) && isUUID(finalReceiverId)) {
          const contentToSave = typeof body.text === 'string' ? body.text : JSON.stringify(body.text || body.content);
          await supabaseAdmin.from('messages').insert({
            sender_id: finalSenderId,
            receiver_id: finalReceiverId,
            content: contentToSave,
            created_at: new Date().toISOString()
          });
        }
      } catch (dbErr) {
        console.warn('Failed to insert message into Supabase:', dbErr);
      }
    }

    let newMsg = null;
    if (body.type === 'snap') {
      newMsg = {
        type: 'snap',
        sender: body.sender || 'me',
        status: body.status || 'delivered',
        id: body.id || body.snapId || `snap_${Date.now()}`,
        title: body.title || 'Snap Photo',
        content: body.content || 'Snap photo attachment 📸',
        image: body.image || null,
        time: nowTime,
        sentAt: now,
        expiresAt: now + TWELVE_HOURS_MS,
        replyTo: body.replyTo || null
      };
    } else if (body.type === 'voicenote') {
      newMsg = {
        type: 'voicenote',
        sender: body.sender || 'me',
        duration: body.duration || '0:03',
        audio: body.audio || null,
        time: nowTime,
        sentAt: now,
        replyTo: body.replyTo || null
      };
    } else {
      newMsg = {
        type: 'text',
        sender: body.sender || 'me',
        text: body.text || '',
        time: nowTime,
        sentAt: now,
        replyTo: body.replyTo || null
      };
    }

    MESSAGES_DB[chatId].push(newMsg);

    return res.status(201).json({
      success: true,
      message: 'Message dispatched successfully',
      dispatched: newMsg
    });
  }

  return res.status(405).json({ success: false, error: 'Method not allowed' });
};
