require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.post('/api/appraise', async (req, res) => {
  const { handle } = req.body;
  if (!handle) return res.status(400).json({ error: 'Handle is required' });

  const sociavaultKey = process.env.SOCIAVAULT_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!sociavaultKey) return res.status(500).json({ error: 'SOCIAVAULT_API_KEY not configured' });
  if (!geminiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  try {
    // ── Step 1: Fetch real profile from SociaVault ──────────────────────────
    const profileRes = await fetch(
      `https://api.sociavault.com/v1/scrape/twitter/profile?handle=${encodeURIComponent(handle)}`,
      { headers: { 'x-api-key': sociavaultKey } }
    );
    const profileData = await profileRes.json();

    if (!profileRes.ok || !profileData.success || !profileData.data) {
      return res.status(404).json({ error: profileData.message || 'User not found' });
    }

    const u = profileData.data;
    const raw = u.legacy || u;

    const followers    = raw.followers_count || raw.fast_followers_count || u.followers_count || u.followers || 0;
    const following    = raw.friends_count || u.friends_count || u.following || 0;
    const tweetCount   = raw.statuses_count || u.statuses_count || u.tweet_count || u.tweets || 0;
    const isVerified   = !!(u.is_blue_verified || raw.verified || u.verified || u.is_verified);
    const profileImage = raw.profile_image_url_https || u.profile_image_url_https || u.profile_image?.image_url || u.profile_image || u.avatar || null;
    const headerImage  = raw.profile_banner_url || u.profile_banner_url || u.header_image || null;
    const name         = raw.name || u.name || handle;
    const bio          = raw.description || u.description || u.bio || '';
    const createdAt    = raw.created_at || u.core?.created_at || u.created_at || null;

    // ── Step 2: Fetch recent tweets for engagement ───────────────────────────
    let allTweets = [];
    try {
      const tweetsRes = await fetch(
        `https://api.sociavault.com/v1/scrape/twitter/user-tweets?handle=${encodeURIComponent(handle)}&limit=50`,
        { headers: { 'x-api-key': sociavaultKey } }
      );
      const tweetsData = await tweetsRes.json();
      if (tweetsData.success && tweetsData.data) {
        let rawTweets = tweetsData.data;
        if (rawTweets.tweets) rawTweets = rawTweets.tweets;
        if (Array.isArray(rawTweets)) {
          allTweets = rawTweets;
        } else if (typeof rawTweets === 'object' && rawTweets !== null) {
          allTweets = Object.values(rawTweets).filter(v => typeof v === 'object' && v !== null && (v.legacy || v.rest_id));
        }
      }
    } catch (e) {
      console.log('Tweets fetch failed:', e.message);
    }

    // ── Step 3: Calculate engagement stats ──────────────────────────────────
    const getTweetVal = (t, ...keys) => {
      const src = t.legacy || t;
      for (const k of keys) if (src[k] != null) return src[k];
      return 0;
    };
    const avg = (arr, ...keys) => {
      if (!arr.length) return 0;
      return Math.round(arr.reduce((s, t) => s + getTweetVal(t, ...keys), 0) / arr.length);
    };

    const avgLikes   = avg(allTweets, 'favorite_count', 'likes', 'like_count');
    const avgRt      = avg(allTweets, 'retweet_count', 'retweets');
    const avgReplies = avg(allTweets, 'reply_count', 'replies');
    const avgViews   = avg(allTweets, 'views_count', 'view_count', 'impressions');

    const engagementRate = followers > 0
      ? (((avgLikes + avgRt + avgReplies) / followers) * 100).toFixed(2)
      : '0.00';

    // ── Step 4: Ask Gemini to value the profile using real data ──────────────
    const prompt = `You are an expert social media brand asset valuator. Based on the following REAL data from an X (Twitter) profile, calculate the monetary value of their profile picture (pfp) and header/banner image as brand assets.

REAL PROFILE DATA:
- Handle: @${handle}
- Name: ${name}
- Followers: ${followers.toLocaleString()}
- Following: ${following.toLocaleString()}
- Total Tweets: ${tweetCount.toLocaleString()}
- Verified (X Premium): ${isVerified}
- Bio: ${bio || 'Not provided'}
- Account created: ${createdAt || 'Unknown'}
- Avg Likes per tweet: ${avgLikes}
- Avg Retweets per tweet: ${avgRt}
- Avg Replies per tweet: ${avgReplies}
- Avg Views per tweet: ${avgViews}
- Engagement Rate: ${engagementRate}%
- Has profile picture: ${profileImage ? 'Yes' : 'No'}
- Has header/banner: ${headerImage ? 'Yes' : 'No'}

Based on this real data, return ONLY a valid JSON object:
{
  "niche": "1-3 word niche based on bio and handle e.g. Web3 KOL, Crypto Trader, Tech CEO",
  "tier": "one of: Nano, Micro, Mid-tier, Macro, Mega, Icon",
  "pfpValue": <integer USD — value of pfp as a brand asset>,
  "headerValue": <integer USD — value of header/banner as a brand asset>,
  "pfpNote": "1 sentence explaining pfp value based on their real stats",
  "headerNote": "1 sentence explaining header value based on their real stats",
  "factors": [
    {"name":"Follower count","value":"short value","direction":"up|down|neutral"},
    {"name":"Engagement rate","value":"short value","direction":"up|down|neutral"},
    {"name":"Verified status","value":"short value","direction":"up|down|neutral"},
    {"name":"Niche premium","value":"short value","direction":"up|down|neutral"},
    {"name":"Brand consistency","value":"short value","direction":"up|down|neutral"}
  ],
  "verdict": "2 sentences — genuine insight about their profile's brand value and growth potential based on their real engagement data."
}

Valuation rules based on followers:
- Under 1K followers: pfp $5-50, header $2-20
- 1K-10K (Nano): pfp $50-500, header $20-200
- 10K-100K (Micro): pfp $500-5K, header $200-2K
- 100K-500K (Mid-tier): pfp $5K-20K, header $2K-8K
- 500K-2M (Macro): pfp $20K-100K, header $8K-40K
- 2M-10M (Mega): pfp $100K-500K, header $40K-200K
- 10M+ (Icon): pfp $500K+, header $200K+

Adjust UP for: high engagement rate (above 2%), verified status, premium niche (Web3/crypto/tech/finance), consistent posting.
Adjust DOWN for: low engagement (below 0.5%), no verification, generic niche, irregular posting.

Return ONLY the JSON object, no markdown, no explanation.`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.5, maxOutputTokens: 1000 }
        })
      }
    );

    if (!geminiRes.ok) {
      const err = await geminiRes.text();
      console.error('Gemini error:', err);
      return res.status(502).json({ error: 'Valuation engine error' });
    }

    const geminiData = await geminiRes.json();
    const geminiText = geminiData.candidates[0].content.parts[0].text
      .trim()
      .replace(/```json|```/g, '')
      .trim();

    const valuation = JSON.parse(geminiText);

    // ── Step 5: Return combined real + AI data ───────────────────────────────
    res.json({
      name,
      handle,
      profile_image: profileImage,
      header_image: headerImage,
      followers,
      following,
      tweet_count: tweetCount,
      is_verified: isVerified,
      avg_likes: avgLikes,
      avg_retweets: avgRt,
      avg_replies: avgReplies,
      avg_views: avgViews,
      engagement_rate: engagementRate,
      ...valuation
    });

  } catch (e) {
    console.error('Server error:', e);
    res.status(500).json({ error: 'Something went wrong: ' + e.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`PFP Appraiser running on port ${PORT}`));
