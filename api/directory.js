// Serverless Directory Finder Endpoint for Vercel (/api/directory)
// Searches real registered accounts in Supabase
const { supabaseAdmin } = require("./supabase");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const query = (req.query.q || req.query.query || "").trim().toLowerCase();

  try {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers();
    if (error) return res.status(500).json({ success: false, error: error.message });

    const realAccounts = (data.users || []).map(u => ({
      id: u.id,
      name: u.user_metadata?.full_name || u.user_metadata?.username || u.email.split("@")[0],
      handle: u.user_metadata?.username || u.email.split("@")[0],
      avatar: u.user_metadata?.avatar || "👤",
      campus: u.user_metadata?.campus || "Verified Account",
      badge: "Supabase Verified irl"
    }));

    let results = realAccounts;
    if (query) {
      results = realAccounts.filter(u =>
        u.name.toLowerCase().includes(query) ||
        u.handle.toLowerCase().includes(query) ||
        u.campus.toLowerCase().includes(query)
      );
    }

    return res.status(200).json({
      success: true,
      source: "supabase",
      total: results.length,
      query: query,
      results: results
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};
