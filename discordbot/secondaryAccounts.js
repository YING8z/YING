const { Client } = require('discord.js-selfbot-v13');

const secondaryClients = [];

function parseTokenList(raw) {
    if (!raw) return [];
    return raw
        .split(/[\n,;]+/g)
        .map(t => t.trim())
        .filter(Boolean);
}

function getSecondaryTokens() {
    const fromList = parseTokenList(
        process.env.SECONDARY_TOKENS ||
        process.env.EXTRA_STREAM_TOKENS ||
        ''
    );

    const fromIndexed = Object.keys(process.env)
        .filter(k => /^SECONDARY_TOKEN_\d+$/i.test(k) || /^EXTRA_STREAM_TOKEN_\d+$/i.test(k))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map(k => (process.env[k] || '').trim())
        .filter(Boolean);

    return [...new Set([...fromList, ...fromIndexed])];
}

async function startSecondaryAccounts() {
    const tokens = getSecondaryTokens();
    if (!tokens.length) {
        console.log('[SECONDARY] Không có token phụ trong .env (SECONDARY_TOKENS / SECONDARY_TOKEN_1...)');
        return;
    }

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const id = i + 1;
        const client = new Client({ checkUpdate: false });
        secondaryClients.push(client);

        try {
            await client.login(token);
            console.log(`[SECONDARY] #${id} ready: ${client.user?.tag || 'Unknown user'}`);
        } catch (err) {
            console.error(`[SECONDARY] #${id} login lỗi:`, err?.message || err);
        }
    }
}

module.exports = (mainClient) => {
    mainClient.once('ready', () => {
        startSecondaryAccounts().catch(err => {
            console.error('[SECONDARY] Lỗi khởi tạo account phụ:', err?.message || err);
        });
    });
};

