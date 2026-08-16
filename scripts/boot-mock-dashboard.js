// Local dashboard boot with an in-memory mock DB (no Postgres needed).
// Used only for manual testing of dashboard pages/APIs. Not part of the app.
//
// We intercept Node's require to swap dashboard/db, dashboard/discord, and
// dashboard/auth for in-memory mocks, then require dashboard/server.js (which
// registers all routes on its Express app and exports it).
const path = require('path');
const Module = require('module');

const DASH = path.join(__dirname, '..', 'dashboard');

const mockDb = {
    getPlatformStats: async (count) => ({ servers: count ?? 5, botName: 'PrimeBot', botVersion: '2.10.0', features: { leveling:{count:0,percent:0}, welcome:{count:0,percent:0}, autoReactions:{count:0,percent:0}, broadcasts:{count:0,percent:0}, automod:{count:0,percent:0} } }),
    getNodeStats: async () => ({ nodes: [{role:'sn1',nodeName:null,active:false,lastHeartbeat:null,ageMs:null,status:'never'},{role:'sn2',nodeName:null,active:false,lastHeartbeat:null,ageMs:null,status:'never'},{role:'sn3',nodeName:null,active:false,lastHeartbeat:null,ageMs:null,status:'never'}], lease: null, thresholdMs: 45000 }),
    getLivePolls: async () => [{ pollId:'p1', passCode:'ABCD', question:'Best bot?', isActive:true, totalVotes:3, channelId:'111-ch1' }],
    getLiveGiveaways: async () => [{ giveawayId:'g1', passCode:'WXYZ', prize:'Nitro', isActive:true, ended:false, entries:5, channelId:'111-ch1' }],
    getEndedLivePolls: async () => [],
    getEndedLiveGiveaways: async () => [],
    getGuildConfig: async () => ({ server:{}, welcome:{}, leveling:{} }),
    getServerSettings: async () => ({}),
    upsertServerSettings: async (gid, patch) => patch,
};

const mockDiscord = {
    getBotSelf: async () => ({ id:'999', username:'PrimeBot' }),
    getBotGuildCount: async () => 5,
    getBotGuild: async (id) => ({ id, name:'Test Guild', approximate_member_count: 42 }),
    getGuildChannels: async (id) => [{ id:'111-ch1', name:'general', type:0 }, { id:'111-ch2', name:'bot', type:0 }],
    getGuildRoles: async () => [],
};

const mockAuth = {
    requireAuth: (req, res, next) => {
        req.user = { id:'t', username:'Tester', globalName:'Tester' };
        if (!req.session || typeof req.session.touch !== 'function') {
            req.session = { accessToken:'x', user: req.user, touch(){}, save(cb){ cb?.(); }, regenerate(cb){ cb?.(); }, destroy(cb){ cb?.(); } };
        } else {
            req.session.accessToken = 'x';
            req.session.user = req.user;
        }
        next();
    },
    requireGuildAdmin: (req, res, next) => {
        req.guild = { id: req.params.guildId, name:'Test Guild', approximate_member_count: 42, _channels:[{id:'111-ch1',name:'general',type:0}], _roles:[], _config:{ server:{}, welcome:{}, leveling:{} } };
        next();
    },
    requireGuildAdminPage: (req, res, next) => {
        req.guild = { id: req.params.guildId, name:'Test Guild', approximate_member_count: 42, _channels:[{id:'111-ch1',name:'general',type:0}], _roles:[], _config:{ server:{}, welcome:{}, leveling:{} } };
        next();
    },
};

const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === './db' && parent && parent.filename && parent.filename.startsWith(DASH + path.sep + 'server.js')) return mockDb;
    if (request === './discord' && parent && parent.filename && parent.filename.startsWith(DASH + path.sep + 'server.js')) return mockDiscord;
    if (request === './auth' && parent && parent.filename && parent.filename.startsWith(DASH + path.sep + 'server.js')) return mockAuth;
    return origLoad.apply(this, arguments);
};

process.env.PORT = process.env.PORT || '3000';
process.env.BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret';

const app = require('../dashboard/server');
if (require.main === module) {
    const PORT = process.env.PORT;
    app.listen(PORT, () => console.log(`Mock dashboard on http://localhost:${PORT}`));
}

