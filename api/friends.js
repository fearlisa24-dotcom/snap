// Serverless Friends Endpoint for Vercel (/api/friends)
// Allows adding real friends irl and syncing with Supabase user_metadata
const { supabaseAdmin } = require("./supabase");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch (e) {}
    }
    body = body || {};

    const action = body.action || req.query.action || "get";
    const userId = body.userId || req.query.userId || "";
    const currentUsername = (body.currentUsername || req.query.username || "lo_writer").toLowerCase();

    // ─────────────────────────────────────────────────────────────
    // 1. SUPABASE 'friendships' TABLE DIRECT HANDLERS (Admin Key)
    // ─────────────────────────────────────────────────────────────

    // 1A. List pending friend requests for a user
    if (action === "list_pending" || action === "pending") {
      const targetId = userId || req.query.receiverId;
      const targetUsername = (body.username || req.query.username || currentUsername || "").toLowerCase();

      const { data: listU } = await supabaseAdmin.auth.admin.listUsers();
      const allUsers = listU?.users || [];
      const matchingIds = allUsers
        .filter(u => (targetId && u.id === targetId) || (targetUsername && (u.user_metadata?.username || "").toLowerCase() === targetUsername || u.email.toLowerCase().startsWith(targetUsername + "@")))
        .map(u => u.id);
      if (targetId && !matchingIds.includes(targetId)) matchingIds.push(targetId);

      if (matchingIds.length === 0) {
        return res.status(200).json({ success: true, pendingRequests: [] });
      }

      const { data, error } = await supabaseAdmin
        .from("friendships")
        .select("id, sender_id, receiver_id, status, created_at, updated_at")
        .in("receiver_id", matchingIds)
        .eq("status", "pending");

      if (error) {
        return res.status(500).json({ success: false, error: error.message });
      }

      return res.status(200).json({ success: true, pendingRequests: data || [] });
    }

    // 1B. Send friend request (insert pending row into 'friendships')
    if (action === "send_request") {
      const senderId = body.senderId;
      const receiverId = body.receiverId;
      if (!senderId || !receiverId) {
        return res.status(400).json({ success: false, error: "senderId and receiverId required" });
      }

      const { data: existing } = await supabaseAdmin
        .from("friendships")
        .select("id, status")
        .or(`and(sender_id.eq.${senderId},receiver_id.eq.${receiverId}),and(sender_id.eq.${receiverId},receiver_id.eq.${senderId})`);

      if (existing && existing.length > 0) {
        return res.status(200).json({ success: true, friendship: existing[0], existing: true });
      }

      const { data, error } = await supabaseAdmin
        .from("friendships")
        .insert({
          sender_id: senderId,
          receiver_id: receiverId,
          status: "pending",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .select();

      if (error) {
        return res.status(500).json({ success: false, error: error.message });
      }

      return res.status(200).json({ success: true, friendship: data?.[0] || null });
    }

    // 1C. Accept friend request (update row status to 'accepted')
    if (action === "accept_request") {
      const friendshipId = body.friendshipId;
      if (!friendshipId) {
        return res.status(400).json({ success: false, error: "friendshipId required" });
      }

      const { data, error } = await supabaseAdmin
        .from("friendships")
        .update({
          status: "accepted",
          updated_at: new Date().toISOString()
        })
        .eq("id", friendshipId)
        .select();

      if (error) {
        return res.status(500).json({ success: false, error: error.message });
      }

      return res.status(200).json({ success: true, friendship: data?.[0] || null });
    }

    // 1D. Get all friendships for a user (accepted + pending)
    if (action === "get_friendships" || action === "friendships") {
      const targetId = userId || body.senderId || req.query.receiverId;
      const targetUsername = (body.username || req.query.username || currentUsername || "").toLowerCase();

      const { data: listU } = await supabaseAdmin.auth.admin.listUsers();
      const allUsers = listU?.users || [];
      const matchingIds = allUsers
        .filter(u => (targetId && u.id === targetId) || (targetUsername && (u.user_metadata?.username || "").toLowerCase() === targetUsername || u.email.toLowerCase().startsWith(targetUsername + "@")))
        .map(u => u.id);
      if (targetId && !matchingIds.includes(targetId)) matchingIds.push(targetId);

      if (matchingIds.length === 0) {
        return res.status(200).json({ success: true, friendships: [] });
      }

      const orClause = matchingIds.map(id => `sender_id.eq.${id},receiver_id.eq.${id}`).join(',');

      const { data, error } = await supabaseAdmin
        .from("friendships")
        .select("id, sender_id, receiver_id, status, created_at, updated_at")
        .or(orClause);

      if (error) {
        return res.status(500).json({ success: false, error: error.message });
      }

      return res.status(200).json({ success: true, friendships: data || [] });
    }

    // ─────────────────────────────────────────────────────────────
    // 2. USER METADATA FRIENDS LIST (Legacy & Profile Integration)
    // ─────────────────────────────────────────────────────────────
    const { data: usersData, error: listError } = await supabaseAdmin.auth.admin.listUsers();
    if (listError) return res.status(500).json({ success: false, error: listError.message });

    const currentUser = (usersData.users || []).find(u =>
      (u.user_metadata?.username || "").toLowerCase() === currentUsername ||
      u.email.toLowerCase().startsWith(currentUsername + "@")
    );

    if (!currentUser) {
      return res.status(404).json({ success: false, error: "Current user not found in Supabase" });
    }

    const currentMeta = currentUser.user_metadata || {};
    const friendsList = currentMeta.friends || [];

    // 1. Get real friends list
    if (action === "get" || req.method === "GET") {
      return res.status(200).json({
        success: true,
        source: "supabase",
        user: currentUsername,
        friends: friendsList
      });
    }

    // 2. Add real friend IRL
    if (action === "add") {
      const friendHandle = (body.friendHandle || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
      if (!friendHandle) return res.status(400).json({ success: false, error: "Friend handle is required" });

      const targetFriendUser = (usersData.users || []).find(u =>
        (u.user_metadata?.username || "").toLowerCase() === friendHandle ||
        u.email.toLowerCase().startsWith(friendHandle + "@")
      );

      const newFriendObj = {
        id: targetFriendUser ? targetFriendUser.id : ("friend_" + friendHandle),
        username: friendHandle,
        fullName: targetFriendUser ? (targetFriendUser.user_metadata?.full_name || friendHandle) : (body.friendName || friendHandle),
        avatar: targetFriendUser ? (targetFriendUser.user_metadata?.avatar || "👤") : (body.friendAvatar || "👤"),
        campus: targetFriendUser ? (targetFriendUser.user_metadata?.campus || "Real Friend irl") : "Real Friend irl",
        score: targetFriendUser ? (targetFriendUser.user_metadata?.score || "1,200") : "1,200",
        addedAt: new Date().toISOString()
      };

      const exists = friendsList.some(f => f.username.toLowerCase() === friendHandle);
      if (!exists) {
        friendsList.push(newFriendObj);
        await supabaseAdmin.auth.admin.updateUserById(currentUser.id, {
          user_metadata: {
            ...currentMeta,
            friends: friendsList
          }
        });
      }

      return res.status(200).json({
        success: true,
        source: "supabase",
        message: "Added @" + friendHandle + " to your real Supabase friend list!",
        friend: newFriendObj,
        totalFriends: friendsList.length
      });
    }

    return res.status(400).json({ success: false, error: "Unknown action" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};
