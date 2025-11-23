export default function handler(req, res) {

    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method === 'POST') {
        try {
            const { nickname } = req.body;

            if (!nickname || nickname.toLowerCase() !== 'mefisto') {
                return res.status(403).json({
                    success: false,
                    error: 'Test notifications are only available for mefisto'
                });
            }

            res.status(200).json({
                success: true,
                message: 'Test notification triggered',
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            console.error('Error in test-notification API:', error);
            res.status(500).json({
                success: false,
                error: 'Internal server error'
            });
        }
    } else {
        res.status(405).json({
            success: false,
            error: 'Method not allowed'
        });
    }
}