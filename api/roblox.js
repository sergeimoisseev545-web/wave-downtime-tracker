export default async function handler(req, res) {

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {

    const response = await fetch('https://weao.xyz/api/versions/current', {
      headers: {
        'User-Agent': 'WEAO-3PService'
      }
    });

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const data = await response.json();

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.status(200).json(data);
  } catch (error) {
    console.error('Error fetching Roblox version:', error);
    res.status(500).json({ error: error.message });
  }
}