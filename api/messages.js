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
      text: "Hey! I'm My AI, your Snapchat personal companion. Ask me anything or send me snaps!",
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

  // GET: Fetch messages for chat
  if (req.method === 'GET') {
    const chatId = (req.query.chatId || 'myai').toLowerCase();
    const senderId = req.query.senderId;
    const receiverId = req.query.receiverId;

    if (senderId && receiverId) {
      try {
        const { data: dbMsgs } = await supabaseAdmin
          .from('messages')
          .select('id, sender_id, receiver_id, content, created_at')
          .or(`and(sender_id.eq.${senderId},receiver_id.eq.${receiverId}),and(sender_id.eq.${receiverId},receiver_id.eq.${senderId})`)
          .order('created_at', { ascending: true });

        if (dbMsgs && dbMsgs.length > 0) {
          const formatted = dbMsgs.map(m => {
            const isMe = m.sender_id === senderId;
            let textVal = m.content;

            if (typeof m.content === 'string') {
              if (m.content.startsWith('{"type":"snap"')) {
                try {
                  const snapObj = JSON.parse(m.content);
                  return {
                    id: m.id,
                    sender_id: m.sender_id,
                    type: 'snap',
                    sender: isMe ? 'me' : 'friend',
                    status: isMe ? 'opened' : (snapObj.status || 'unread'),
                    title: snapObj.title || 'Camera Snap 📸',
                    content: snapObj.content || 'Photo snapped from web camera view!',
                    image: snapObj.image || null,
                    time: new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
                    sentAt: snapObj.sentAt || new Date(m.created_at).getTime(),
                    expiresAt: snapObj.expiresAt || (new Date(m.created_at).getTime() + TWELVE_HOURS_MS)
                  };
                } catch (e) {}
              } else if (m.content.startsWith('{"type":"image"')) {
                try {
                  const imgObj = JSON.parse(m.content);
                  return {
                    id: m.id,
                    sender_id: m.sender_id,
                    type: 'image',
                    sender: isMe ? 'me' : 'friend',
                    image: imgObj.image || null,
                    text: imgObj.text || 'Photo',
                    time: new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
                  };
                } catch (e) {}
              } else if (m.content.startsWith('{"type":"voicenote"')) {
                try {
                  const vnObj = JSON.parse(m.content);
                  return {
                    id: m.id,
                    sender_id: m.sender_id,
                    type: 'voicenote',
                    sender: isMe ? 'me' : 'friend',
                    audio: vnObj.audio || null,
                    duration: vnObj.duration || '0:03',
                    time: new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
                  };
                } catch (e) {}
              }
            }

            return {
              id: m.id,
              sender_id: m.sender_id,
              type: 'text',
              sender: isMe ? 'me' : 'friend',
              text: textVal,
              time: new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
            };
          });
          return res.status(200).json({ success: true, chatId: chatId, messages: formatted });
        } else {
          // If query returned 0 rows, return empty array so user never sees fake messages
          return res.status(200).json({ success: true, chatId: chatId, messages: [] });
        }
      } catch (err) {
        console.warn('Supabase messages query fallback:', err);
        return res.status(200).json({ success: true, chatId: chatId, messages: [] });
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
    if (body.senderId && body.receiverId && body.text) {
      try {
        const isUUID = (str) => typeof str === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
        let finalSenderId = body.senderId;
        let finalReceiverId = body.receiverId;

        if (!isUUID(finalSenderId) || !isUUID(finalReceiverId)) {
          const { data: listU } = await supabaseAdmin.auth.admin.listUsers();
          const allUsers = listU?.users || [];
          
          if (!isUUID(finalSenderId)) {
            const matchS = allUsers.find(u =>
              (u.user_metadata?.username && u.user_metadata.username.toLowerCase() === String(finalSenderId).toLowerCase()) ||
              (u.email && u.email.toLowerCase().startsWith(String(finalSenderId).toLowerCase() + '@')) ||
              (u.user_metadata?.full_name && u.user_metadata.full_name.toLowerCase() === String(finalSenderId).toLowerCase())
            );
            if (matchS) finalSenderId = matchS.id;
          }

          if (!isUUID(finalReceiverId)) {
            const matchR = allUsers.find(u =>
              (u.user_metadata?.username && u.user_metadata.username.toLowerCase() === String(finalReceiverId).toLowerCase()) ||
              (u.email && u.email.toLowerCase().startsWith(String(finalReceiverId).toLowerCase() + '@')) ||
              (u.user_metadata?.full_name && u.user_metadata.full_name.toLowerCase() === String(finalReceiverId).toLowerCase())
            );
            if (matchR) finalReceiverId = matchR.id;
          }
        }

        if (isUUID(finalSenderId) && isUUID(finalReceiverId)) {
          await supabaseAdmin.from('messages').insert({
            sender_id: finalSenderId,
            receiver_id: finalReceiverId,
            content: body.text,
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
        status: body.status || 'opened',
        id: body.id || `snap_${Date.now()}`,
        title: body.title || 'Snap Photo',
        content: body.content || 'Snap photo attachment 📸',
        time: nowTime,
        sentAt: now,
        expiresAt: now + TWELVE_HOURS_MS
      };
    } else if (body.type === 'voicenote') {
      newMsg = {
        type: 'voicenote',
        sender: 'me',
        duration: body.duration || '0:03',
        time: nowTime
      };
    } else {
      newMsg = {
        type: 'text',
        sender: body.sender || 'me',
        text: body.text || '',
        time: nowTime
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
